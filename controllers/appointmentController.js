const db     = require('../config/db');
const moment = require('moment');

// ── Get available doctors ─────────────────────────────────
const getDoctors = async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT d.id, u.name, d.specialization, d.qualification,
             d.experience_yrs, d.avg_consult_min, d.is_available, d.room_number
      FROM doctors d JOIN users u ON d.user_id = u.id
      WHERE u.is_active = 1
    `);
    res.json({ success: true, doctors: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ── Get available time slots for a doctor on a date ───────
const getAvailableSlots = async (req, res) => {
  try {
    const { doctor_id, date } = req.query;
    if (!doctor_id || !date) {
      return res.status(400).json({ success: false, message: 'doctor_id and date are required.' });
    }

    // Get doctor's avg consultation time
    const [docRows] = await db.query('SELECT avg_consult_min FROM doctors WHERE id = ?', [doctor_id]);
    if (!docRows.length) return res.status(404).json({ success: false, message: 'Doctor not found.' });

    const avgMin = docRows[0].avg_consult_min || 15;
    const startHour = 9, endHour = 18;
    const allSlots = [];

    // Generate slots
    let current = moment(`${date} ${startHour}:00`, 'YYYY-MM-DD HH:mm');
    const end   = moment(`${date} ${endHour}:00`, 'YYYY-MM-DD HH:mm');

    while (current.isBefore(end)) {
      allSlots.push(current.format('HH:mm'));
      current.add(avgMin, 'minutes');
    }

    // Get already booked slots
    const [booked] = await db.query(
      `SELECT TIME_FORMAT(time_slot, '%H:%i') AS slot
       FROM appointments
       WHERE doctor_id = ? AND appointment_date = ?
         AND status NOT IN ('cancelled','no_show')`,
      [doctor_id, date]
    );
    const bookedSlots = booked.map(r => r.slot);

    const slots = allSlots.map(slot => ({
      time:      slot,
      available: !bookedSlots.includes(slot)
    }));

    res.json({ success: true, slots, avg_consult_min: avgMin });
  } catch (err) {
    console.error('Get slots error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ── Book appointment ──────────────────────────────────────
const bookAppointment = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const { doctor_id, appointment_date, time_slot, symptoms, family_member_id } = req.body;
    const patient_id = req.user.id;

    // Check if slot still available
    const [existing] = await conn.query(
      `SELECT id FROM appointments
       WHERE doctor_id=? AND appointment_date=? AND time_slot=?
         AND status NOT IN ('cancelled','no_show')`,
      [doctor_id, appointment_date, time_slot]
    );
    if (existing.length) {
      await conn.rollback();
      return res.status(409).json({ success: false, message: 'This slot is already booked. Please choose another.' });
    }

    // Generate token number (count of appointments on that day for that doctor + 1)
    const [countRows] = await conn.query(
      `SELECT COUNT(*) AS cnt FROM appointments
       WHERE doctor_id=? AND appointment_date=? AND status NOT IN ('cancelled','no_show')`,
      [doctor_id, appointment_date]
    );
    const token_number = countRows[0].cnt + 1;

    // Calculate estimated wait
    const [docRows] = await conn.query('SELECT avg_consult_min FROM doctors WHERE id=?', [doctor_id]);
    const avgMin = docRows[0].avg_consult_min || 15;
    const estimated_wait = (token_number - 1) * avgMin;

    // Insert appointment
    const [result] = await conn.query(
      `INSERT INTO appointments
         (patient_id, doctor_id, family_member_id, appointment_date, time_slot,
          token_number, status, symptoms, estimated_wait)
       VALUES (?,?,?,?,?,?,'scheduled',?,?)`,
      [patient_id, doctor_id, family_member_id || null, appointment_date, time_slot,
       token_number, symptoms || null, estimated_wait]
    );

    // Add to queue
    const [queueCount] = await conn.query(
      'SELECT COUNT(*) AS cnt FROM queue WHERE doctor_id=? AND queue_date=?',
      [doctor_id, appointment_date]
    );
    await conn.query(
      'INSERT INTO queue (appointment_id, doctor_id, queue_date, queue_position) VALUES (?,?,?,?)',
      [result.insertId, doctor_id, appointment_date, queueCount[0].cnt + 1]
    );

    // Notification
    await conn.query(
      `INSERT INTO notifications (user_id, title, message, type)
       VALUES (?, 'Appointment Confirmed', ?, 'appointment')`,
      [patient_id, `Your appointment on ${appointment_date} at ${time_slot} is confirmed. Token #${token_number}`]
    );

    await conn.commit();

    res.status(201).json({
      success: true,
      message: 'Appointment booked successfully!',
      appointment: {
        id: result.insertId,
        token_number,
        estimated_wait,
        date: appointment_date,
        time: time_slot
      }
    });
  } catch (err) {
    await conn.rollback();
    console.error('Book appointment error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  } finally {
    conn.release();
  }
};

