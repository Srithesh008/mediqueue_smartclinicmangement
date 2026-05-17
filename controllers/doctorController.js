const db     = require('../config/db');
const moment = require('moment');

// ── Smart Queue Calling — time-state config ──────────────
const WINDOW = parseInt(process.env.CALL_WINDOW_MINUTES) || 10;
const WARN   = parseInt(process.env.CALL_WARN_MINUTES)   || 30;

/**
 * Compute the call-state for a given time slot string.
 * @param {string} timeSlotString – "HH:MM" e.g. "09:15"
 * @returns {{ state:'GREEN'|'AMBER'|'RED', minutesEarly:number, minutesUntilGreen:number }}
 */
function getCallState(timeSlotString) {
  const now = new Date();
  const [slotHour, slotMin] = timeSlotString.split(':').map(Number);
  const slotTime = new Date();
  slotTime.setHours(slotHour, slotMin, 0, 0);
  // positive = slot is in the future (patient is early)
  const diffMinutes = Math.round((slotTime - now) / 60000);
  if (diffMinutes <= WINDOW) {
    return { state: 'GREEN', minutesEarly: 0, minutesUntilGreen: 0 };
  } else if (diffMinutes <= WARN) {
    return { state: 'AMBER', minutesEarly: diffMinutes, minutesUntilGreen: diffMinutes - WINDOW };
  } else {
    return { state: 'RED', minutesEarly: diffMinutes, minutesUntilGreen: diffMinutes - WINDOW };
  }
}

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
        AND (q.is_hidden = 0 OR q.is_hidden IS NULL)
      ORDER BY
        a.time_slot ASC,
        q.queue_position ASC
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
        AND (q.is_hidden = 0 OR q.is_hidden IS NULL)
    `, [doctor_id, today]);

    res.json({ success: true, queue, stats: stats[0], today, doctor_id });
  } catch (err) {
    console.error('Get today queue error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ── Check next patient (time-state pre-check) ────────────
const checkNextPatient = async (req, res) => {
  try {
    const [docRows] = await db.query(
      'SELECT id, avg_consult_min, room_number FROM doctors WHERE user_id = ?',
      [req.user.id]
    );
    if (!docRows.length) return res.status(404).json({ success: false, message: 'Doctor not found.' });
    const doctor = docRows[0];
    const today = moment().format('YYYY-MM-DD');

    const [nextRows] = await db.query(`
      SELECT
        q.id          AS queue_id,
        q.appointment_id,
        a.token_number,
        TIME_FORMAT(a.time_slot, '%H:%i') AS time_slot,
        a.priority,
        a.patient_id,
        u.name        AS patient_name,
        u.phone       AS patient_phone,
        fm.name       AS family_member_name
      FROM queue q
      JOIN appointments a ON q.appointment_id = a.id
      JOIN users u        ON a.patient_id = u.id
      LEFT JOIN family_members fm ON a.family_member_id = fm.id
      WHERE q.doctor_id  = ? AND q.queue_date = ? AND q.status = 'waiting'
      ORDER BY a.time_slot ASC, q.queue_position ASC
      LIMIT 1
    `, [doctor.id, today]);

    if (!nextRows.length) {
      return res.json({ success: true, status: 'NO_PATIENTS', message: 'No patients waiting.' });
    }

    const patient  = nextRows[0];
    const callInfo = getCallState(patient.time_slot);
    const displayName = patient.family_member_name || patient.patient_name;

    return res.json({
      success:             true,
      status:              callInfo.state,
      patient:             { ...patient, display_name: displayName },
      minutes_early:       callInfo.minutesEarly,
      minutes_until_green: callInfo.minutesUntilGreen,
      slot_time:           patient.time_slot,
      message: callInfo.state === 'GREEN'
        ? `Ready to call ${displayName}.`
        : callInfo.state === 'AMBER'
        ? `${displayName} (Token #${patient.token_number}) has a slot at ${patient.time_slot}. Calling ${callInfo.minutesEarly} minute(s) early.`
        : `${displayName} (Token #${patient.token_number}) has a slot at ${patient.time_slot}. That is ${callInfo.minutesEarly} minute(s) away. Call window opens in ${callInfo.minutesUntilGreen} min.`
    });
  } catch (err) {
    console.error('checkNextPatient error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ── Call next patient (time-aware) ────────────────────────
const callNext = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { force } = req.body; // force = true → doctor confirmed early call (AMBER)

    const [docRows] = await conn.query(
      'SELECT id, avg_consult_min, room_number FROM doctors WHERE user_id=?', [req.user.id]
    );
    if (!docRows.length) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: 'Doctor not found.' });
    }
    const doctor = docRows[0];
    const today  = moment().format('YYYY-MM-DD');

    // ── Complete current in_consultation patient (if any) ──
    const [current] = await conn.query(
      `SELECT q.id, q.appointment_id, a.patient_id FROM queue q
       JOIN appointments a ON q.appointment_id=a.id
       WHERE q.doctor_id=? AND q.queue_date=? AND q.status='in_consultation'`,
      [doctor.id, today]
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
          [appointment_id, doctor.id, duration, today]
        );
        await conn.query(
          `UPDATE doctors SET avg_consult_min = ROUND((avg_consult_min * 0.8) + (? * 0.2)) WHERE id=?`,
          [duration, doctor.id]
        );
      }
      await conn.query(
        `INSERT INTO notifications (user_id, title, message, type) VALUES (?, 'Consultation Completed', 'Your consultation has ended. Thank you!', 'queue')`,
        [patient_id]
      );
    }

    // ── Find next waiting patient ─────────────────────────
    const [next] = await conn.query(`
      SELECT q.id AS queue_id, q.appointment_id, a.patient_id, a.token_number,
             TIME_FORMAT(a.time_slot, '%H:%i') AS time_slot,
             u.name AS patient_name, fm.name AS family_member_name
      FROM queue q
      JOIN appointments a ON q.appointment_id=a.id
      JOIN users u ON a.patient_id=u.id
      LEFT JOIN family_members fm ON a.family_member_id = fm.id
      WHERE q.doctor_id=? AND q.queue_date=? AND q.status='waiting'
      ORDER BY a.time_slot ASC, q.queue_position ASC
      LIMIT 1
    `, [doctor.id, today]);

    if (!next.length) {
      await conn.commit();
      return res.json({ success: true, message: 'No more patients in queue.', next: null });
    }

    const patient = next[0];
    const displayName = patient.family_member_name || patient.patient_name;

    // ── Time-state check (skip if force = true) ───────────
    if (!force) {
      const callInfo = getCallState(patient.time_slot);
      if (callInfo.state === 'AMBER' || callInfo.state === 'RED') {
        await conn.commit(); // nothing mutated yet, safe to commit
        return res.json({
          success:              false,
          requiresConfirmation: callInfo.state === 'AMBER',
          blocked:              callInfo.state === 'RED',
          status:               callInfo.state,
          patient:              { ...patient, display_name: displayName },
          minutes_early:        callInfo.minutesEarly,
          minutes_until_green:  callInfo.minutesUntilGreen,
          slot_time:            patient.time_slot
        });
      }
    }

    // ── Call the patient ──────────────────────────────────
    await conn.query('UPDATE queue SET status="in_consultation", called_at=NOW() WHERE id=?', [patient.queue_id]);
    await conn.query('UPDATE appointments SET status="in_consultation", actual_start=NOW() WHERE id=?', [patient.appointment_id]);
    await conn.query(
      `INSERT INTO notifications (user_id, title, message, type)
       VALUES (?, 'Your Turn!', CONCAT('Please proceed to ', ?, '. Token #', ?), 'queue')`,
      [patient.patient_id, doctor.room_number || 'the clinic', patient.token_number]
    );

    // Recalculate estimated wait for remaining patients
    const [remaining] = await conn.query(
      `SELECT q.appointment_id FROM queue q
       JOIN appointments a ON q.appointment_id = a.id
       WHERE q.doctor_id=? AND q.queue_date=? AND q.status='waiting'
       ORDER BY a.time_slot ASC`, [doctor.id, today]
    );
    const [freshDoc] = await conn.query('SELECT avg_consult_min FROM doctors WHERE id=?', [doctor.id]);
    const avgMin = freshDoc[0]?.avg_consult_min || 15;
    for (let i = 0; i < remaining.length; i++) {
      await conn.query('UPDATE appointments SET estimated_wait=? WHERE id=?',
        [(i + 1) * avgMin, remaining[i].appointment_id]
      );
    }

    await conn.commit();
    res.json({ success: true, message: `Calling ${displayName} (Token #${patient.token_number})`, next: { ...patient, display_name: displayName } });
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

