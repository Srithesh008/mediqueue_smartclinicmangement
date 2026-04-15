// ============================================================
//  Smart Clinic — Shared Utilities
// ============================================================

const API_BASE = '/api';

// ── Token Management ──────────────────────────────────────
const Auth = {
  getToken:    ()    => localStorage.getItem('sc_token'),
  getUser:     ()    => { try { return JSON.parse(localStorage.getItem('sc_user')); } catch { return null; } },
  setSession:  (token, user) => { localStorage.setItem('sc_token', token); localStorage.setItem('sc_user', JSON.stringify(user)); },
  clearSession:()    => { localStorage.removeItem('sc_token'); localStorage.removeItem('sc_user'); },
  isLoggedIn:  ()    => !!localStorage.getItem('sc_token'),
  getRole:     ()    => { const u = Auth.getUser(); return u ? u.role : null; },
  requireAuth: (role) => {
    if (!Auth.isLoggedIn()) { window.location.href = '/login.html'; return false; }
    if (role && Auth.getRole() !== role) {
      Toast.show('Access denied for your role.', 'error');
      setTimeout(() => window.location.href = '/', 1500);
      return false;
    }
    return true;
  }
};

// ── API Helper ────────────────────────────────────────────
const api = {
  async request(method, endpoint, body = null, auth = true) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth) {
      const token = Auth.getToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }
    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);

    try {
      const res  = await fetch(`${API_BASE}${endpoint}`, options);
      const data = await res.json();
      if (res.status === 401 || res.status === 403) {
        Auth.clearSession();
        window.location.href = '/login.html';
        return null;
      }
      return data;
    } catch (err) {
      console.error(`API Error [${method} ${endpoint}]:`, err);
      Toast.show('Network error. Please check your connection.', 'error');
      return null;
    }
  },
  get:    (url, auth=true)       => api.request('GET', url, null, auth),
  post:   (url, body, auth=true) => api.request('POST', url, body, auth),
  put:    (url, body, auth=true) => api.request('PUT', url, body, auth),
  delete: (url, auth=true)       => api.request('DELETE', url, null, auth),
};

