const db     = require('../config/db');
const bcrypt = require('bcryptjs');
const moment = require('moment');

// ── Dashboard stats ───────────────────────────────────────
const getDashboard = async (req, res) => {
  try {
    const today = moment().format('YYYY-MM-DD');

    const [[patients]]     = await db.query("SELECT COUNT(*) AS cnt FROM users WHERE role='patient' AND is_active=1");
    const [[doctors]]      = await db.query("SELECT COUNT(*) AS cnt FROM doctors");
    const [[todayAppts]]   = await db.query("SELECT COUNT(*) AS cnt FROM appointments WHERE appointment_date=?", [today]);
    const [[pending]]      = await db.query("SELECT COUNT(*) AS cnt FROM appointments WHERE appointment_date=? AND status IN ('scheduled','waiting')", [today]);
    const [[completed]]    = await db.query("SELECT COUNT(*) AS cnt FROM appointments WHERE appointment_date=? AND status='completed'", [today]);
    const [[emergencies]]  = await db.query("SELECT COUNT(*) AS cnt FROM appointments WHERE appointment_date=? AND priority='emergency'", [today]);

    // Weekly trend
    const [weekly] = await db.query(`
      SELECT appointment_date AS date, COUNT(*) AS total,
             SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed
      FROM appointments
      WHERE appointment_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
      GROUP BY appointment_date ORDER BY appointment_date
    `);

    // Recent logs
    const [logs] = await db.query(`
      SELECT l.*, u.name AS user_name
      FROM system_logs l LEFT JOIN users u ON l.user_id=u.id
      ORDER BY l.created_at DESC LIMIT 20
    `);

    res.json({
      success: true,
      stats: {
        total_patients: patients.cnt,
        total_doctors:  doctors.cnt,
        today_appointments: todayAppts.cnt,
        pending, completed: completed.cnt, emergencies: emergencies.cnt
      },
      weekly_trend: weekly,
      recent_logs:  logs
    });
  } catch (err) {
    console.error('Admin dashboard error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ── Get all users ─────────────────────────────────────────
const getAllUsers = async (req, res) => {
  try {
    const { role, search } = req.query;
    let query = 'SELECT id, name, email, phone, role, gender, is_active, created_at FROM users WHERE 1=1';
    const params = [];
    if (role)   { query += ' AND role=?';                params.push(role); }
    if (search) { query += ' AND (name LIKE ? OR email LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    query += ' ORDER BY created_at DESC';

    const [users] = await db.query(query, params);
    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ── Toggle user active status ─────────────────────────────
const toggleUserStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await db.query('SELECT is_active FROM users WHERE id=?', [id]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'User not found.' });
    const newStatus = rows[0].is_active ? 0 : 1;
    await db.query('UPDATE users SET is_active=? WHERE id=?', [newStatus, id]);
    res.json({ success: true, message: `User ${newStatus ? 'activated' : 'deactivated'}.` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ── Create doctor ─────────────────────────────────────────
const createDoctor = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { name, email, phone, password, gender, specialization, qualification, experience_yrs, avg_consult_min, room_number } = req.body;

    const [existing] = await conn.query('SELECT id FROM users WHERE email=?', [email]);
    if (existing.length) {
      await conn.rollback();
      return res.status(409).json({ success: false, message: 'Email already registered.' });
    }

    const hashed = await bcrypt.hash(password, 10);
    const [userRes] = await conn.query(
      'INSERT INTO users (name, email, phone, password, role, gender) VALUES (?,?,?,?,?,?)',
      [name, email, phone, hashed, 'doctor', gender]
    );
    await conn.query(
      'INSERT INTO doctors (user_id, specialization, qualification, experience_yrs, avg_consult_min, room_number) VALUES (?,?,?,?,?,?)',
      [userRes.insertId, specialization, qualification, experience_yrs||0, avg_consult_min||15, room_number]
    );

    await conn.commit();
    res.status(201).json({ success: true, message: 'Doctor created successfully.' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, message: 'Server error.' });
  } finally {
    conn.release();
  }
};

// ── Get all appointments (admin view) ─────────────────────
const getAllAppointments = async (req, res) => {
  try {
    const { date, status, doctor_id } = req.query;
    let query = `
      SELECT a.*, u.name AS patient_name, u.phone AS patient_phone,
             du.name AS doctor_name, d.specialization
      FROM appointments a
      JOIN users u ON a.patient_id=u.id
      JOIN doctors d ON a.doctor_id=d.id
      JOIN users du ON d.user_id=du.id
      WHERE 1=1
    `;
    const params = [];
    if (date)      { query += ' AND a.appointment_date=?'; params.push(date); }
    if (status)    { query += ' AND a.status=?';           params.push(status); }
    if (doctor_id) { query += ' AND a.doctor_id=?';        params.push(doctor_id); }
    query += ' ORDER BY a.appointment_date DESC, a.time_slot';

    const [appointments] = await db.query(query, params);
    res.json({ success: true, appointments });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ── System analytics ──────────────────────────────────────
const getSystemAnalytics = async (req, res) => {
  try {
    const [monthlyStats] = await db.query(`
      SELECT DATE_FORMAT(appointment_date, '%Y-%m') AS month,
             COUNT(*) AS total,
             SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
             SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled
      FROM appointments
      WHERE appointment_date >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
      GROUP BY month ORDER BY month
    `);

    const [doctorPerf] = await db.query(`
      SELECT u.name, d.specialization, d.avg_consult_min,
             COUNT(a.id) AS total_appointments,
             SUM(CASE WHEN a.status='completed' THEN 1 ELSE 0 END) AS completed
      FROM doctors d JOIN users u ON d.user_id=u.id
      LEFT JOIN appointments a ON d.id=a.doctor_id
        AND a.appointment_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
      GROUP BY d.id
    `);

    const [peakHours] = await db.query(`
      SELECT HOUR(time_slot) AS hour, COUNT(*) AS bookings
      FROM appointments
      WHERE appointment_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
      GROUP BY hour ORDER BY hour
    `);

    res.json({ success: true, monthly: monthlyStats, doctor_performance: doctorPerf, peak_hours: peakHours });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

module.exports = { getDashboard, getAllUsers, toggleUserStatus, createDoctor, getAllAppointments, getSystemAnalytics };
