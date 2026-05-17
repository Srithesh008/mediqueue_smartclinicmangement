// ── routes/doctor.js ─────────────────────────────────────
const express    = require('express');
const router     = express.Router();
const { getDoctorProfile, getTodayQueue, callNext, checkNextPatient, notifyDoctorNewBooking, markEmergency, getAnalytics, skipPatient, markLeave, cancelLeave, toggleBreak, getLeaves, deleteQueueEntry, completeConsultation } = require('../controllers/doctorController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');

router.get('/profile',    verifyToken, requireRole('doctor'), getDoctorProfile);
router.get('/queue',      verifyToken, requireRole('doctor'), getTodayQueue);
router.get('/queue/check-next', verifyToken, requireRole('doctor'), checkNextPatient);
router.post('/call-next', verifyToken, requireRole('doctor'), callNext);
router.post('/complete-consultation', verifyToken, requireRole('doctor'), completeConsultation);
router.post('/emergency', verifyToken, requireRole('doctor'), markEmergency);
router.post('/skip',      verifyToken, requireRole('doctor'), skipPatient);
router.get('/analytics',  verifyToken, requireRole('doctor'), getAnalytics);
router.post('/leave',     verifyToken, requireRole('doctor'), markLeave);
router.delete('/leave',   verifyToken, requireRole('doctor'), cancelLeave);
router.post('/break',     verifyToken, requireRole('doctor'), toggleBreak);
router.get('/leaves',     verifyToken, requireRole('doctor'), getLeaves);
router.delete('/queue/:queue_id', verifyToken, requireRole('doctor'), deleteQueueEntry);

module.exports = router;

