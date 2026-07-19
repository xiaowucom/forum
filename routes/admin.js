const { Router } = require('express');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../db/init');
const { requireAdmin } = require('../middleware/auth');
const config = require('../config');

const router = Router();

// GET /api/admin/stats — 仪表盘统计
router.get('/stats', requireAdmin, (req, res) => {
  const db = getDb();

  const userCount = db.prepare('SELECT COUNT(*) AS cnt FROM users').get().cnt;
  const topicCount = db.prepare('SELECT COUNT(*) AS cnt FROM topics').get().cnt;
  const replyCount = db.prepare('SELECT COUNT(*) AS cnt FROM replies').get().cnt;
  const categoryCount = db.prepare('SELECT COUNT(*) AS cnt FROM categories').get().cnt;

  res.json({
    stats: {
      user_count: userCount,
      topic_count: topicCount,
      reply_count: replyCount,
      category_count: categoryCount,
    },
  });
});

// GET /api/admin/users — 用户列表（分页 + 搜索）
router.get('/users', requireAdmin, (req, res) => {
  const db = getDb();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize) || config.getNumber('page_size', 20)));
  const offset = (page - 1) * pageSize;
  const { search } = req.query;

  let where = 'WHERE 1=1';
  const params = [];

  if (search && search.trim()) {
    where += ' AND username LIKE ?';
    params.push('%' + search.trim() + '%');
  }

  const countRow = db.prepare(
    `SELECT COUNT(*) AS total FROM users ${where}`
  ).get(...params);

  const users = db.prepare(
    `SELECT id, username, nickname, email, avatar, role, created_at FROM users ${where}
     ORDER BY id ASC LIMIT ? OFFSET ?`
  ).all(...params, pageSize, offset);

  res.json({
    users,
    total: countRow.total,
    page,
    pageSize,
    totalPages: Math.ceil(countRow.total / pageSize),
  });
});

// POST /api/admin/messages — 发送系统消息

// PUT /api/admin/users/:id/role — 修改用户角色
router.put('/users/:id/role', requireAdmin, (req, res) => {
  const db = getDb();
  const { id } = req.params;
  const { role } = req.body;

  if (!['user', 'admin'].includes(role)) {
    return res.status(422).json({ error: '无效的角色' });
  }

  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(id);
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }

  // 不允许修改自己的角色
  if (Number(id) === req.user.id) {
    return res.status(400).json({ error: '不能修改自己的角色' });
  }

  // 将管理员降级为普通用户时，确保系统内至少还有一个管理员
  if (user.role === 'admin' && role === 'user') {
    const adminCount = db.prepare('SELECT COUNT(*) AS cnt FROM users WHERE role = ?').get('admin').cnt;
    if (adminCount <= 1) {
      return res.status(400).json({ error: '系统至少需要保留一个管理员' });
    }
  }

  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, Number(id));
  res.json({ message: '角色已更新' });
});

// POST /api/admin/messages — 发送系统消息
const messageRules = [
  body('title').trim().isLength({ min: 1, max: 100 }).withMessage('标题为 1-100 个字符'),
  body('content').trim().isLength({ min: 1, max: 2000 }).withMessage('内容为 1-2000 个字符'),
  body('target').isIn(['all', 'user']).withMessage('发送对象无效'),
];

router.post('/messages', requireAdmin, messageRules, (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ error: errors.array()[0].msg });
  }

  const db = getDb();
  const { title, content, target, user_id } = req.body;
  const trimmedTitle = title.trim();
  const trimmedContent = content.trim();

  if (target === 'all') {
    db.prepare(
      `INSERT INTO notifications (user_id, type, title, content, actor_id)
       SELECT u.id, 'system', ?, ?, ?
       FROM users u`
    ).run(trimmedTitle, trimmedContent, req.user.id);
    return res.json({ message: '已发送给全部用户', count: db.changes });
  }

  if (target === 'user') {
    const uid = parseInt(user_id);
    if (!uid || uid < 1) {
      return res.status(422).json({ error: '请指定用户' });
    }
    const targetUser = db.prepare('SELECT id FROM users WHERE id = ?').get(uid);
    if (!targetUser) {
      return res.status(404).json({ error: '用户不存在' });
    }
    db.prepare(
      'INSERT INTO notifications (user_id, type, title, content, actor_id) VALUES (?, ?, ?, ?, ?)'
    ).run(uid, 'system', trimmedTitle, trimmedContent, req.user.id);
    return res.json({ message: '已发送' });
  }
});