// ── Mark doctor on leave ──────────────────────────────────
const markLeave = async (req, res) => {
  try {
    const { leave_date, reason } = req.body;
    if (!leave_date) return res.status(400).json({ success: false, message: 'Leave date is required.' });
    const [doc] = await db.query(
      'SELECT id FROM doctors WHERE user_id=?', [req.user.id]
    );
    if (!doc.length) return res.status(404).json({ success: false, message: 'Doctor not found.' });

    // Validate: leave date must be strictly in the future (not today or past)
    const today = moment().format('YYYY-MM-DD');
    if (leave_date <= today) {
      return res.status(400).json({
        success: false,
        message: 'Cannot mark leave for today or a past date. Please select a future date.'
      });
    }

    // Check no active appointments on that date
    const [appts] = await db.query(
      `SELECT COUNT(*) AS cnt FROM appointments
       WHERE doctor_id=? AND appointment_date=?
         AND status NOT IN ('cancelled','completed','no_show')`,
      [doc[0].id, leave_date]
    );
    if (appts[0].cnt > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot mark leave. You have ${appts[0].cnt} active appointment(s) on this date. Please cancel or reschedule them first.`
      });
    }
    await db.query(
      `INSERT INTO doctor_leaves (doctor_id, leave_date, reason)
       VALUES (?,?,?) ON DUPLICATE KEY UPDATE reason=VALUES(reason)`,
      [doc[0].id, leave_date, reason || null]
    );
    res.json({ success: true, message: `Leave marked for ${leave_date}. Slots blocked.` });
  } catch (err) {
    console.error('Mark leave error:', err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
};

// ── Cancel a leave ────────────────────────────────────────
const cancelLeave = async (req, res) => {
  try {
    const [doc] = await db.query(
      'SELECT id FROM doctors WHERE user_id=?', [req.user.id]
    );
    if (!doc.length) return res.status(404).json({ success: false, message: 'Doctor not found.' });
    const doctor_id = doc[0].id;
    const { leave_date } = req.body;

    await db.query(
      'DELETE FROM doctor_leaves WHERE doctor_id=? AND leave_date=?',
      [doctor_id, leave_date]
    );

    // If cancelling today's leave, restore doctor availability immediately
    const today = moment().format('YYYY-MM-DD');
    if (leave_date === today) {
      // Only restore if no active breaks are running
      const [activeBreaks] = await db.query(
        `SELECT COUNT(*) AS cnt FROM doctor_breaks
         WHERE doctor_id=? AND break_date=? AND is_active=1`,
        [doctor_id, today]
      );
      if (activeBreaks[0].cnt === 0) {
        await db.query('UPDATE doctors SET is_available=1 WHERE id=?', [doctor_id]);
      }
    }

    res.json({ success: true, message: 'Leave cancelled. You are now available.' });
  } catch (err) {
    console.error('Cancel leave error:', err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
};

// ── Toggle rest/break mode ────────────────────────────────
const toggleBreak = async (req, res) => {
  try {
    const { action, start_time, end_time, reason } = req.body;
    const [doc] = await db.query(
      'SELECT id FROM doctors WHERE user_id=?', [req.user.id]
    );
    if (!doc.length) return res.status(404).json({ success: false, message: 'Doctor not found.' });
    const doctor_id = doc[0].id;
    const today = moment().format('YYYY-MM-DD');

    if (action === 'start') {
      if (!start_time || !end_time) {
        return res.status(400).json({ success: false, message: 'Both break start and end time are required.' });
      }

      // Validate: break start time must NOT be in the past
      const currentTime = moment().format('HH:mm');
      if (start_time < currentTime) {
        return res.status(400).json({
          success: false,
          message: `Break start time (${start_time}) cannot be in the past. Current time is ${currentTime}. Please select a time from now onwards.`
        });
      }

      // Don't allow break when in consultation
      const [inConsult] = await db.query(
        `SELECT q.id FROM queue q
         WHERE q.doctor_id=? AND q.queue_date=? AND q.status='in_consultation'`,
        [doctor_id, today]
      );
      if (inConsult.length) {
        return res.status(400).json({
          success: false,
          message: 'Cannot start break while a patient is in consultation. Complete the current consultation first.'
        });
      }

      // Don't allow break during already booked slots
      const [bookedInRange] = await db.query(
        `SELECT COUNT(*) AS cnt FROM appointments
         WHERE doctor_id=? AND appointment_date=?
           AND status NOT IN ('cancelled','completed','no_show')
           AND TIME_FORMAT(time_slot, '%H:%i') >= ? AND TIME_FORMAT(time_slot, '%H:%i') < ?`,
        [doctor_id, today, start_time, end_time]
      );
      if (bookedInRange[0].cnt > 0) {
        return res.status(400).json({
          success: false,
          message: `Cannot start break. There are ${bookedInRange[0].cnt} active appointment(s) scheduled between ${start_time} and ${end_time}. Cancel or complete them first.`
        });
      }

      await db.query(
        `INSERT INTO doctor_breaks
          (doctor_id, break_date, start_time, end_time, reason, is_active)
         VALUES (?,?,?,?,?,1)`,
        [doctor_id, today, start_time, end_time, reason || 'Break']
      );
      await db.query(
        'UPDATE doctors SET is_available=0 WHERE id=?', [doctor_id]
      );
      res.json({ success: true, message: 'Break mode activated. Slots blocked.' });
    } else {
      await db.query(
        `UPDATE doctor_breaks SET is_active=0
         WHERE doctor_id=? AND break_date=? AND is_active=1`,
        [doctor_id, today]
      );
      await db.query(
        'UPDATE doctors SET is_available=1 WHERE id=?', [doctor_id]
      );
      res.json({ success: true, message: 'Break ended. Slots reopened.' });
    }
  } catch (err) {
    console.error('Toggle break error:', err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
};

// ── Get leaves & breaks ──────────────────────────────────
const getLeaves = async (req, res) => {
  try {
    const [doc] = await db.query(
      'SELECT id FROM doctors WHERE user_id=?', [req.user.id]
    );
    if (!doc.length) return res.status(404).json({ success: false, message: 'Doctor not found.' });
    const doctor_id = doc[0].id;

    // Auto-expire any active breaks whose end_time has already passed today
    const [expiredBreaks] = await db.query(
      `UPDATE doctor_breaks SET is_active=0
       WHERE doctor_id=? AND break_date=CURDATE() AND is_active=1
         AND end_time <= CURTIME()`,
      [doctor_id]
    );
    // If any breaks were expired, check if doctor should be set back to available
    if (expiredBreaks.affectedRows > 0) {
      const [stillActive] = await db.query(
        `SELECT COUNT(*) AS cnt FROM doctor_breaks
         WHERE doctor_id=? AND break_date=CURDATE() AND is_active=1`,
        [doctor_id]
      );
      if (stillActive[0].cnt === 0) {
        await db.query('UPDATE doctors SET is_available=1 WHERE id=?', [doctor_id]);
      }
    }

    const [leaves] = await db.query(
      `SELECT * FROM doctor_leaves WHERE doctor_id=?
       AND leave_date >= CURDATE() ORDER BY leave_date`,
      [doctor_id]
    );
    const [breaks] = await db.query(
      `SELECT * FROM doctor_breaks WHERE doctor_id=?
       AND break_date >= CURDATE() ORDER BY break_date DESC`,
      [doctor_id]
    );
    res.json({ success: true, leaves, breaks });
  } catch (err) {
    console.error('Get leaves error:', err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
};

// ── Delete/hide a completed or skipped queue entry ───────
const deleteQueueEntry = async (req, res) => {
  try {
    const { queue_id } = req.params;
    // Only allow deletion of completed or skipped entries owned by this doctor
    const [rows] = await db.query(
      `SELECT q.id, q.status FROM queue q
       JOIN doctors d ON q.doctor_id = d.id
       WHERE q.id = ? AND d.user_id = ?`,
      [queue_id, req.user.id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Queue entry not found.' });
    }
    if (!['completed', 'skipped'].includes(rows[0].status)) {
      return res.status(400).json({
        success: false,
        message: 'Can only remove completed or skipped entries.'
      });
    }
    // Soft delete: mark as hidden (analytics data is preserved)
    await db.query('UPDATE queue SET is_hidden = 1 WHERE id = ?', [queue_id]);
    res.json({ success: true, message: 'Entry removed from queue history.' });
  } catch (err) {
    console.error('Delete queue entry error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ── STATE 4: Notify doctor of new booking (interrupt) ────
const notifyDoctorNewBooking = async (io, doctor_id, new_appointment_id, new_time_slot) => {
  try {
    const today = moment().format('YYYY-MM-DD');
    // If the doctor is currently in consultation, no interrupt needed
    const [activeCons] = await db.query(
      `SELECT id FROM queue WHERE doctor_id=? AND queue_date=? AND status='in_consultation'`,
      [doctor_id, today]
    );
    if (activeCons.length) return;

    // Compute state for the new slot
    const slotStr = typeof new_time_slot === 'string' && new_time_slot.includes(':')
      ? new_time_slot.substring(0, 5)
      : moment(new_time_slot, 'HH:mm:ss').format('HH:mm');
    const callInfo = getCallState(slotStr);

    // Get new patient info
    const [apptRows] = await db.query(`
      SELECT a.token_number, a.patient_id,
             TIME_FORMAT(a.time_slot,'%H:%i') AS time_slot,
             u.name AS patient_name,
             fm.name AS family_member_name
      FROM appointments a
      JOIN users u ON a.patient_id = u.id
      LEFT JOIN family_members fm ON a.family_member_id = fm.id
      WHERE a.id = ?
    `, [new_appointment_id]);
    if (!apptRows.length) return;

    const appt = apptRows[0];
    const displayName = appt.family_member_name || appt.patient_name;

    io.to(`doctor_${doctor_id}`).emit('new_booking_interrupt', {
      state:              callInfo.state,
      patient_name:       displayName,
      token_number:       appt.token_number,
      time_slot:          appt.time_slot,
      minutes_early:      callInfo.minutesEarly,
      minutes_until_green: callInfo.minutesUntilGreen,
      appointment_id:     new_appointment_id,
      message: callInfo.state === 'GREEN'
        ? `New patient just booked! ${displayName} (Token #${appt.token_number}) — slot ${appt.time_slot}. Ready to call now.`
        : callInfo.state === 'AMBER'
        ? `New booking: ${displayName} (Token #${appt.token_number}) at ${appt.time_slot}. ${callInfo.minutesEarly} min early — your choice to call.`
        : `New booking: ${displayName} (Token #${appt.token_number}) at ${appt.time_slot}. Call window opens in ${callInfo.minutesUntilGreen} min.`
    });
  } catch (err) {
    console.error('notifyDoctorNewBooking error:', err);
  }
};

