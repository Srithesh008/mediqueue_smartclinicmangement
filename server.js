require('dotenv').config();
const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const cors      = require('cors');
const path      = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: process.env.CLIENT_URL || '*', methods: ['GET','POST'] }
});

// ── Middleware ────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// ── API Routes ────────────────────────────────────────────
app.use('/api/auth',         require('./routes/auth'));
app.use('/api/appointments', require('./routes/appointments'));
app.use('/api/doctor',       require('./routes/doctor'));
app.use('/api/admin',        require('./routes/admin'));

// ── Health check ──────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), app: 'Smart Clinic Queue System' });
});

// ── Socket.io Real-time Events ────────────────────────────
io.on('connection', (socket) => {
  console.log(`🔌  Socket connected: ${socket.id}`);

  // Patient joins their appointment room
  socket.on('join_appointment', (appointment_id) => {
    socket.join(`appointment_${appointment_id}`);
    console.log(`Patient joined room: appointment_${appointment_id}`);
  });

  // Doctor joins their queue room
  socket.on('join_doctor_queue', (doctor_id) => {
    socket.join(`doctor_${doctor_id}`);
    console.log(`Doctor joined room: doctor_${doctor_id}`);
  });

  // Doctor calls next → broadcast to all patients of that doctor
  socket.on('queue_updated', (data) => {
    io.to(`doctor_${data.doctor_id}`).emit('queue_update', data);
    if (data.called_appointment_id) {
      io.to(`appointment_${data.called_appointment_id}`).emit('your_turn', {
        message: "It's your turn! Please proceed to the doctor.",
        token:   data.token_number
      });
    }
  });

  // Emergency alert
  socket.on('emergency_added', (data) => {
    io.to(`doctor_${data.doctor_id}`).emit('emergency_alert', data);
  });

  // Patient queue position update
  socket.on('position_changed', (data) => {
    io.to(`appointment_${data.appointment_id}`).emit('wait_update', {
      position:   data.position,
      wait_min:   data.wait_min,
      status:     data.status
    });
  });

  socket.on('disconnect', () => {
    console.log(`🔌  Socket disconnected: ${socket.id}`);
  });
});

// Make io accessible in controllers via req.app.get('io')
app.set('io', io);

// ── Scheduled Background Tasks ───────────────────────────
const { sendUpcomingReminders } = require('./controllers/doctorController');
setInterval(() => sendUpcomingReminders(io), 60 * 1000);

// ── SPA Fallback ──────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start server ──────────────────────────────────────────
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`\n🏥  Smart Clinic Queue System`);
  console.log(`🚀  Server running on http://localhost:${PORT}`);
  console.log(`📡  Socket.io active`);
  console.log(`🌐  Environment: ${process.env.NODE_ENV || 'development'}\n`);
});

module.exports = { app, io };