// GET /api/admin/messages/history — 系统消息发送记录（去重）
router.get('/messages/history', requireAdmin, (req, res) => {
  const db = getDb();
  const totalUsers = db.prepare('SELECT COUNT(*) AS cnt FROM users').get().cnt;
  const records = db.prepare(
    `SELECT n.title, n.content, n.created_at, n.actor_id,
            COUNT(*) as recipient_count,
            u.username as admin_name, u.nickname as admin_nickname
     FROM notifications n
     LEFT JOIN users u ON n.actor_id = u.id
     WHERE n.type = 'system'
     GROUP BY n.title, n.content, n.created_at, n.actor_id
     ORDER BY n.created_at DESC
     LIMIT 50`
  ).all();

  res.json({ records, total_users: totalUsers });
});

// GET /api/admin/topics — 帖子管理列表（分页 + 版块筛选 + 搜索）
router.get('/topics', requireAdmin, (req, res) => {
  const db = getDb();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize) || config.getNumber('page_size', 20)));
  const offset = (page - 1) * pageSize;
  const { category_id, search } = req.query;

  let where = 'WHERE 1=1';
  const params = [];

  if (category_id) {
    where += ' AND t.category_id = ?';
    params.push(Number(category_id));
  }
  if (search && search.trim()) {
    where += ' AND t.title LIKE ?';
    params.push('%' + search.trim() + '%');
  }

  const countRow = db.prepare(
    `SELECT COUNT(*) AS total FROM topics t ${where}`
  ).get(...params);

  const topics = db.prepare(
    `SELECT t.id, t.title, t.category_id, t.is_pinned, t.is_essence,
            t.reply_count, t.view_count, t.like_count,
            t.created_at, t.updated_at,
            u.username, u.nickname, u.id AS author_user_id,
            c.name AS category_name
     FROM topics t
     LEFT JOIN users u ON t.user_id = u.id
     LEFT JOIN categories c ON t.category_id = c.id
     ${where}
     ORDER BY t.is_pinned DESC, t.updated_at DESC
     LIMIT ? OFFSET ?`
  ).all(...params, pageSize, offset);

  res.json({
    topics,
    total: countRow.total,
    page,
    pageSize,
    totalPages: Math.ceil(countRow.total / pageSize),
  });
});

// GET /api/admin/settings — 获取全部配置
router.get('/settings', requireAdmin, (req, res) => {
  res.json({ settings: config.getAllSettings(), types: config.getTypes() });
});

// PUT /api/admin/settings — 批量更新配置
router.put('/settings', requireAdmin, (req, res) => {
  const ALLOWED_KEYS = config.getAllowedKeys();
  const TYPES = config.getTypes();

  // Step 1 — 白名单检查
  const inputKeys = Object.keys(req.body);
  for (const key of inputKeys) {
    if (!ALLOWED_KEYS.includes(key)) {
      return res.status(400).json({ error: '未知配置项: ' + key });
    }
  }

  // Step 2 — 逐项类型校验
  for (const key of inputKeys) {
    const raw = req.body[key];
    const type = TYPES[key];

    if (type === 'boolean') {
      if (raw !== 'true' && raw !== 'false') {
        return res.status(400).json({ error: key + ' 必须为 "true" 或 "false"' });
      }
    } else if (type === 'number') {
      const n = parseInt(raw, 10);
      if (isNaN(n) || String(n) !== String(raw)) {
        return res.status(400).json({ error: key + ' 必须为整数' });
      }
      if (key === 'page_size' && (n < 5 || n > 100)) {
        return res.status(400).json({ error: 'page_size 必须在 5-100 之间' });
      }
    } else if (type === 'string') {
      const s = String(raw);
      if (key === 'site_name' && (!s.trim() || s.trim().length > 50)) {
        return res.status(400).json({ error: '网站名称必须为 1-50 个字符' });
      }
      if (key === 'site_logo' && s.length > 500) {
        return res.status(400).json({ error: 'Logo 路径最长 500 个字符' });
      }
      if ((key === 'site_description' || key === 'footer_text') && s.length > 200) {
        return res.status(400).json({ error: key + ' 最长 200 个字符' });
      }
    }
  }

  // Step 3 — 事务写入
  const db = getDb();
  try {
    const applyUpdates = db.transaction((updates) => {
      const stmt = db.prepare(
        "UPDATE settings SET value = ?, updated_at = datetime('now','localtime') WHERE key = ?"
      );
      for (const [key, value] of Object.entries(updates)) {
        stmt.run(String(value), key);
      }
    });
    applyUpdates(req.body);
  } catch (err) {
    return res.status(500).json({ error: '保存失败，请重试' });
  }

  // Step 4 — 重载内存
  config.reloadSettings();

  // Step 5 — 返回
  res.json({ message: '设置已保存', settings: config.getAllSettings() });
});