// ── Scheduled: 5-Min Reminder + Delay Apology ────────────
const sendUpcomingReminders = async (io) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Find all active consultations
    const [activeCalls] = await db.query(`
      SELECT q.doctor_id, q.called_at, d.avg_consult_min,
             d.room_number, u_doc.name AS doctor_name,
             a.patient_id AS current_patient_id
      FROM queue q
      JOIN appointments a ON q.appointment_id = a.id
      JOIN doctors d ON q.doctor_id = d.id
      JOIN users u_doc ON d.user_id = u_doc.id
      WHERE q.status = 'in_consultation'
        AND q.queue_date = ?
        AND q.called_at IS NOT NULL
    `, [today]);

    for (const consult of activeCalls) {
      const calledAt = new Date(consult.called_at);
      const now = new Date();
      const elapsedMin = Math.floor((now - calledAt) / 60000);
      const remainingMin = consult.avg_consult_min - elapsedMin;

      // ── TYPE A: 5-Minute Heads-Up (3–5 min remaining) ──
      if (remainingMin <= 5 && remainingMin > 3) {
        const [nextPatient] = await db.query(`
          SELECT q2.appointment_id, a2.patient_id,
                 a2.token_number, a2.time_slot,
                 u.name AS patient_name
          FROM queue q2
          JOIN appointments a2 ON q2.appointment_id = a2.id
          JOIN users u ON a2.patient_id = u.id
          WHERE q2.doctor_id = ? AND q2.queue_date = ? AND q2.status = 'waiting'
          ORDER BY a2.time_slot ASC, q2.queue_position ASC
          LIMIT 1
        `, [consult.doctor_id, today]);

        if (nextPatient.length) {
          const np = nextPatient[0];

          // Avoid duplicate sends within 10 minutes
          const [alreadySent] = await db.query(`
            SELECT id FROM notifications
            WHERE user_id = ? AND type = 'queue'
              AND title = 'Get Ready — 5 Minutes! ⏰'
              AND created_at >= DATE_SUB(NOW(), INTERVAL 10 MINUTE)
          `, [np.patient_id]);

          if (!alreadySent.length) {
            const msg = `Dr. ${consult.doctor_name} will be ready for you in approximately 5 minutes. Please make your way to ${consult.room_number || 'the clinic'} now. Have your documents ready. Token #${np.token_number}`;

            await db.query(
              `INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, 'queue')`,
              [np.patient_id, 'Get Ready — 5 Minutes! ⏰', msg]
            );

            io.to(`appointment_${np.appointment_id}`).emit('five_min_reminder', {
              title:   'Get Ready — 5 Minutes! ⏰',
              message: `Dr. ${consult.doctor_name} will be with you in ~5 min. Please head to ${consult.room_number || 'Room'}. Token #${np.token_number}`,
              token:   np.token_number,
              doctor:  consult.doctor_name,
              room:    consult.room_number
            });
          }
        }
      }

      // ── TYPE B: Delay Apology (2–4 min overdue) ─────────
      const overByMinutes = elapsedMin - consult.avg_consult_min;

      if (overByMinutes >= 2 && overByMinutes <= 4) {
        const [waitingNext] = await db.query(`
          SELECT q2.appointment_id, a2.patient_id,
                 a2.token_number, u.name AS patient_name
          FROM queue q2
          JOIN appointments a2 ON q2.appointment_id = a2.id
          JOIN users u ON a2.patient_id = u.id
          WHERE q2.doctor_id = ? AND q2.queue_date = ? AND q2.status = 'waiting'
          ORDER BY a2.time_slot ASC, q2.queue_position ASC
          LIMIT 1
        `, [consult.doctor_id, today]);

        if (waitingNext.length) {
          const wn = waitingNext[0];

          // Avoid duplicate delay notifications (1 per 30 min)
          const [delayAlreadySent] = await db.query(`
            SELECT id FROM notifications
            WHERE user_id = ? AND type = 'queue'
              AND title LIKE '%Running a Little Late%'
              AND created_at >= DATE_SUB(NOW(), INTERVAL 30 MINUTE)
          `, [wn.patient_id]);

          if (!delayAlreadySent.length) {
            const extraWait = Math.ceil(overByMinutes);

            await db.query(
              `INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, 'queue')`,
              [
                wn.patient_id,
                'Running a Little Late — We Apologize 🙏',
                `Dear ${wn.patient_name}, we sincerely apologize — Dr. ${consult.doctor_name}'s current consultation is taking a little longer than expected. Your estimated wait time may increase by approximately ${extraWait}–${extraWait + 5} minutes. Thank you for your patience. We will call you as soon as possible. Token #${wn.token_number}`
              ]
            );

            io.to(`appointment_${wn.appointment_id}`).emit('delay_notification', {
              title:      'Running a Little Late — We Apologize 🙏',
              message:    `Dr. ${consult.doctor_name}'s current consultation is running over. You may need to wait an extra ~${extraWait + 3} minutes. We truly appreciate your patience.`,
              extra_wait: extraWait + 3,
              token:      wn.token_number,
              doctor:     consult.doctor_name
            });

            // Recalculate estimated_wait for all remaining waiting patients
            const [allWaiting] = await db.query(`
              SELECT q3.appointment_id FROM queue q3
              JOIN appointments a3 ON q3.appointment_id = a3.id
              WHERE q3.doctor_id = ? AND q3.queue_date = ? AND q3.status = 'waiting'
              ORDER BY a3.time_slot ASC
            `, [consult.doctor_id, today]);

            for (let i = 0; i < allWaiting.length; i++) {
              await db.query(
                'UPDATE appointments SET estimated_wait = ? WHERE id = ?',
                [(i + 1) * (consult.avg_consult_min + extraWait), allWaiting[i].appointment_id]
              );
            }
          }
        }
      }

      // ── Emit overdue warning to doctor dashboard ────────
      if (overByMinutes >= 1) {
        io.to(`doctor_${consult.doctor_id}`).emit('consult_overdue', {
          over_by: overByMinutes,
          avg_min: consult.avg_consult_min
        });
      }
    }
  } catch (err) {
    console.error('sendUpcomingReminders error:', err);
  }
};

