const { getDb } = require('../db/init');

function logEvent(type, level, action, detail, options = {}) {
  const db = getDb();
  db.prepare(
    `INSERT INTO logs (type, level, user_id, username, action, detail, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    type,
    level,
    options.userId || null,
    options.username || null,
    action,
    detail || null,
    options.ip || null,
    options.userAgent || null
  );
}

function logSystem(action, detail) {
  logEvent('system', 'info', action, detail);
}

function logAdmin(action, detail, user, ip) {
  logEvent('admin', 'info', action, detail, {
    userId: user?.id,
    username: user?.username,
    ip,
  });
}

function logUser(action, detail, user, ip) {
  logEvent('user', 'info', action, detail, {
    userId: user?.id,
    username: user?.username,
    ip,
  });
}

function logSecurity(action, detail, level, user, ip) {
  logEvent('security', level || 'warning', action, detail, {
    userId: user?.id,
    username: user?.username,
    ip,
  });
}

module.exports = { logEvent, logSystem, logAdmin, logUser, logSecurity };
