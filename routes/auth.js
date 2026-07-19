const { Router } = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { getDb } = require('../db/init');
const { signToken, setTokenCookie, clearTokenCookie, requireAuth } = require('../middleware/auth');
const config = require('../config');
const { sendMail, maskEmail } = require('../utils/mailer');
const { generateCode, canSendCode, storeCode, verifyCode } = require('../utils/code-utils');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const avatarDir = path.join(__dirname, '..', 'public', 'uploads', 'avatars');
if (!fs.existsSync(avatarDir)) { fs.mkdirSync(avatarDir, { recursive: true }); }

const avatarStorage = multer.diskStorage({
  destination: avatarDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, 'avatar_' + Date.now() + ext);
  },
});

const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

const router = Router();

// ─── 限流 ───
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '请求过于频繁，请稍后再试' },
});

// 验证码发送限流：每分钟 6 次
const codeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '验证码发送过于频繁，请稍后再试' },
});

// 找回密码限流：每分钟 5 次
const resetLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '找回密码请求过于频繁，请稍后再试' },
});

// ─── 校验规则 ───
const registerRules = [
  body('username')
    .trim().isLength({ min: 3, max: 20 }).withMessage('用户名为 3-20 个字符')
    .matches(/^[\w\u4e00-\u9fa5]+$/).withMessage('用户名只能包含字母、数字、下划线和中文'),
  body('password').isLength({ min: 6, max: 32 }).withMessage('密码为 6-32 个字符'),
  body('email').trim().isEmail().withMessage('请输入有效的邮箱地址'),
];

const loginRules = [
  body('username').trim().notEmpty().withMessage('请输入用户名'),
  body('password').notEmpty().withMessage('请输入密码'),
];

const emailRule = [
  body('email').trim().isEmail().withMessage('请输入有效的邮箱地址'),
];

// ─── 辅助函数 ───
function emailError(res, message) {
  return res.status(422).json({ error: message });
}

// ═══════════════════════════════════════════════════════════════
// 验证码发送
// ═══════════════════════════════════════════════════════════════

// POST /api/auth/send-code
// body: { email, purpose: 'register'|'reset_password'|'change_email' }
// register/reset_password 不需要登录，change_email 需要登录
router.post('/send-code', codeLimiter, emailRule, (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return emailError(res, errors.array()[0].msg);

  const email = req.body.email.trim().toLowerCase();
  const purpose = req.body.purpose;

  if (!['register', 'reset_password', 'change_email'].includes(purpose)) {
    return emailError(res, '无效的验证码用途');
  }

  const db = getDb();
  const ip = req.ip;

  // change_email 需要登录
  if (purpose === 'change_email') {
    if (!req.user) return res.status(401).json({ error: '请先登录' });
    // 检查新邮箱是否已被其他用户占用
    const dup = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, req.user.id);
    if (dup) return emailError(res, '该邮箱已被其他用户绑定');
  }

  // register: 检查邮箱是否已注册（枚举防护：统一返回消息）
  if (purpose === 'register' && db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    return res.json({ message: '如果该邮箱可用，验证码已发送' });
  }

  // reset_password: 检查邮箱是否已注册（内部判断，不暴露）
  if (purpose === 'reset_password') {
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (!existing) {
      return res.json({ message: '如果该邮箱已注册，验证码已发送' });
    }
  }

  // 频率限制检查
  const limit = canSendCode(email, purpose, ip);
  if (!limit.ok) return emailError(res, limit.error);

  // 生成并存储验证码
  const code = generateCode();
  const userId = req.user ? req.user.id : null;
  storeCode(email, code, purpose, userId, ip);

  // 发送邮件
  const subjectMap = {
    register: '注册验证码',
    reset_password: '找回密码验证码',
    change_email: '修改邮箱验证码',
  };

  sendMail(email, `[论坛] ${subjectMap[purpose]}`, `
    <div style="max-width:480px;margin:0 auto;font-family:Arial,sans-serif">
      <h2 style="color:#7c3aed">MonkeyCode 社区</h2>
      <p>您的验证码是：</p>
      <p style="font-size:32px;font-weight:700;color:#7c3aed;letter-spacing:4px">${code}</p>
      <p style="color:#787570;font-size:13px">有效期 ${require('../utils/code-utils').CODE_EXPIRE_MINUTES} 分钟，请勿泄露给他人。</p>
      <hr style="border:0;border-top:1px solid #e8e4db;margin:20px 0">
      <p style="color:#a8a39a;font-size:11px">如果这不是您本人的操作，请忽略此邮件。</p>
    </div>
  `);

  console.log(`[Auth] 验证码已发送 → ${maskEmail(email)} (${purpose})`);
  res.json({ message: purpose === 'register' ? '如果该邮箱可用，验证码已发送' : '验证码已发送' });
});

