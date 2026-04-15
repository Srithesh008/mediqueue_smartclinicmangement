const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');

// Email format validator
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Register ──────────────────────────────────────────────
const register = async (req, res) => {
  try {
    const { name, email, phone, password, gender, dob, blood_group, address } = req.body;

    // Validate email format
    if (!email || !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid email address (e.g., name@example.com).' });
    }

    // Check duplicate
    const [existing] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length) {
      return res.status(409).json({ success: false, message: 'Email already registered.' });
    }

    const hashed = await bcrypt.hash(password, 10);
    const [result] = await db.query(
      `INSERT INTO users (name, email, phone, password, gender, dob, blood_group, address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, email, phone, hashed, gender || null, dob || null, blood_group || null, address || null]
    );

    // Log
    await db.query('INSERT INTO system_logs (user_id, action, description) VALUES (?, ?, ?)',
      [result.insertId, 'REGISTER', `New patient registered: ${email}`]);

    const token = jwt.sign(
      { id: result.insertId, email, role: 'patient', name },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.status(201).json({
      success: true,
      message: 'Registration successful!',
      token,
      user: { id: result.insertId, name, email, role: 'patient' }
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ success: false, message: 'Server error during registration.' });
  }
};

// ── Login ─────────────────────────────────────────────────
const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate email format
    if (!email || !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid email address (e.g., name@example.com).' });
    }

    const [rows] = await db.query(
      'SELECT id, name, email, password, role, is_active FROM users WHERE email = ?', [email]
    );
    if (!rows.length) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    const user = rows[0];
    if (!user.is_active) {
      return res.status(403).json({ success: false, message: 'Account is deactivated.' });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    await db.query('INSERT INTO system_logs (user_id, action, description) VALUES (?, ?, ?)',
      [user.id, 'LOGIN', `User logged in: ${email}`]);

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({
      success: true,
      message: 'Login successful!',
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Server error during login.' });
  }
};

// ── Get Profile ───────────────────────────────────────────
const getProfile = async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, name, email, phone, gender, dob, blood_group, address, role, profile_pic, created_at FROM users WHERE id = ?',
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'User not found.' });

    // Family members
    const [family] = await db.query('SELECT * FROM family_members WHERE user_id = ?', [req.user.id]);

    res.json({ success: true, user: rows[0], family_members: family });
  } catch (err) {
    console.error('Profile error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ── Update Profile ────────────────────────────────────────
const updateProfile = async (req, res) => {
  try {
    const { name, phone, gender, dob, blood_group, address } = req.body;
    await db.query(
      'UPDATE users SET name=?, phone=?, gender=?, dob=?, blood_group=?, address=? WHERE id=?',
      [name, phone, gender, dob, blood_group, address, req.user.id]
    );
    res.json({ success: true, message: 'Profile updated successfully.' });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ── Add Family Member ─────────────────────────────────────
const addFamilyMember = async (req, res) => {
  try {
    const { name, relation, dob, gender, blood_group } = req.body;
    const [result] = await db.query(
      'INSERT INTO family_members (user_id, name, relation, dob, gender, blood_group) VALUES (?,?,?,?,?,?)',
      [req.user.id, name, relation, dob, gender, blood_group]
    );
    res.status(201).json({ success: true, message: 'Family member added.', id: result.insertId });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

module.exports = { register, login, getProfile, updateProfile, addFamilyMember };
