const { Router } = require('express');
const { body, query, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { getDb } = require('../db/init');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { createNotification } = require('./notifications');
const config = require('../config');

const router = Router();

const postTopicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '发帖过于频繁，请稍后再试' },
});

const topicRules = [
  body('title').trim().isLength({ min: 1, max: 100 }).withMessage('标题为 1-100 个字符'),
  body('content').trim().isLength({ min: 1, max: 20000 }).withMessage('内容为 1-20000 个字符'),
  body('category_id').isInt({ min: 1 }).withMessage('请选择版块'),
];

// GET /api/topics — 帖子列表（公开，支持分页/版块筛选/搜索）
router.get('/', (req, res) => {
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
    `SELECT t.*, u.id AS author_user_id, u.username, u.nickname, u.avatar, c.name as category_name
     FROM topics t LEFT JOIN users u ON t.user_id = u.id
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

// GET /api/topics/:id — 帖子详情（公开）
router.get('/:id', (req, res) => {
  const db = getDb();
  const { id } = req.params;

  const topic = db.prepare(
    `SELECT t.*, u.id AS author_user_id, u.username, u.nickname, u.avatar
     FROM topics t LEFT JOIN users u ON t.user_id = u.id
     WHERE t.id = ?`
  ).get(id);

  if (!topic) {
    return res.status(404).json({ error: '帖子不存在' });
  }

  // view_count 手动 +1
  db.prepare('UPDATE topics SET view_count = view_count + 1 WHERE id = ?').run(topic.id);
  topic.view_count += 1;

  res.json({ topic });
});

// POST /api/topics — 发帖（需登录 + 限流）
router.post('/', requireAuth, postTopicLimiter, topicRules, (req, res) => {
  if (!config.getBoolean('enable_new_topic')) {
    return res.status(403).json({ error: '发帖功能已关闭' });
  }
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ error: errors.array()[0].msg });
  }

  const db = getDb();
  const { title, content, category_id } = req.body;

  const category = db.prepare('SELECT id, post_restricted FROM categories WHERE id = ?').get(category_id);
  if (!category) {
    return res.status(400).json({ error: '版块不存在' });
  }

  // 版块发帖权限：仅管理员可在受限版块发帖
  if (category.post_restricted && req.user.role !== 'admin') {
    return res.status(403).json({ error: '仅管理员可在本版块发帖' });
  }

  const result = db.prepare(
    'INSERT INTO topics (title, content, category_id, user_id) VALUES (?, ?, ?, ?)'
  ).run(title.trim(), content.trim(), category_id, req.user.id);

  const topic = db.prepare(
    `SELECT t.*, u.id AS author_user_id, u.username, u.nickname, u.avatar
     FROM topics t LEFT JOIN users u ON t.user_id = u.id
     WHERE t.id = ?`
  ).get(result.lastInsertRowid);

  res.status(201).json({ topic });
});

// PUT /api/topics/:id — 编辑帖子（作者或管理员）
router.put('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const { id } = req.params;
  const { title, content } = req.body;

  const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(id);
  if (!topic) {
    return res.status(404).json({ error: '帖子不存在' });
  }

  if (topic.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: '无权编辑此帖子' });
  }

  const newTitle = (title !== undefined ? title.trim() : topic.title);
  const newContent = (content !== undefined ? content.trim() : topic.content);

  if (!newTitle || newTitle.length > 100) return res.status(422).json({ error: '标题为 1-100 个字符' });
  if (!newContent || newContent.length > 20000) return res.status(422).json({ error: '内容为 1-20000 个字符' });

  db.prepare(
    "UPDATE topics SET title = ?, content = ?, updated_at = datetime('now','localtime') WHERE id = ?"
  ).run(newTitle, newContent, Number(id));

  const updated = db.prepare(
    `SELECT t.*, u.id AS author_user_id, u.username, u.nickname, u.avatar
     FROM topics t LEFT JOIN users u ON t.user_id = u.id
     WHERE t.id = ?`
  ).get(id);

  res.json({ topic: updated });
});

// DELETE /api/topics/:id — 删除帖子（作者或管理员，级联删除回复和点赞）
router.delete('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const { id } = req.params;

  const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(id);
  if (!topic) {
    return res.status(404).json({ error: '帖子不存在' });
  }

  if (topic.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: '无权删除此帖子' });
  }

  db.prepare('DELETE FROM topics WHERE id = ?').run(Number(id));
  // 触发器 + ON DELETE CASCADE 自动处理 reply_count, like_count, category topic_count
  res.json({ message: '帖子已删除' });
});

// POST /api/topics/:id/like — 点赞/取消点赞 toggle
router.post('/:id/like', requireAuth, (req, res) => {
  const db = getDb();
  const { id } = req.params;

  const topic = db.prepare('SELECT id, user_id, like_count FROM topics WHERE id = ?').get(id);
  if (!topic) {
    return res.status(404).json({ error: '帖子不存在' });
  }

  const existing = db.prepare(
    'SELECT id FROM likes WHERE user_id = ? AND topic_id = ?'
  ).get(req.user.id, Number(id));

  if (existing) {
    db.prepare('DELETE FROM likes WHERE id = ?').run(existing.id);
    const updated = db.prepare('SELECT like_count FROM topics WHERE id = ?').get(id);
    return res.json({ liked: false, like_count: updated.like_count });
  }

  db.prepare('INSERT INTO likes (user_id, topic_id) VALUES (?, ?)').run(req.user.id, Number(id));
  if (config.getBoolean('enable_notifications')) {
    createNotification(db, topic.user_id, 'like_topic', req.user.id, topic.id, null);
  }
  const updated = db.prepare('SELECT like_count FROM topics WHERE id = ?').get(id);
  res.json({ liked: true, like_count: updated.like_count });
});

// PUT /api/topics/:id/pin — 置顶/取消置顶 toggle（管理员）
router.put('/:id/pin', requireAdmin, (req, res) => {
  const db = getDb();
  const { id } = req.params;

  const topic = db.prepare('SELECT id, is_pinned FROM topics WHERE id = ?').get(id);
  if (!topic) {
    return res.status(404).json({ error: '帖子不存在' });
  }

  const newVal = topic.is_pinned ? 0 : 1;
  db.prepare('UPDATE topics SET is_pinned = ? WHERE id = ?').run(newVal, Number(id));
  res.json({ is_pinned: newVal });
});

// PUT /api/topics/:id/essence — 加精/取消加精 toggle（管理员）
router.put('/:id/essence', requireAdmin, (req, res) => {
  const db = getDb();
  const { id } = req.params;

  const topic = db.prepare('SELECT id, is_essence FROM topics WHERE id = ?').get(id);
  if (!topic) {
    return res.status(404).json({ error: '帖子不存在' });
  }

  const newVal = topic.is_essence ? 0 : 1;
  db.prepare('UPDATE topics SET is_essence = ? WHERE id = ?').run(newVal, Number(id));
  res.json({ is_essence: newVal });
});

module.exports = router;
