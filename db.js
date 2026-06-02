const fs = require('fs');
const path = require('path');

let Pool;
try {
  Pool = require('pg').Pool;
} catch (e) {
  Pool = null;
}

const DATABASE_URL = process.env.DATABASE_URL;

let pool = null;
let connectedToPostgres = false;

// Fallback JSON storage setup
const dataDir = path.join(__dirname, 'data');
const filePath = path.join(dataDir, 'db.json');
function ensureDataFile() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(filePath)) {
    const base = { users: {}, profiles: {}, messages: [], tasks: [], progress: [], streaks: {} };
    fs.writeFileSync(filePath, JSON.stringify(base, null, 2));
  }
}
function load() {
  try {
    ensureDataFile();
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.error('Failed to load fallback DB file:', e);
    return { users: {}, profiles: {}, messages: [], tasks: [], progress: [], streaks: {} };
  }
}
function save(data) {
  ensureDataFile();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// Postgres helpers (if available)
function createPool() {
  if (DATABASE_URL) return new Pool({ connectionString: DATABASE_URL });
  return new Pool({
    host: process.env.PGHOST || 'localhost',
    user: process.env.PGUSER || process.env.USER,
    password: process.env.PGPASSWORD || null,
    database: process.env.PGDATABASE || 'telegram_ai_bot',
    port: process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : 5432,
  });
}

async function init() {
  if (Pool) {
    try {
      pool = createPool();
      const client = await pool.connect();
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT,
            created_at BIGINT
          );

          CREATE TABLE IF NOT EXISTS profiles (
            user_id TEXT PRIMARY KEY,
            profile_json JSONB,
            updated_at BIGINT
          );

          CREATE TABLE IF NOT EXISTS messages (
            id BIGSERIAL PRIMARY KEY,
            user_id TEXT,
            role TEXT,
            text TEXT,
            ts BIGINT
          );

          CREATE TABLE IF NOT EXISTS tasks (
            id BIGSERIAL PRIMARY KEY,
            user_id TEXT,
            title TEXT,
            category TEXT,
            estimate_min INTEGER,
            due_date BIGINT,
            completed BOOLEAN DEFAULT false,
            created_at BIGINT
          );

          CREATE TABLE IF NOT EXISTS progress (
            id BIGSERIAL PRIMARY KEY,
            user_id TEXT,
            date DATE,
            completed_count INTEGER,
            notes TEXT,
            created_at BIGINT
          );

          CREATE TABLE IF NOT EXISTS streaks (
            user_id TEXT PRIMARY KEY,
            current_streak INTEGER DEFAULT 0,
            best_streak INTEGER DEFAULT 0,
            last_active BIGINT
          );
        `);
        connectedToPostgres = true;
        return;
      } finally {
        client.release();
      }
    } catch (err) {
      console.warn('Postgres unavailable, falling back to JSON file storage:', err && err.message ? err.message : err);
      connectedToPostgres = false;
      pool = null;
    }
  }
  // ensure fallback file exists
  ensureDataFile();
}

// -- Postgres implementations --
async function pg_saveUser(userId, username) {
  const now = Date.now();
  await pool.query(
    'INSERT INTO users(id, username, created_at) VALUES($1, $2, $3) ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username',
    [userId, username || null, now]
  );
}
async function pg_saveProfile(userId, profileObj) {
  const now = Date.now();
  await pool.query(
    'INSERT INTO profiles(user_id, profile_json, updated_at) VALUES($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET profile_json = EXCLUDED.profile_json, updated_at = EXCLUDED.updated_at',
    [userId, profileObj, now]
  );
}
async function pg_getProfile(userId) {
  const res = await pool.query('SELECT profile_json FROM profiles WHERE user_id = $1', [userId]);
  return res.rows[0] ? res.rows[0].profile_json : null;
}
async function pg_saveMessage(userId, role, text) {
  const now = Date.now();
  await pool.query('INSERT INTO messages(user_id, role, text, ts) VALUES($1, $2, $3, $4)', [userId, role, text, now]);
}
async function pg_getRecentMessages(userId, limit = 40) {
  const res = await pool.query('SELECT role, text, ts FROM messages WHERE user_id = $1 ORDER BY ts DESC LIMIT $2', [userId, limit]);
  return res.rows.reverse().map(r => ({ role: r.role, text: r.text, ts: r.ts }));
}
async function pg_clearMessages(userId) {
  await pool.query('DELETE FROM messages WHERE user_id = $1', [userId]);
}
async function pg_saveTask(userId, { title, category, estimate_min, due_date }) {
  const now = Date.now();
  const res = await pool.query('INSERT INTO tasks(user_id, title, category, estimate_min, due_date, created_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', [userId, title, category || null, estimate_min || null, due_date || null, now]);
  return res.rows[0];
}
async function pg_getTasksForUser(userId, onlyPending = true) {
  if (onlyPending) {
    const res = await pool.query('SELECT id, title, category, estimate_min, due_date, completed, created_at FROM tasks WHERE user_id = $1 AND completed = false ORDER BY due_date NULLS LAST, created_at DESC', [userId]);
    return res.rows;
  }
  const res = await pool.query('SELECT id, title, category, estimate_min, due_date, completed, created_at FROM tasks WHERE user_id = $1 ORDER BY due_date NULLS LAST, created_at DESC', [userId]);
  return res.rows;
}
async function pg_updateTaskCompletion(taskId, completed = true) {
  await pool.query('UPDATE tasks SET completed = $1 WHERE id = $2', [completed, taskId]);
}
async function pg_saveProgress(userId, dateISO, completedCount, notes) {
  const now = Date.now();
  await pool.query('INSERT INTO progress(user_id, date, completed_count, notes, created_at) VALUES($1,$2,$3,$4,$5)', [userId, dateISO, completedCount, notes || null, now]);
}
async function pg_getStreak(userId) {
  const res = await pool.query('SELECT current_streak, best_streak, last_active FROM streaks WHERE user_id = $1', [userId]);
  return res.rows[0] || { current_streak: 0, best_streak: 0, last_active: null };
}
async function pg_updateStreak(userId, active = true) {
  const now = Date.now();
  const st = await pg_getStreak(userId);
  let current = st.current_streak || 0;
  let best = st.best_streak || 0;
  if (active) {
    current = (current || 0) + 1;
    if (current > best) best = current;
  } else {
    current = 0;
  }
  await pool.query('INSERT INTO streaks(user_id, current_streak, best_streak, last_active) VALUES($1,$2,$3,$4) ON CONFLICT (user_id) DO UPDATE SET current_streak = EXCLUDED.current_streak, best_streak = EXCLUDED.best_streak, last_active = EXCLUDED.last_active', [userId, current, best, now]);
}

// -- JSON fallback implementations --
async function js_saveUser(userId, username) {
  const d = load();
  d.users[userId] = { id: userId, username: username || null, created_at: Date.now() };
  save(d);
}
async function js_saveProfile(userId, profileObj) {
  const d = load();
  d.profiles[userId] = { profile: profileObj, updated_at: Date.now() };
  save(d);
}
async function js_getProfile(userId) {
  const d = load();
  return d.profiles[userId] ? d.profiles[userId].profile : null;
}
async function js_saveMessage(userId, role, text) {
  const d = load();
  d.messages.push({ user_id: userId, role, text, ts: Date.now() });
  save(d);
}
async function js_getRecentMessages(userId, limit = 40) {
  const d = load();
  const rows = d.messages.filter(m => m.user_id === userId).slice(-limit);
  return rows.map(r => ({ role: r.role, text: r.text, ts: r.ts }));
}
async function js_clearMessages(userId) {
  const d = load();
  d.messages = d.messages.filter(m => m.user_id !== userId);
  save(d);
}
async function js_saveTask(userId, { title, category, estimate_min, due_date }) {
  const d = load();
  const id = d.tasks.length ? d.tasks[d.tasks.length - 1].id + 1 : 1;
  const task = { id, user_id: userId, title, category: category || null, estimate_min: estimate_min || null, due_date: due_date || null, completed: false, created_at: Date.now() };
  d.tasks.push(task);
  save(d);
  return { id };
}
async function js_getTasksForUser(userId, onlyPending = true) {
  const d = load();
  const rows = d.tasks.filter(t => t.user_id === userId && (!onlyPending || !t.completed));
  return rows;
}
async function js_updateTaskCompletion(taskId, completed = true) {
  const d = load();
  const t = d.tasks.find(x => x.id === taskId);
  if (t) t.completed = completed;
  save(d);
}
async function js_saveProgress(userId, dateISO, completedCount, notes) {
  const d = load();
  d.progress.push({ user_id: userId, date: dateISO, completed_count: completedCount, notes: notes || null, created_at: Date.now() });
  save(d);
}
async function js_getStreak(userId) {
  const d = load();
  return d.streaks[userId] || { current_streak: 0, best_streak: 0, last_active: null };
}
async function js_updateStreak(userId, active = true) {
  const d = load();
  const s = d.streaks[userId] || { current_streak: 0, best_streak: 0, last_active: null };
  if (active) {
    s.current_streak = (s.current_streak || 0) + 1;
    s.best_streak = Math.max(s.best_streak || 0, s.current_streak);
  } else {
    s.current_streak = 0;
  }
  s.last_active = Date.now();
  d.streaks[userId] = s;
  save(d);
}

// -- get all users --
async function pg_getAllUsers() {
  const res = await pool.query('SELECT id, username FROM users');
  return res.rows.map(r => ({ id: r.id, username: r.username }));
}

async function js_getAllUsers() {
  const d = load();
  return Object.keys(d.users).map(k => ({ id: k, username: d.users[k].username || null }));
}

// -- Wrapper functions that pick the correct backend --
async function saveUser(userId, username) {
  if (connectedToPostgres) return pg_saveUser(userId, username);
  return js_saveUser(userId, username);
}
async function saveProfile(userId, profileObj) {
  if (connectedToPostgres) return pg_saveProfile(userId, profileObj);
  return js_saveProfile(userId, profileObj);
}
async function getProfile(userId) {
  if (connectedToPostgres) return pg_getProfile(userId);
  return js_getProfile(userId);
}
async function saveMessage(userId, role, text) {
  if (connectedToPostgres) return pg_saveMessage(userId, role, text);
  return js_saveMessage(userId, role, text);
}
async function getRecentMessages(userId, limit = 40) {
  if (connectedToPostgres) return pg_getRecentMessages(userId, limit);
  return js_getRecentMessages(userId, limit);
}
async function clearMessages(userId) {
  if (connectedToPostgres) return pg_clearMessages(userId);
  return js_clearMessages(userId);
}
async function saveTask(userId, taskObj) {
  if (connectedToPostgres) return pg_saveTask(userId, taskObj);
  return js_saveTask(userId, taskObj);
}
async function getTasksForUser(userId, onlyPending = true) {
  if (connectedToPostgres) return pg_getTasksForUser(userId, onlyPending);
  return js_getTasksForUser(userId, onlyPending);
}
async function updateTaskCompletion(taskId, completed = true) {
  if (connectedToPostgres) return pg_updateTaskCompletion(taskId, completed);
  return js_updateTaskCompletion(taskId, completed);
}
async function saveProgress(userId, dateISO, completedCount, notes) {
  if (connectedToPostgres) return pg_saveProgress(userId, dateISO, completedCount, notes);
  return js_saveProgress(userId, dateISO, completedCount, notes);
}
async function getStreak(userId) {
  if (connectedToPostgres) return pg_getStreak(userId);
  return js_getStreak(userId);
}
async function updateStreak(userId, active = true) {
  if (connectedToPostgres) return pg_updateStreak(userId, active);
  return js_updateStreak(userId, active);
}

async function getAllUsers() {
  if (connectedToPostgres) return pg_getAllUsers();
  return js_getAllUsers();
}

module.exports = {
  init,
  saveUser,
  saveProfile,
  getProfile,
  saveMessage,
  getRecentMessages,
  clearMessages,
  saveTask,
  getTasksForUser,
  updateTaskCompletion,
  saveProgress,
  getStreak,
  updateStreak,
  pool,
};