// ── Get patient's appointments ────────────────────────────
const getMyAppointments = async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT a.*, u.name AS doctor_name, d.specialization, d.room_number,
             fm.name AS family_member_name,
             q.queue_position, q.status AS queue_status
      FROM appointments a
      JOIN doctors d ON a.doctor_id = d.id
      JOIN users u   ON d.user_id   = u.id
      LEFT JOIN family_members fm ON a.family_member_id = fm.id
      LEFT JOIN queue q ON a.id = q.appointment_id
      WHERE a.patient_id = ?
      ORDER BY a.appointment_date DESC, a.time_slot DESC
    `, [req.user.id]);

    res.json({ success: true, appointments: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ── Get single appointment ────────────────────────────────
const getAppointment = async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT a.*, u.name AS doctor_name, d.specialization, d.room_number,
             q.queue_position, q.status AS queue_status
      FROM appointments a
      JOIN doctors d ON a.doctor_id = d.id
      JOIN users u   ON d.user_id   = u.id
      LEFT JOIN queue q ON a.id = q.appointment_id
      WHERE a.id = ? AND a.patient_id = ?
    `, [req.params.id, req.user.id]);

    if (!rows.length) return res.status(404).json({ success: false, message: 'Appointment not found.' });

    // Recalculate live waiting estimate
    const appt = rows[0];
    const [ahead] = await db.query(
      `SELECT COUNT(*) AS cnt FROM queue
       WHERE doctor_id=? AND queue_date=? AND queue_position < ? AND status='waiting'`,
      [appt.doctor_id, appt.appointment_date, appt.queue_position]
    );
    const [docRows] = await db.query('SELECT avg_consult_min FROM doctors WHERE id=?', [appt.doctor_id]);
    appt.live_wait_minutes = ahead[0].cnt * (docRows[0]?.avg_consult_min || 15);

    res.json({ success: true, appointment: appt });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ── Cancel appointment ────────────────────────────────────
const cancelAppointment = async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, status FROM appointments WHERE id=? AND patient_id=?',
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Appointment not found.' });
    if (['completed','in_consultation'].includes(rows[0].status)) {
      return res.status(400).json({ success: false, message: 'Cannot cancel this appointment.' });
    }

    await db.query('UPDATE appointments SET status="cancelled" WHERE id=?', [req.params.id]);
    await db.query('UPDATE queue SET status="skipped" WHERE appointment_id=?', [req.params.id]);

    res.json({ success: true, message: 'Appointment cancelled.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ── Reschedule appointment ────────────────────────────────
const rescheduleAppointment = async (req, res) => {
  try {
    const { appointment_date, time_slot } = req.body;
    const [rows] = await db.query(
      'SELECT id, doctor_id FROM appointments WHERE id=? AND patient_id=?',
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Appointment not found.' });

    // Check new slot
    const [conflict] = await db.query(
      `SELECT id FROM appointments WHERE doctor_id=? AND appointment_date=? AND time_slot=?
         AND status NOT IN ('cancelled','no_show') AND id != ?`,
      [rows[0].doctor_id, appointment_date, time_slot, req.params.id]
    );
    if (conflict.length) return res.status(409).json({ success: false, message: 'Slot not available.' });

    await db.query(
      'UPDATE appointments SET appointment_date=?, time_slot=?, status="scheduled" WHERE id=?',
      [appointment_date, time_slot, req.params.id]
    );

    res.json({ success: true, message: 'Appointment rescheduled successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ── Get queue position (live) ─────────────────────────────
const getQueuePosition = async (req, res) => {
  try {
    const { appointment_id } = req.params;
    const [rows] = await db.query(`
      SELECT q.*, a.token_number, a.appointment_date, a.estimated_wait,
             u.name AS doctor_name, d.avg_consult_min
      FROM queue q
      JOIN appointments a ON q.appointment_id = a.id
      JOIN doctors d ON q.doctor_id = d.id
      JOIN users u ON d.user_id = u.id
      WHERE q.appointment_id = ?
    `, [appointment_id]);

    if (!rows.length) return res.status(404).json({ success: false, message: 'Queue entry not found.' });

    const qEntry = rows[0];
    const [ahead] = await db.query(
      `SELECT COUNT(*) AS cnt FROM queue
       WHERE doctor_id=? AND queue_date=? AND queue_position < ? AND status='waiting'`,
      [qEntry.doctor_id, qEntry.queue_date, qEntry.queue_position]
    );

    const liveWait = ahead[0].cnt * qEntry.avg_consult_min;

    res.json({
      success:       true,
      queue_position: qEntry.queue_position,
      patients_ahead: ahead[0].cnt,
      status:         qEntry.status,
      live_wait_min:  liveWait,
      token_number:   qEntry.token_number,
      doctor_name:    qEntry.doctor_name
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

module.exports = {
  getDoctors, getAvailableSlots, bookAppointment,
  getMyAppointments, getAppointment, cancelAppointment,
  rescheduleAppointment, getQueuePosition
};
