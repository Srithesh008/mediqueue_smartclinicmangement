const db     = require('../config/db');
const moment = require('moment');

// ── Get doctor's profile ──────────────────────────────────
const getDoctorProfile = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT d.*, u.name, u.email, u.phone, u.gender
       FROM doctors d JOIN users u ON d.user_id=u.id
       WHERE d.user_id=?`, [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Doctor profile not found.' });
    res.json({ success: true, doctor: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ── Get today's queue ─────────────────────────────────────
const getTodayQueue = async (req, res) => {
  try {
    const [docRows] = await db.query('SELECT id FROM doctors WHERE user_id=?', [req.user.id]);
    if (!docRows.length) return res.status(404).json({ success: false, message: 'Not a doctor.' });
    const doctor_id = docRows[0].id;
    const today = moment().format('YYYY-MM-DD');

    const [queue] = await db.query(`
      SELECT q.*, a.token_number, a.time_slot, a.symptoms, a.priority,
             u.name AS patient_name, u.phone AS patient_phone, u.gender,
             fm.name AS family_member_name, fm.relation
      FROM queue q
      JOIN appointments a ON q.appointment_id = a.id
      JOIN users u ON a.patient_id = u.id
      LEFT JOIN family_members fm ON a.family_member_id = fm.id
      WHERE q.doctor_id=? AND q.queue_date=?
      ORDER BY
        CASE a.priority WHEN 'emergency' THEN 1 WHEN 'urgent' THEN 2 ELSE 3 END,
        q.queue_position
    `, [doctor_id, today]);

    // Summary stats
    const [stats] = await db.query(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN q.status='waiting'         THEN 1 ELSE 0 END) AS waiting,
        SUM(CASE WHEN q.status='in_consultation' THEN 1 ELSE 0 END) AS in_consultation,
        SUM(CASE WHEN q.status='completed'       THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN q.status='skipped'         THEN 1 ELSE 0 END) AS skipped
      FROM queue q
      WHERE q.doctor_id=? AND q.queue_date=?
    `, [doctor_id, today]);

    res.json({ success: true, queue, stats: stats[0], today, doctor_id });
  } catch (err) {
    console.error('Get today queue error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ── Call next patient ─────────────────────────────────────
const callNext = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [docRows] = await conn.query('SELECT id FROM doctors WHERE user_id=?', [req.user.id]);
    const doctor_id = docRows[0].id;
    const today     = moment().format('YYYY-MM-DD');

    // Complete currently in_consultation (if any)
    const [current] = await conn.query(
      `SELECT q.id, q.appointment_id, a.patient_id FROM queue q
       JOIN appointments a ON q.appointment_id=a.id
       WHERE q.doctor_id=? AND q.queue_date=? AND q.status='in_consultation'`,
      [doctor_id, today]
    );
    if (current.length) {
      const { id: qId, appointment_id, patient_id } = current[0];
      await conn.query('UPDATE queue SET status="completed" WHERE id=?', [qId]);
      await conn.query('UPDATE appointments SET status="completed", actual_end=NOW() WHERE id=?', [appointment_id]);

      // Analytics
      const [apptRow] = await conn.query(
        'SELECT actual_start, actual_end FROM appointments WHERE id=?', [appointment_id]
      );
      if (apptRow[0]?.actual_start && apptRow[0]?.actual_end) {
        const duration = moment(apptRow[0].actual_end).diff(moment(apptRow[0].actual_start), 'minutes');
        await conn.query(
          'INSERT INTO consultation_analytics (appointment_id, doctor_id, actual_duration, date) VALUES (?,?,?,?)',
          [appointment_id, doctor_id, duration, today]
        );
        // Update doctor's rolling avg
        await conn.query(
          `UPDATE doctors SET avg_consult_min =
             ROUND((avg_consult_min * 0.8) + (? * 0.2)) WHERE id=?`,
          [duration, doctor_id]
        );
      }

      // Notify patient
      await conn.query(
        `INSERT INTO notifications (user_id, title, message, type) VALUES (?, 'Consultation Completed', 'Your consultation has ended. Thank you!', 'queue')`,
        [patient_id]
      );
    }

    // Find next waiting patient (emergency/urgent first)
    const [next] = await conn.query(`
      SELECT q.id AS queue_id, q.appointment_id, a.patient_id, a.token_number,
             u.name AS patient_name
      FROM queue q
      JOIN appointments a ON q.appointment_id=a.id
      JOIN users u ON a.patient_id=u.id
      WHERE q.doctor_id=? AND q.queue_date=? AND q.status='waiting'
      ORDER BY
        CASE a.priority WHEN 'emergency' THEN 1 WHEN 'urgent' THEN 2 ELSE 3 END,
        q.queue_position
      LIMIT 1
    `, [doctor_id, today]);

    if (!next.length) {
      await conn.commit();
      return res.json({ success: true, message: 'No more patients in queue.', next: null });
    }

    const patient = next[0];
    await conn.query('UPDATE queue SET status="in_consultation", called_at=NOW() WHERE id=?', [patient.queue_id]);
    await conn.query('UPDATE appointments SET status="in_consultation", actual_start=NOW() WHERE id=?', [patient.appointment_id]);
    await conn.query(
      `INSERT INTO notifications (user_id, title, message, type)
       VALUES (?, 'Your Turn!', 'Please proceed to the doctor. Token #${patient.token_number}', 'queue')`,
      [patient.patient_id]
    );

    // Recalculate estimated wait for all remaining waiting patients
    const [waiting] = await conn.query(
      `SELECT q.id, q.appointment_id FROM queue q
       WHERE q.doctor_id=? AND q.queue_date=? AND q.status='waiting'
       ORDER BY q.queue_position`, [doctor_id, today]
    );
    const [docInfo] = await conn.query('SELECT avg_consult_min FROM doctors WHERE id=?', [doctor_id]);
    const avgMin = docInfo[0].avg_consult_min;
    for (let i = 0; i < waiting.length; i++) {
      await conn.query('UPDATE appointments SET estimated_wait=? WHERE id=?',
        [(i + 1) * avgMin, waiting[i].appointment_id]
      );
    }

    await conn.commit();
    res.json({ success: true, message: `Calling ${patient.patient_name} (Token #${patient.token_number})`, next: patient });
  } catch (err) {
    await conn.rollback();
    console.error('Call next error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  } finally {
    conn.release();
  }
};

// ── Mark emergency ────────────────────────────────────────
const markEmergency = async (req, res) => {
  try {
    const { appointment_id } = req.body;
    await db.query('UPDATE appointments SET priority="emergency" WHERE id=?', [appointment_id]);

    // Move to top of queue (position 0.5 hack → will naturally float to top with ORDER BY)
    const [appt] = await db.query('SELECT patient_id FROM appointments WHERE id=?', [appointment_id]);
    await db.query(
      `INSERT INTO notifications (user_id, title, message, type)
       VALUES (?, 'Emergency Priority', 'You have been moved to emergency priority in the queue.', 'emergency')`,
      [appt[0].patient_id]
    );

    res.json({ success: true, message: 'Patient marked as emergency and moved to top.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ── Get analytics ─────────────────────────────────────────
const getAnalytics = async (req, res) => {
  try {
    const [docRows] = await db.query('SELECT id, avg_consult_min FROM doctors WHERE user_id=?', [req.user.id]);
    if (!docRows.length) return res.status(404).json({ success: false, message: 'Not a doctor.' });
    const doctor_id = docRows[0].id;

    // Last 7 days patient count
    const [daily] = await db.query(`
      SELECT appointment_date AS date, COUNT(*) AS patients,
             SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed
      FROM appointments
      WHERE doctor_id=? AND appointment_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
      GROUP BY appointment_date ORDER BY appointment_date
    `, [doctor_id]);

    // Avg consultation duration last 30 days
    const [avgStats] = await db.query(`
      SELECT ROUND(AVG(actual_duration), 1) AS avg_duration,
             MAX(actual_duration) AS max_duration,
             MIN(actual_duration) AS min_duration
      FROM consultation_analytics
      WHERE doctor_id=? AND date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
    `, [doctor_id]);

    // Today stats
    const today = moment().format('YYYY-MM-DD');
    const [todayStats] = await db.query(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status='waiting' OR status='in_consultation' THEN 1 ELSE 0 END) AS pending
      FROM appointments WHERE doctor_id=? AND appointment_date=?
    `, [doctor_id, today]);

    // Priority breakdown
    const [priorityStats] = await db.query(`
      SELECT priority, COUNT(*) AS cnt
      FROM appointments WHERE doctor_id=? AND appointment_date=?
      GROUP BY priority
    `, [doctor_id, today]);

    res.json({
      success: true,
      analytics: {
        daily_patients: daily,
        avg_duration:   avgStats[0],
        today:          todayStats[0],
        priority_breakdown: priorityStats,
        current_avg_min: docRows[0].avg_consult_min
      }
    });
  } catch (err) {
    console.error('Analytics error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ── Skip patient ──────────────────────────────────────────
const skipPatient = async (req, res) => {
  try {
    const { queue_id } = req.body;
    await db.query('UPDATE queue SET status="skipped" WHERE id=?', [queue_id]);
    await db.query(
      'UPDATE appointments SET status="no_show" WHERE id=(SELECT appointment_id FROM queue WHERE id=?)',
      [queue_id]
    );
    res.json({ success: true, message: 'Patient skipped.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

module.exports = { getDoctorProfile, getTodayQueue, callNext, markEmergency, getAnalytics, skipPatient };