// GET /api/admin/stats/charts — 图表统计数据
router.get('/stats/charts', requireAdmin, (req, res) => {
  const db = getDb();

  // 近7天日期列表
  const dates = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dates.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'));
  }

  // 每日发帖
  const dailyTopics = db.prepare(
    `SELECT SUBSTR(created_at, 1, 10) AS dt, COUNT(*) AS cnt
     FROM topics WHERE created_at >= ? GROUP BY dt ORDER BY dt`
  ).all(dates[0]);
  const topicMap = {};
  dailyTopics.forEach(r => { topicMap[r.dt] = r.cnt; });

  // 每日回复
  const dailyReplies = db.prepare(
    `SELECT SUBSTR(created_at, 1, 10) AS dt, COUNT(*) AS cnt
     FROM replies WHERE created_at >= ? GROUP BY dt ORDER BY dt`
  ).all(dates[0]);
  const replyMap = {};
  dailyReplies.forEach(r => { replyMap[r.dt] = r.cnt; });

  // 每日注册
  const dailyRegs = db.prepare(
    `SELECT SUBSTR(created_at, 1, 10) AS dt, COUNT(*) AS cnt
     FROM users WHERE created_at >= ? GROUP BY dt ORDER BY dt`
  ).all(dates[0]);
  const regMap = {};
  dailyRegs.forEach(r => { regMap[r.dt] = r.cnt; });

  const daily = dates.map(d => ({
    date: d.substring(5),
    topics: topicMap[d] || 0,
    replies: replyMap[d] || 0,
    registrations: regMap[d] || 0,
  }));

  // 热门版块
  const popularCategories = db.prepare(
    `SELECT c.name, COUNT(t.id) AS topic_count
     FROM categories c LEFT JOIN topics t ON t.category_id = c.id
     GROUP BY c.id ORDER BY topic_count DESC LIMIT 5`
  ).all();

  // 热门作者
  const popularAuthors = db.prepare(
    `SELECT u.username, u.nickname, COUNT(t.id) AS topic_count
     FROM users u INNER JOIN topics t ON t.user_id = u.id
     WHERE t.user_id IS NOT NULL
     GROUP BY u.id ORDER BY topic_count DESC LIMIT 5`
  ).all();

  // 热门帖子
  const popularTopics = db.prepare(
    `SELECT t.id, t.title, t.reply_count, t.view_count
     FROM topics t ORDER BY t.reply_count DESC LIMIT 5`
  ).all();

  res.json({ daily, popularCategories, popularAuthors, popularTopics });
});

// DELETE /api/admin/users/:id — 删除用户
router.delete('/users/:id', requireAdmin, (req, res) => {
  const db = getDb();
  const { id } = req.params;

  if (Number(id) === req.user.id) {
    return res.status(400).json({ error: '不能删除自己' });
  }

  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(Number(id));
  // ON DELETE SET NULL: 帖子/回复保留，user_id 置 NULL
  // ON DELETE CASCADE: 点赞记录被清理
  res.json({ message: '用户已删除' });
});

// PUT /api/admin/users/:id/unbind-email — 解绑用户邮箱
router.put('/users/:id/unbind-email', requireAdmin, (req, res) => {
  const db = getDb();
  const { id } = req.params;

  const user = db.prepare('SELECT id, username, email FROM users WHERE id = ?').get(id);
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }

  if (!user.email) {
    return res.status(400).json({ error: '该用户尚未绑定邮箱' });
  }

  db.prepare("UPDATE users SET email = '', updated_at = datetime('now','localtime') WHERE id = ?").run(Number(id));

  const { maskEmail } = require('../utils/mailer');
  console.log(`[Admin] 管理员解绑了用户 ${user.username} 的邮箱: ${maskEmail(user.email)}`);

  try {
    const { logAdmin } = require('../utils/logger');
    logAdmin('解绑用户邮箱', `用户: ${user.username}`, req.user, req.ip);
  } catch (e) {}

  res.json({ message: '邮箱已解绑' });
});