// ═══════════════════════════════════════════════════════════════
// 验证码校验（通用）
// ═══════════════════════════════════════════════════════════════

// POST /api/auth/verify-code
// body: { email, code, purpose }
router.post('/verify-code', (req, res) => {
  const { email, code, purpose } = req.body;
  if (!email || !code || !purpose) {
    return emailError(res, '缺少必要参数');
  }

  const result = verifyCode(email.trim(), code.trim(), purpose);
  if (!result.ok) {
    return emailError(res, result.error);
  }
  res.json({ message: '验证通过' });
});

// ═══════════════════════════════════════════════════════════════
// 注册（需邮箱验证码）
// ═══════════════════════════════════════════════════════════════

router.post('/register', authLimiter, registerRules, (req, res) => {
  if (!config.getBoolean('enable_register')) {
    return res.status(403).json({ error: '注册功能已关闭' });
  }
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ error: errors.array()[0].msg });
  }

  const db = getDb();
  const { username, password, email, code } = req.body;

  // 1) 验证验证码
  const vResult = verifyCode(email.trim(), code ? code.trim() : '', 'register');
  if (!vResult.ok) {
    return res.status(422).json({ error: vResult.error });
  }

  // 2) 检查邮箱是否已被注册（再次确认）
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email.trim().toLowerCase())) {
    return res.status(409).json({ error: '该邮箱已被注册' });
  }

  // 3) 检查用户名
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return res.status(409).json({ error: '用户名已被占用' });
  }

  // 4) 创建用户
  const passwordHash = bcrypt.hashSync(password, 10);
  const result = db.prepare(
    'INSERT INTO users (username, password_hash, nickname, email) VALUES (?, ?, ?, ?)'
  ).run(username, passwordHash, username, email.trim().toLowerCase());

  const user = db.prepare(
    'SELECT id, username, nickname, email, avatar, bio, role, email_notify, created_at FROM users WHERE id = ?'
  ).get(result.lastInsertRowid);

  const token = signToken({ id: user.id, username: user.username, role: user.role }, 1);
  setTokenCookie(res, token);

  console.log(`[Auth] 新用户注册: ${username} (${maskEmail(email)})`);
  res.status(201).json({ user });
});

// ═══════════════════════════════════════════════════════════════
// 登录 & 登出
// ═══════════════════════════════════════════════════════════════

router.post('/login', authLimiter, loginRules, (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ error: errors.array()[0].msg });
  }

  const db = getDb();
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  const token = signToken({ id: user.id, username: user.username, role: user.role }, user.token_version);
  setTokenCookie(res, token);

  const { password_hash, ...safeUser } = user;
  res.json({ user: safeUser });
});

router.post('/logout', (req, res) => {
  clearTokenCookie(res);
  res.json({ message: '已退出登录' });
});

// ═══════════════════════════════════════════════════════════════
// 个人信息
// ═══════════════════════════════════════════════════════════════

router.get('/me', requireAuth, (req, res) => {
  const db = getDb();
  const user = db.prepare(
    'SELECT id, username, nickname, email, avatar, bio, role, email_notify, created_at FROM users WHERE id = ?'
  ).get(req.user.id);

  if (!user) {
    clearTokenCookie(res);
    return res.status(401).json({ error: '用户不存在' });
  }

  res.json({ user });
});

