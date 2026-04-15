const express = require('express');
const router  = express.Router();
const {
  getDoctors, getAvailableSlots, bookAppointment,
  getMyAppointments, getAppointment, cancelAppointment,
  rescheduleAppointment, getQueuePosition
} = require('../controllers/appointmentController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');

router.get('/doctors',                         getDoctors);
router.get('/slots',                           verifyToken, getAvailableSlots);
router.post('/book',                           verifyToken, requireRole('patient'), bookAppointment);
router.get('/my',                              verifyToken, requireRole('patient'), getMyAppointments);
router.get('/:id',                             verifyToken, getAppointment);
router.put('/:id/cancel',                      verifyToken, cancelAppointment);
router.put('/:id/reschedule',                  verifyToken, rescheduleAppointment);
router.get('/queue/:appointment_id/position',  verifyToken, getQueuePosition);

module.exports = router;