// POST /api/admin/users/:id/send-reset — 管理员触发向用户发送密码重置邮件
router.post('/users/:id/send-reset', requireAdmin, (req, res) => {
  const db = getDb();
  const { id } = req.params;

  const user = db.prepare('SELECT id, username, email FROM users WHERE id = ?').get(id);
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }

  if (!user.email) {
    return res.status(400).json({ error: '该用户未绑定邮箱，无法发送' });
  }

  const { generateCode, canSendCode, storeCode, CODE_EXPIRE_MINUTES } = require('../utils/code-utils');
  const { sendMail, maskEmail } = require('../utils/mailer');

  // 频率限制
  const limit = canSendCode(user.email, 'reset_password', req.ip);
  if (!limit.ok) {
    return res.status(422).json({ error: limit.error });
  }

  // 生成并存储验证码
  const code = generateCode();
  storeCode(user.email, code, 'reset_password', user.id, req.ip);

  // 发送邮件
  sendMail(user.email, '[论坛] 密码重置（管理员发起）', `
    <div style="max-width:480px;margin:0 auto;font-family:Arial,sans-serif">
      <h2 style="color:#7c3aed">MonkeyCode 社区</h2>
      <p>管理员为您发起了密码重置，您的验证码是：</p>
      <p style="font-size:32px;font-weight:700;color:#7c3aed;letter-spacing:4px">${code}</p>
      <p style="color:#787570;font-size:13px">有效期 ${CODE_EXPIRE_MINUTES} 分钟，请勿泄露给他人。</p>
      <hr style="border:0;border-top:1px solid #e8e4db;margin:20px 0">
      <p style="color:#a8a39a;font-size:11px">如果这不是您本人的操作，请联系管理员。</p>
    </div>
  `);

  const masked = maskEmail(user.email);
  console.log(`[Admin] 管理员为 ${user.username} 发送了密码重置邮件 → ${masked}`);

  try {
    const { logAdmin } = require('../utils/logger');
    logAdmin('发送重置密码邮件', `用户: ${user.username} (${masked})`, req.user, req.ip);
  } catch (e) {}

  res.json({ message: `重置邮件已发送到 ${masked}` });
});

// PUT /api/admin/topics/:id/move — 移动帖子到其他版块
const { body: moveBody, validationResult: moveVal } = require('express-validator');
const { logAdmin } = require('../utils/logger');

router.put('/topics/:id/move', requireAdmin, [
  moveBody('category_id').isInt({ min: 1 }).withMessage('请选择目标版块'),
], (req, res) => {
  const errors = moveVal(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg });
  }

  const db = getDb();
  const topicId = Number(req.params.id);
  const newCategoryId = Number(req.body.category_id);

  // 验证目标版块存在
  const targetCat = db.prepare('SELECT id, name FROM categories WHERE id = ?').get(newCategoryId);
  if (!targetCat) {
    return res.status(404).json({ error: '目标版块不存在' });
  }

  // 读取帖子当前版块
  const topic = db.prepare('SELECT id, title, category_id FROM topics WHERE id = ?').get(topicId);
  if (!topic) {
    return res.status(404).json({ error: '帖子不存在' });
  }

  if (topic.category_id === newCategoryId) {
    return res.status(400).json({ error: '目标版块与当前版块相同' });
  }

  const oldCatId = topic.category_id;
  const oldCat = db.prepare('SELECT name FROM categories WHERE id = ?').get(oldCatId);

  // 事务：更新帖子版块 + 同步两个版块的 topic_count
  const moveTopic = db.transaction(() => {
    db.prepare('UPDATE topics SET category_id = ? WHERE id = ?').run(newCategoryId, topicId);
    db.prepare('UPDATE categories SET topic_count = MAX(topic_count - 1, 0) WHERE id = ?').run(oldCatId);
    db.prepare('UPDATE categories SET topic_count = topic_count + 1 WHERE id = ?').run(newCategoryId);
  });

  try {
    moveTopic();

    const detail = `从「${oldCat?.name || oldCatId}」移动到「${targetCat.name}」(topic: ${topic.title})`;
    logAdmin('帖子移动', detail, req.user, req.ip);

    res.json({
      message: detail,
      old_category_id: oldCatId,
      new_category_id: newCategoryId,
    });
  } catch (err) {
    res.status(500).json({ error: '移动失败，操作已回滚' });
  }
});

// ═══════════════════════════════════════════════════════════════
// 邮件管理
// ═══════════════════════════════════════════════════════════════

router.get('/email-status', requireAdmin, (req, res) => {
  const { getHealth } = require('../utils/mailer');
  res.json(getHealth());
});

router.post('/email-test', requireAdmin, (req, res) => {
  const { sendMail } = require('../utils/mailer');
  const { email } = req.body;

  if (!email || !/\S+@\S+\.\S+/.test(email)) {
    return res.status(422).json({ error: '请输入有效的测试邮箱地址' });
  }

  sendMail(email, '论坛邮件测试', '<h2>MonkeyCode 论坛</h2><p>这是一封来自管理后台的测试邮件，您的 SMTP 配置正常。</p>')
    .then(result => {
      // 返回最新的健康状态
      const { getHealth } = require('../utils/mailer');
      res.json({ message: result.success ? '测试邮件发送成功' : result.message, health: getHealth() });
    })
    .catch(err => {
      res.status(500).json({ error: '发送异常: ' + err.message });
    });
});

module.exports = router;