router.put('/profile', requireAuth, (req, res) => {
  const db = getDb();
  const { avatar, bio, nickname } = req.body;
  const updates = [];
  const params = [];

  if (nickname !== undefined) {
    const trimmed = String(nickname).trim();
    if (trimmed.length === 0) return res.status(422).json({ error: '昵称不能为空' });
    if (trimmed.length > 20) return res.status(422).json({ error: '昵称最多 20 个字符' });
    updates.push('nickname = ?');
    params.push(trimmed);
  }
  if (avatar !== undefined) {
    updates.push('avatar = ?');
    params.push(String(avatar).trim());
  }
  if (bio !== undefined) {
    updates.push('bio = ?');
    params.push(String(bio).trim());
  }
  if (updates.length === 0) return res.status(400).json({ error: '没有要更新的字段' });

  updates.push("updated_at = datetime('now','localtime')");
  params.push(req.user.id);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const user = db.prepare(
    'SELECT id, username, nickname, email, avatar, bio, role, email_notify, created_at FROM users WHERE id = ?'
  ).get(req.user.id);

  res.json({ user });
});

// ═══════════════════════════════════════════════════════════════
// 修改邮箱（两阶段：发验证码到新邮箱 → 验证后生效）
// ═══════════════════════════════════════════════════════════════

router.put('/email', requireAuth, emailRule, (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return emailError(res, errors.array()[0].msg);

  const newEmail = req.body.email.trim().toLowerCase();
  const code = req.body.code;

  if (!code) {
    return emailError(res, '请先验证新邮箱：调用 POST /api/auth/send-code (purpose=change_email) 获取验证码');
  }

  // 验证验证码
  const vResult = verifyCode(newEmail, code.trim(), 'change_email');
  if (!vResult.ok) return emailError(res, vResult.error);

  const db = getDb();

  // 检查新邮箱是否已被占用
  const dup = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(newEmail, req.user.id);
  if (dup) return emailError(res, '该邮箱已被其他用户绑定');

  // 获取旧邮箱（用于通知）
  const oldUser = db.prepare('SELECT email FROM users WHERE id = ?').get(req.user.id);
  const oldEmail = oldUser ? oldUser.email : '';

  // 更新
  db.prepare("UPDATE users SET email = ?, updated_at = datetime('now','localtime') WHERE id = ?")
    .run(newEmail, req.user.id);

  console.log(`[Auth] 邮箱已更改: user=${req.user.id} ${maskEmail(oldEmail)} → ${maskEmail(newEmail)}`);

  // 通知旧邮箱
  if (oldEmail && oldEmail !== newEmail) {
    sendMail(oldEmail, '[论坛] 邮箱变更通知', `
      <div style="max-width:480px;margin:0 auto;font-family:Arial,sans-serif">
        <h2 style="color:#7c3aed">MonkeyCode 社区</h2>
        <p>您的账号邮箱已被更改为：<strong>${maskEmail(newEmail)}</strong></p>
        <p style="color:#dc2626">如果这不是您本人的操作，请立即修改密码并联系管理员。</p>
      </div>
    `);
  }

  const user = db.prepare(
    'SELECT id, username, nickname, email, avatar, bio, role, email_notify, created_at FROM users WHERE id = ?'
  ).get(req.user.id);

  res.json({ user });
});

// ═══════════════════════════════════════════════════════════════
// 找回密码（两阶段：验证码 → 重置 token）
// ═══════════════════════════════════════════════════════════════

// POST /api/auth/reset-password-request
router.post('/reset-password-request', resetLimiter, emailRule, (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return emailError(res, errors.array()[0].msg);

  const email = req.body.email.trim().toLowerCase();
  const db = getDb();

  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);

  // 不管邮箱是否存在，统一返回
  if (!user) {
    return res.json({ message: '如果该邮箱已注册，验证码已发送' });
  }

  const ip = req.ip;
  const limit = canSendCode(email, 'reset_password', ip);
  if (!limit.ok) return emailError(res, limit.error);

  const code = generateCode();
  storeCode(email, code, 'reset_password', user.id, ip);

  sendMail(email, '[论坛] 找回密码验证码', `
    <div style="max-width:480px;margin:0 auto;font-family:Arial,sans-serif">
      <h2 style="color:#7c3aed">MonkeyCode 社区</h2>
      <p>您正在找回密码，验证码是：</p>
      <p style="font-size:32px;font-weight:700;color:#7c3aed;letter-spacing:4px">${code}</p>
      <p style="color:#787570;font-size:13px">有效期 ${require('../utils/code-utils').CODE_EXPIRE_MINUTES} 分钟。</p>
      <hr style="border:0;border-top:1px solid #e8e4db;margin:20px 0">
      <p style="color:#a8a39a;font-size:11px">如果这不是您本人的操作，请忽略此邮件。</p>
    </div>
  `);

  res.json({ message: '如果该邮箱已注册，验证码已发送' });
});

