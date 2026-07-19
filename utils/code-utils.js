/**
 * 验证码工具 — 生成、验证、频率限制
 */
const { getDb } = require('../db/init');

/** 配置常量 */
const CODE_LENGTH = 6;
const CODE_EXPIRE_MINUTES = 10;
const SEND_INTERVAL_SECONDS = 60;        // 同邮箱同用途最小发送间隔
const IP_HOURLY_LIMIT = 20;              // 同 IP 每小时最大发送次数
const MAX_VERIFY_ATTEMPTS = 5;          // 验证码最多尝试验证次数

/**
 * 生成 6 位数字验证码
 */
function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/**
 * 检查是否可以发送验证码（频率限制）
 * @returns {{ ok: boolean, error?: string }}
 */
function canSendCode(email, purpose, ip) {
  const db = getDb();

  // 1) 同邮箱同用途 60 秒间隔
  const recent = db.prepare(
    `SELECT created_at FROM verification_codes
     WHERE email = ? AND purpose = ? AND created_at > datetime('now', 'localtime', ?)
     ORDER BY created_at DESC LIMIT 1`
  ).get(email, purpose, `-${SEND_INTERVAL_SECONDS} seconds`);

  if (recent) {
    return { ok: false, error: `发送过于频繁，请 ${SEND_INTERVAL_SECONDS} 秒后再试` };
  }

  // 2) 同 IP 每小时上限
  const ipCount = db.prepare(
    `SELECT COUNT(*) AS cnt FROM verification_codes
     WHERE ip = ? AND created_at > datetime('now', 'localtime', '-1 hours')`
  ).get(ip);

  if (ipCount && ipCount.cnt >= IP_HOURLY_LIMIT) {
    return { ok: false, error: '发送次数过多，请稍后再试' };
  }

  return { ok: true };
}

/**
 * 存储验证码到数据库
 */
function storeCode(email, code, purpose, userId, ip) {
  const db = getDb();
  const expiresAt = new Date(Date.now() + CODE_EXPIRE_MINUTES * 60 * 1000)
    .toISOString().replace('T', ' ').substring(0, 19);

  db.prepare(
    `INSERT INTO verification_codes (email, code, purpose, user_id, expires_at, ip)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(email, code, purpose, userId || null, expiresAt, ip || '');
}

/**
 * 验证验证码
 * @param {string} email   邮箱
 * @param {string} code    用户输入的验证码
 * @param {string} purpose 用途
 * @returns {{ ok: boolean, error?: string }}
 */
function verifyCode(email, code, purpose) {
  const db = getDb();
  const emailLower = email.toLowerCase();

  // 查找最新一条匹配的有效验证码
  const record = db.prepare(
    `SELECT * FROM verification_codes
     WHERE LOWER(email) = ? AND purpose = ? AND used = 0
       AND expires_at > datetime('now', 'localtime')
     ORDER BY created_at DESC LIMIT 1`
  ).get(emailLower, purpose);

  if (!record) {
    return { ok: false, error: '验证码已过期或不存在，请重新发送' };
  }

  if (record.code !== code) {
    // 递增尝试次数
    const newAttempts = (record.attempts || 0) + 1;
    db.prepare('UPDATE verification_codes SET attempts = ? WHERE id = ?').run(newAttempts, record.id);

    if (newAttempts >= MAX_VERIFY_ATTEMPTS) {
      db.prepare('UPDATE verification_codes SET used = 1 WHERE id = ?').run(record.id);
      return { ok: false, error: '验证码尝试次数过多，已作废，请重新发送' };
    }

    const remain = MAX_VERIFY_ATTEMPTS - newAttempts;
    return { ok: false, error: `验证码错误，还剩 ${remain} 次机会` };
  }

  // 标记已使用
  db.prepare('UPDATE verification_codes SET used = 1 WHERE id = ?').run(record.id);
  return { ok: true, record };
}

module.exports = {
  generateCode,
  canSendCode,
  storeCode,
  verifyCode,
  CODE_EXPIRE_MINUTES,
  SEND_INTERVAL_SECONDS,
  IP_HOURLY_LIMIT,
};
