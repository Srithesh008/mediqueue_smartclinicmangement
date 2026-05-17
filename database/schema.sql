-- ============================================================
--  Smart Clinic Queue & Appointment Optimization System
--  Database Schema
-- ============================================================

CREATE DATABASE IF NOT EXISTS smart_clinic;
USE smart_clinic;

-- ─────────────────────────────────────────────────────────
-- USERS TABLE
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  name         VARCHAR(100) NOT NULL,
  email        VARCHAR(150) NOT NULL UNIQUE,
  phone        VARCHAR(15)  NOT NULL,
  password     VARCHAR(255) NOT NULL,
  role         ENUM('patient','doctor','admin') DEFAULT 'patient',
  gender       ENUM('male','female','other'),
  dob          DATE,
  blood_group  VARCHAR(5),
  address      TEXT,
  profile_pic  VARCHAR(255),
  is_active    TINYINT(1) DEFAULT 1,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ─────────────────────────────────────────────────────────
-- DOCTORS TABLE (extends users)
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS doctors (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT NOT NULL,
  specialization  VARCHAR(100),
  qualification   VARCHAR(200),
  experience_yrs  INT DEFAULT 0,
  avg_consult_min INT DEFAULT 15,
  is_available    TINYINT(1) DEFAULT 1,
  room_number     VARCHAR(20),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ─────────────────────────────────────────────────────────
-- FAMILY MEMBERS TABLE
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS family_members (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  user_id      INT NOT NULL,
  name         VARCHAR(100) NOT NULL,
  relation     VARCHAR(50),
  dob          DATE,
  gender       ENUM('male','female','other'),
  blood_group  VARCHAR(5),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ─────────────────────────────────────────────────────────
-- APPOINTMENTS TABLE
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS appointments (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  patient_id       INT NOT NULL,
  doctor_id        INT NOT NULL,
  family_member_id INT DEFAULT NULL,
  appointment_date DATE NOT NULL,
  time_slot        TIME NOT NULL,
  token_number     INT NOT NULL,
  status           ENUM('scheduled','waiting','in_consultation','completed','cancelled','no_show') DEFAULT 'scheduled',
  priority         ENUM('normal','urgent','emergency') DEFAULT 'normal',
  symptoms         TEXT,
  notes            TEXT,
  actual_start     DATETIME,
  actual_end       DATETIME,
  estimated_wait   INT DEFAULT 0,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (patient_id)  REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (doctor_id)   REFERENCES doctors(id) ON DELETE CASCADE,
  FOREIGN KEY (family_member_id) REFERENCES family_members(id) ON DELETE SET NULL
);

-- ─────────────────────────────────────────────────────────
-- QUEUE TABLE (live queue state)
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS queue (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  appointment_id  INT NOT NULL UNIQUE,
  doctor_id       INT NOT NULL,
  queue_date      DATE NOT NULL,
  queue_position  INT NOT NULL,
  status          ENUM('waiting','in_consultation','completed','skipped') DEFAULT 'waiting',
  is_hidden       TINYINT(1) DEFAULT 0,
  entered_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  called_at       DATETIME,
  FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE,
  FOREIGN KEY (doctor_id)      REFERENCES doctors(id) ON DELETE CASCADE
);

-- ─────────────────────────────────────────────────────────
-- CONSULTATION ANALYTICS TABLE
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS consultation_analytics (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  appointment_id  INT NOT NULL,
  doctor_id       INT NOT NULL,
  actual_duration INT,
  wait_duration   INT,
  date            DATE NOT NULL,
  FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE,
  FOREIGN KEY (doctor_id)      REFERENCES doctors(id) ON DELETE CASCADE
);

-- ─────────────────────────────────────────────────────────
-- SYSTEM LOGS TABLE
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS system_logs (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT,
  action      VARCHAR(100),
  description TEXT,
  ip_address  VARCHAR(45),
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ─────────────────────────────────────────────────────────
-- NOTIFICATIONS TABLE
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  user_id    INT NOT NULL,
  title      VARCHAR(200),
  message    TEXT,
  type       ENUM('appointment','queue','system','emergency') DEFAULT 'system',
  is_read    TINYINT(1) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ─────────────────────────────────────────────────────────
-- DOCTOR LEAVES TABLE
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS doctor_leaves (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  doctor_id   INT NOT NULL,
  leave_date  DATE NOT NULL,
  reason      VARCHAR(200),
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_leave (doctor_id, leave_date),
  FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE CASCADE
);

-- ─────────────────────────────────────────────────────────
-- DOCTOR BREAKS TABLE
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS doctor_breaks (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  doctor_id   INT NOT NULL,
  break_date  DATE NOT NULL,
  start_time  TIME NOT NULL,
  end_time    TIME NOT NULL,
  reason      VARCHAR(200),
  is_active   TINYINT(1) DEFAULT 1,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE CASCADE
);

-- ─────────────────────────────────────────────────────────
-- SEED DATA
-- ─────────────────────────────────────────────────────────

-- Admin user (password: Admin@123)
INSERT INTO users (name, email, phone, password, role) VALUES
('System Admin', 'admin@smartclinic.com', '9999999999',
 '$2a$10$Tciy8JlouOBeHouLjVlQnuf/q23AN8Jk56EWVHTIec19MfatDn3nO', 'admin');

-- Doctor user (password: Admin@123)
INSERT INTO users (name, email, phone, password, role, gender) VALUES
('Dr. Priya Sharma',   'drpriya@smartclinic.com',   '9876543210', '$2a$10$Tciy8JlouOBeHouLjVlQnuf/q23AN8Jk56EWVHTIec19MfatDn3nO', 'doctor', 'female'),
('Dr. Rajan Mehta',    'drrajan@smartclinic.com',   '9876543211', '$2a$10$Tciy8JlouOBeHouLjVlQnuf/q23AN8Jk56EWVHTIec19MfatDn3nO', 'doctor', 'male'),
('Dr. Anita Rao',      'dranita@smartclinic.com',   '9876543212', '$2a$10$Tciy8JlouOBeHouLjVlQnuf/q23AN8Jk56EWVHTIec19MfatDn3nO', 'doctor', 'female');

-- Doctor profiles
INSERT INTO doctors (user_id, specialization, qualification, experience_yrs, avg_consult_min, room_number) VALUES
(2, 'General Medicine',  'MBBS, MD', 8,  15, 'Room 101'),
(3, 'Pediatrics',        'MBBS, DCH', 5, 20, 'Room 102'),
(4, 'Dermatology',       'MBBS, MD (Derma)', 10, 12, 'Room 103');

-- Sample patient (password: Admin@123)
INSERT INTO users (name, email, phone, password, role, gender, blood_group) VALUES
('Arjun Kumar', 'arjun@email.com', '9123456789',
 '$2a$10$Tciy8JlouOBeHouLjVlQnuf/q23AN8Jk56EWVHTIec19MfatDn3nO', 'patient', 'male', 'O+');

