const express = require('express');
const router  = express.Router();
const { getDashboard, getAllUsers, toggleUserStatus, createDoctor, getAllAppointments, getSystemAnalytics } = require('../controllers/adminController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');

const adminOnly = [verifyToken, requireRole('admin')];

router.get('/dashboard',          ...adminOnly, getDashboard);
router.get('/users',              ...adminOnly, getAllUsers);
router.put('/users/:id/toggle',   ...adminOnly, toggleUserStatus);
router.post('/doctors',           ...adminOnly, createDoctor);
router.get('/appointments',       ...adminOnly, getAllAppointments);
router.get('/analytics',          ...adminOnly, getSystemAnalytics);

module.exports = router;
