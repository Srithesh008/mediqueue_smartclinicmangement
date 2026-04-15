// ── routes/doctor.js ─────────────────────────────────────
const express    = require('express');
const router     = express.Router();
const { getDoctorProfile, getTodayQueue, callNext, markEmergency, getAnalytics, skipPatient } = require('../controllers/doctorController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');

router.get('/profile',    verifyToken, requireRole('doctor'), getDoctorProfile);
router.get('/queue',      verifyToken, requireRole('doctor'), getTodayQueue);
router.post('/call-next', verifyToken, requireRole('doctor'), callNext);
router.post('/emergency', verifyToken, requireRole('doctor'), markEmergency);
router.post('/skip',      verifyToken, requireRole('doctor'), skipPatient);
router.get('/analytics',  verifyToken, requireRole('doctor'), getAnalytics);

module.exports = router;