// POST /api/auth/reset-password-confirm
router.post('/reset-password-confirm', (req, res) => {
  const db = getDb();
  const { email, code, newPassword } = req.body;

  if (!email || !code || !newPassword) return emailError(res, '缺少必要参数');
  if (newPassword.length < 6 || newPassword.length > 32) return emailError(res, '密码为 6-32 个字符');

  const emailLower = email.trim().toLowerCase();

  // 验证验证码
  const vResult = verifyCode(emailLower, code.trim(), 'reset_password');
  if (!vResult.ok) return emailError(res, vResult.error);

  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(emailLower);
  if (!user) return emailError(res, '用户不存在');

  // 生成一次性重置 token
  const resetToken = crypto.randomBytes(16).toString('hex');
  const tokenExpire = new Date(Date.now() + 15 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);

  // 将 token 和过期时间存储到 verification_codes 表（复用 purpose='reset_token'）
  db.prepare(
    `INSERT INTO verification_codes (email, code, purpose, user_id, expires_at)
     VALUES (?, ?, 'reset_token', ?, ?)`
  ).run(emailLower, resetToken, user.id, tokenExpire);

  // 更新密码 + 递增 token_version 使旧 token 失效
  const passwordHash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?')
    .run(passwordHash, user.id);

  console.log(`[Auth] 密码已重置: user=${user.id} (${maskEmail(emailLower)})`);

  res.json({ message: '密码已重置，请使用新密码登录' });
});

// ═══════════════════════════════════════════════════════════════
// 修改密码
// ═══════════════════════════════════════════════════════════════

router.put('/password', requireAuth, (req, res) => {
  const db = getDb();
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(422).json({ error: '请填写当前密码和新密码' });
  }
  if (newPassword.length < 6 || newPassword.length > 32) {
    return res.status(422).json({ error: '新密码为 6-32 个字符' });
  }

  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(400).json({ error: '当前密码错误' });
  }

  const passwordHash = bcrypt.hashSync(newPassword, 10);
  db.prepare("UPDATE users SET password_hash = ?, token_version = token_version + 1, updated_at = datetime('now','localtime') WHERE id = ?")
    .run(passwordHash, req.user.id);

  console.log(`[Auth] 密码已修改（版本递增）: user=${req.user.id} (${req.user.username})`);
  res.json({ message: '密码已修改' });
});

// ═══════════════════════════════════════════════════════════════
// 通知偏好设置
// ═══════════════════════════════════════════════════════════════

router.put('/settings', requireAuth, (req, res) => {
  const db = getDb();
  const { email_notify } = req.body;

  if (email_notify !== undefined) {
    const val = email_notify ? 1 : 0;
    db.prepare("UPDATE users SET email_notify = ?, updated_at = datetime('now','localtime') WHERE id = ?")
      .run(val, req.user.id);
  }

  const user = db.prepare(
    'SELECT id, username, nickname, email, avatar, bio, role, email_notify, created_at FROM users WHERE id = ?'
  ).get(req.user.id);

  res.json({ user });
});

router.post('/avatar/upload', requireAuth, avatarUpload.single('avatar'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '请选择图片文件（支持 PNG/JPG/GIF/WebP，最大 2MB）' });
  }
  const url = '/uploads/avatars/' + req.file.filename;
  res.json({ url });
});

router.post('/avatar/qq', requireAuth, (req, res) => {
  const qq = String(req.body.qq || '').trim();
  if (!qq || !/^\d{5,11}$/.test(qq)) {
    return res.status(422).json({ error: 'QQ号格式不正确（5-11位纯数字）' });
  }
  const avatarUrl = 'https://q1.qlogo.cn/g?b=qq&nk=' + qq + '&s=100';
  res.json({ url: avatarUrl });
});

module.exports = router;