// ── Complete consultation (without calling next) ─────────
const completeConsultation = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { appointment_id, queue_id } = req.body;

    const [docRows] = await conn.query(
      'SELECT id, avg_consult_min FROM doctors WHERE user_id = ?', [req.user.id]
    );
    if (!docRows.length) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: 'Doctor not found.' });
    }
    const doctor = docRows[0];

    // Verify the queue entry is actually in_consultation
    const [queueRows] = await conn.query(
      `SELECT q.id, q.called_at, q.status, a.patient_id
       FROM queue q
       JOIN appointments a ON q.appointment_id = a.id
       WHERE q.id = ? AND q.appointment_id = ? AND q.doctor_id = ? AND q.status = 'in_consultation'`,
      [queue_id, appointment_id, doctor.id]
    );
    if (!queueRows.length) {
      await conn.rollback();
      return res.status(400).json({ success: false, message: 'No active consultation found to complete.' });
    }

    const current = queueRows[0];

    // Mark as completed
    await conn.query('UPDATE queue SET status = "completed" WHERE id = ?', [queue_id]);
    await conn.query('UPDATE appointments SET status = "completed", actual_end = NOW() WHERE id = ?', [appointment_id]);

    // Calculate duration and update rolling average + analytics
    if (current.called_at) {
      const durationMin = Math.round((new Date() - new Date(current.called_at)) / 60000);
      if (durationMin > 0 && durationMin < 120) {
        await conn.query(
          'UPDATE doctors SET avg_consult_min = ROUND((avg_consult_min * 0.8) + (? * 0.2)) WHERE id = ?',
          [durationMin, doctor.id]
        );
        const today = new Date().toISOString().split('T')[0];
        await conn.query(
          'INSERT INTO consultation_analytics (appointment_id, doctor_id, actual_duration, date) VALUES (?, ?, ?, ?)',
          [appointment_id, doctor.id, durationMin, today]
        );
      }
    }

    // Notify patient
    await conn.query(
      `INSERT INTO notifications (user_id, title, message, type)
       VALUES (?, 'Consultation Completed \u2705', 'Your consultation with the doctor is complete. Thank you for visiting SmartCare!', 'queue')`,
      [current.patient_id]
    );

    await conn.commit();
    return res.json({ success: true, message: 'Consultation marked as complete. Click Call Next Patient when ready.' });
  } catch (err) {
    await conn.rollback();
    console.error('completeConsultation error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  } finally {
    conn.release();
  }
};

module.exports = {
  getDoctorProfile, getTodayQueue, callNext, checkNextPatient,
  notifyDoctorNewBooking, markEmergency, getAnalytics, skipPatient,
  markLeave, cancelLeave, toggleBreak, getLeaves, deleteQueueEntry,
  sendUpcomingReminders, completeConsultation
};
