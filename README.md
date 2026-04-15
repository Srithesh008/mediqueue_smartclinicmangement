# 🏥 Smart Clinic Queue & Appointment Optimization System

A full-stack healthcare web application that digitizes clinic operations with **real-time queue tracking**, **intelligent slot optimization**, **emergency prioritization**, and **predictive analytics**.

---

## 📁 Folder Structure

```
smart-clinic/
├── server.js                    # Express + Socket.io main server
├── package.json
├── .env.example                 → copy to .env
│
├── config/
│   └── db.js                    # MySQL connection pool
│
├── middleware/
│   └── authMiddleware.js        # JWT verify + role guard
│
├── controllers/
│   ├── authController.js        # Register, login, profile, family
│   ├── appointmentController.js # Book, cancel, reschedule, queue
│   ├── doctorController.js      # Queue mgmt, call next, emergency, analytics
│   └── adminController.js       # Dashboard, users, doctors, reports
│
├── routes/
│   ├── auth.js
│   ├── appointments.js
│   ├── doctor.js
│   └── admin.js
│
├── database/
│   └── schema.sql               # Full DB schema + seed data
│
└── public/                      # Frontend (served as static files)
    ├── index.html               # Landing page
    ├── login.html
    ├── register.html
    ├── patient-dashboard.html
    ├── book-appointment.html
    ├── doctor-dashboard.html
    ├── admin-panel.html
    ├── profile.html
    ├── css/
    │   └── styles.css
    └── js/
        └── utils.js             # Shared API helper, auth, toasts, formatters
```

---

## ⚙️ Tech Stack

| Layer       | Technology                          |
|-------------|-------------------------------------|
| Frontend    | HTML5, CSS3, Vanilla JavaScript     |
| Backend     | Node.js, Express.js                 |
| Database    | MySQL 8+                            |
| Real-time   | Socket.io                           |
| Auth        | JWT (jsonwebtoken) + bcryptjs       |
| Charts      | Chart.js 4                          |
| CSS Fonts   | Google Fonts (Plus Jakarta Sans + Sora) |

---

## 🚀 Setup Instructions

### 1. Prerequisites
- Node.js v16+
- MySQL 8+
- npm

### 2. Clone & Install
```bash
cd smart-clinic
npm install
```

### 3. Database Setup
```bash
# Login to MySQL
mysql -u root -p

# Run the schema file
source database/schema.sql
# OR
mysql -u root -p < database/schema.sql
```

### 4. Environment Variables
```bash
cp .env.example .env
```
Edit `.env`:
```
PORT=5000
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=your_mysql_password
DB_NAME=smart_clinic
JWT_SECRET=your_super_secret_key_here
```

### 5. Start the Server
```bash
# Development (with auto-reload)
npm run dev

# Production
npm start
```

### 6. Open in Browser
```
http://localhost:5000
```

---

## 🔐 Demo Credentials

| Role    | Email                        | Password    |
|---------|------------------------------|-------------|
| Admin   | admin@smartclinic.com        | Admin@123   |
| Doctor  | drpriya@smartclinic.com      | Admin@123   |
| Doctor  | drrajan@smartclinic.com      | Admin@123   |
| Patient | arjun@email.com              | Admin@123   |

> ⚠️ Change all passwords before production deployment!

---

## 🌐 API Endpoints

### Auth `/api/auth`
| Method | Endpoint              | Auth     | Description            |
|--------|-----------------------|----------|------------------------|
| POST   | `/register`           | Public   | Patient registration   |
| POST   | `/login`              | Public   | Login (all roles)      |
| GET    | `/profile`            | Any role | Get own profile        |
| PUT    | `/profile`            | Any role | Update profile         |
| POST   | `/family-member`      | Patient  | Add family member      |

### Appointments `/api/appointments`
| Method | Endpoint                          | Auth    | Description              |
|--------|-----------------------------------|---------|--------------------------|
| GET    | `/doctors`                        | Public  | List all doctors         |
| GET    | `/slots?doctor_id=&date=`         | Any     | Available time slots     |
| POST   | `/book`                           | Patient | Book appointment         |
| GET    | `/my`                             | Patient | My appointments          |
| GET    | `/:id`                            | Any     | Single appointment       |
| PUT    | `/:id/cancel`                     | Patient | Cancel appointment       |
| PUT    | `/:id/reschedule`                 | Patient | Reschedule               |
| GET    | `/queue/:appointment_id/position` | Any     | Live queue position      |

### Doctor `/api/doctor`
| Method | Endpoint       | Auth   | Description              |
|--------|----------------|--------|--------------------------|
| GET    | `/profile`     | Doctor | Doctor profile           |
| GET    | `/queue`       | Doctor | Today's queue            |
| POST   | `/call-next`   | Doctor | Call next patient        |
| POST   | `/emergency`   | Doctor | Mark emergency priority  |
| POST   | `/skip`        | Doctor | Skip patient             |
| GET    | `/analytics`   | Doctor | Performance analytics    |

### Admin `/api/admin`
| Method | Endpoint                | Auth  | Description              |
|--------|-------------------------|-------|--------------------------|
| GET    | `/dashboard`            | Admin | Dashboard stats + logs   |
| GET    | `/users`                | Admin | All users (filter/search)|
| PUT    | `/users/:id/toggle`     | Admin | Activate/deactivate user |
| POST   | `/doctors`              | Admin | Create doctor account    |
| GET    | `/appointments`         | Admin | All appointments         |
| GET    | `/analytics`            | Admin | System-wide analytics    |

---

## ⚡ Key Features Explained

### Auto Slot Optimization
When doctor's `avg_consult_min` updates dynamically (rolling average of real consultations), slot boundaries shift automatically on next day's bookings. The system uses an **exponential moving average**: `new_avg = (old_avg × 0.8) + (actual × 0.2)` to prevent outlier bias.

### Smart Queue Prediction
`estimated_wait = patients_ahead × doctor.avg_consult_min`
Updated in real-time after every patient call via Socket.io broadcast.

### Emergency Mode
Doctor clicks Emergency → patient's `priority` field becomes `'emergency'` → All queue queries use `ORDER BY CASE priority WHEN 'emergency' THEN 1 WHEN 'urgent' THEN 2 ELSE 3 END` → Patient naturally floats to top → Notification sent to patient.

### Real-Time via Socket.io
- Patient joins room: `appointment_<id>`
- Doctor joins room: `doctor_<id>`
- Events: `queue_updated`, `your_turn`, `wait_update`, `emergency_alert`

---

## 🛡️ Security Features
- Passwords hashed with bcrypt (cost factor 10)
- JWT tokens with configurable expiry
- Role-based route guards on all protected endpoints
- SQL injection prevention via parameterized queries (mysql2 pool)
- CORS configured

---

## 📊 Database Schema Summary

```
users          → All users (patient/doctor/admin)
doctors        → Doctor-specific info (extends users)
family_members → Dependents linked to a patient
appointments   → Core booking table
queue          → Live daily queue state
consultation_analytics → Actual durations for ML/avg calculation
notifications  → Per-user notification feed
system_logs    → Admin audit trail
```

---

## 🔮 Future Enhancements
- SMS/WhatsApp notifications via Twilio
- Video consultation (WebRTC)
- Payment gateway (Razorpay)
- Multi-clinic / SaaS mode
- AI symptom checker (GPT API)
- PWA / Mobile App (React Native)
- Prescription management

---

## 📄 License
MIT License — Free for educational and commercial use.

Built with ❤️ for Indian Healthcare 🇮🇳