// ── Toast Notifications ───────────────────────────────────
const Toast = {
  container: null,
  init() {
    if (!this.container) {
      this.container = document.createElement('div');
      this.container.className = 'toast-container';
      document.body.appendChild(this.container);
    }
  },
  show(message, type = 'info', title = null, duration = 4000) {
    this.init();
    const icons = { info: 'ℹ️', success: '✅', error: '❌', warning: '⚠️' };
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
      <span class="toast-icon">${icons[type] || icons.info}</span>
      <div class="toast-text">
        ${title ? `<div class="toast-title">${title}</div>` : ''}
        <div>${message}</div>
      </div>
      <button class="toast-close" onclick="this.parentElement.remove()">✕</button>
    `;
    this.container.appendChild(toast);
    setTimeout(() => toast.style.opacity = '0', duration);
    setTimeout(() => toast.remove(), duration + 300);
  }
};

// ── DOM Helpers ───────────────────────────────────────────
const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);

function setHTML(sel, html) { const el = $(sel); if (el) el.innerHTML = html; }
function setText(sel, text) { const el = $(sel); if (el) el.textContent = text; }
function show(sel) { const el = $(sel); if (el) el.classList.remove('hidden'); }
function hide(sel) { const el = $(sel); if (el) el.classList.add('hidden'); }
function toggle(sel) { const el = $(sel); if (el) el.classList.toggle('hidden'); }

function openModal(id)  { const m = $(`#${id}`); if (m) m.classList.add('active'); }
function closeModal(id) { const m = $(`#${id}`); if (m) m.classList.remove('active'); }

// ── Format Helpers ────────────────────────────────────────
function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' });
}
function formatTime(t) {
  if (!t) return '—';
  const [h, m] = t.split(':');
  const hr = parseInt(h);
  return `${hr % 12 || 12}:${m} ${hr < 12 ? 'AM' : 'PM'}`;
}
function formatDateTime(dt) {
  if (!dt) return '—';
  return new Date(dt).toLocaleString('en-IN', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
}
function waitDisplay(min) {
  if (min <= 0) return 'Ready';
  if (min < 60) return `~${min} min`;
  return `~${Math.floor(min/60)}h ${min%60}m`;
}
function statusBadge(status) {
  const map = {
    scheduled:       'badge-primary',
    waiting:         'badge-warning',
    in_consultation: 'badge-success',
    completed:       'badge-muted',
    cancelled:       'badge-danger',
    no_show:         'badge-danger',
  };
  return `<span class="badge ${map[status] || 'badge-muted'}">${status?.replace(/_/g,' ')}</span>`;
}
function priorityBadge(p) {
  if (p === 'emergency') return `<span class="badge badge-emergency">🚨 Emergency</span>`;
  if (p === 'urgent')    return `<span class="badge badge-warning">⚡ Urgent</span>`;
  return '';
}

// ── Navbar init ───────────────────────────────────────────
function initNavbar() {
  const user = Auth.getUser();
  const navAvatar   = $('#navAvatar');
  const navUserName = $('#navUserName');
  const navAuthBtn  = $('#navAuthBtn');
  const navUserMenu = $('#navUserMenu');

  if (user && Auth.isLoggedIn()) {
    if (navAvatar)   { navAvatar.textContent = user.name?.[0]?.toUpperCase() || 'U'; show('#navAvatar'); }
    if (navUserName) navUserName.textContent = user.name;
    if (navAuthBtn)  navAuthBtn.classList.add('hidden');
    // Role-specific nav links
    const roleLinks = $$('.role-link');
    roleLinks.forEach(el => {
      if (!el.dataset.role || el.dataset.role === user.role) el.classList.remove('hidden');
      else el.classList.add('hidden');
    });
  } else {
    if (navAvatar)  navAvatar.classList.add('hidden');
    if (navAuthBtn) navAuthBtn.classList.remove('hidden');
  }

  // Avatar dropdown
  if (navAvatar && navUserMenu) {
    navAvatar.addEventListener('click', () => navUserMenu.classList.toggle('hidden'));
    document.addEventListener('click', e => {
      if (!navAvatar.contains(e.target) && !navUserMenu.contains(e.target)) {
        navUserMenu.classList.add('hidden');
      }
    });
  }

  // Logout
  const logoutBtn = $('#logoutBtn');
  if (logoutBtn) logoutBtn.addEventListener('click', () => {
    Auth.clearSession();
    window.location.href = '/';
  });
}

// ── Chatbot ───────────────────────────────────────────────
function initChatbot() {
  const toggle = $('#chatbotToggle');
  const window_ = $('#chatbotWindow');
  const input   = $('#chatInput');
  const sendBtn = $('#chatSend');
  const msgs    = $('#chatMessages');
  if (!toggle || !window_) return;

  const FAQ = [
    { q: ['book','appointment','schedule'], a: 'To book an appointment: Login → Patient Dashboard → Book Appointment. Choose your doctor, date and time slot! 🗓️' },
    { q: ['queue','waiting','position','wait'], a: 'You can see your live queue position on your Patient Dashboard. The system updates in real-time! 📊' },
    { q: ['cancel','reschedule'], a: 'To cancel/reschedule: Go to My Appointments → Find your booking → Click Cancel or Reschedule.' },
    { q: ['emergency'], a: 'For emergencies, inform the clinic reception immediately. The doctor can mark you as emergency priority to move you to top of queue. 🚨' },
    { q: ['family'], a: 'Yes! You can book for your family members. After registration, add family members in your Profile, then select them while booking. 👨‍👩‍👧' },
    { q: ['doctor','specialist'], a: 'We have specialists in General Medicine, Pediatrics, and Dermatology. Check the Book Appointment page to see all available doctors!' },
    { q: ['hours','timing','open'], a: 'Clinic hours: 9:00 AM – 6:00 PM, Monday to Saturday. 🕘' },
    { q: ['token','number'], a: 'Your token number is assigned when you book. You can see it on your appointment confirmation and dashboard.' },
    { q: ['hello','hi','hey'], a: 'Hello! 👋 I\'m the SmartCare assistant. I can help you with bookings, queue info, and FAQs. What do you need?' },
  ];

  function addMsg(text, from = 'bot') {
    const div = document.createElement('div');
    div.className = `chat-msg ${from}`;
    div.textContent = text;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function respond(msg) {
    const lower = msg.toLowerCase();
    for (const item of FAQ) {
      if (item.q.some(k => lower.includes(k))) {
        setTimeout(() => addMsg(item.a, 'bot'), 600);
        return;
      }
    }
    setTimeout(() => addMsg('I\'m not sure about that. Please contact our reception or check the Help section. 😊', 'bot'), 600);
  }

  toggle.addEventListener('click', () => { window_.classList.toggle('open'); if (msgs.children.length === 0) addMsg('Hi! 👋 I\'m SmartCare Assistant. How can I help you today?', 'bot'); });
  sendBtn.addEventListener('click', () => { const t = input.value.trim(); if (!t) return; addMsg(t, 'user'); input.value = ''; respond(t); });
  input.addEventListener('keypress', e => { if (e.key === 'Enter') sendBtn.click(); });
}

// ── Init on DOMContentLoaded ──────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initNavbar();
  initChatbot();
});
