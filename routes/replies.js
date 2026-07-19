const { Router } = require('express');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { getDb } = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const { createNotification } = require('./notifications');
const config = require('../config');

const router = Router();

const postReplyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '回复过于频繁，请稍后再试' },
});

const replyRules = [
  body('content').trim().isLength({ min: 1, max: 10000 }).withMessage('回复内容为 1-10000 个字符'),
];

// GET /api/topics/:topicId/replies — 回复列表（公开，分页）
router.get('/topics/:topicId/replies', (req, res) => {
  const db = getDb();
  const { topicId } = req.params;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize) || config.getNumber('page_size', 20)));
  const offset = (page - 1) * pageSize;

  const topic = db.prepare('SELECT id FROM topics WHERE id = ?').get(topicId);
  if (!topic) {
    return res.status(404).json({ error: '帖子不存在' });
  }

  const countRow = db.prepare(
    'SELECT COUNT(*) AS total FROM replies WHERE topic_id = ?'
  ).get(topicId);

  const replies = db.prepare(
    `SELECT r.*, u.id AS author_user_id, u.username, u.nickname, u.avatar
     FROM replies r LEFT JOIN users u ON r.user_id = u.id
     WHERE r.topic_id = ?
     ORDER BY r.floor ASC
     LIMIT ? OFFSET ?`
  ).all(topicId, pageSize, offset);

  res.json({
    replies,
    total: countRow.total,
    page,
    pageSize,
    totalPages: Math.ceil(countRow.total / pageSize),
  });
});

// POST /api/topics/:topicId/replies — 回复（需登录 + 限流）
router.post('/topics/:topicId/replies', requireAuth, postReplyLimiter, replyRules, (req, res) => {
  if (!config.getBoolean('enable_reply')) {
    return res.status(403).json({ error: '回复功能已关闭' });
  }
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ error: errors.array()[0].msg });
  }

  const db = getDb();
  const { topicId } = req.params;
  const { content } = req.body;

  const topic = db.prepare('SELECT id, category_id FROM topics WHERE id = ?').get(topicId);
  if (!topic) {
    return res.status(404).json({ error: '帖子不存在' });
  }

  // 版块回复权限：仅管理员可在受限版块回复
  if (req.user.role !== 'admin') {
    const category = db.prepare('SELECT reply_restricted FROM categories WHERE id = ?').get(topic.category_id);
    if (category && category.reply_restricted) {
      return res.status(403).json({ error: '仅管理员可在本版块回复' });
    }
  }

  // 自动计算楼层号
  const floor = db.prepare(
    'SELECT COALESCE(MAX(floor), 0) + 1 AS next_floor FROM replies WHERE topic_id = ?'
  ).get(topicId).next_floor;

  const result = db.prepare(
    'INSERT INTO replies (content, topic_id, user_id, floor) VALUES (?, ?, ?, ?)'
  ).run(content.trim(), topicId, req.user.id, floor);

  // 通知帖主：有人回复了你的帖子
  const topicAuthor = db.prepare('SELECT user_id FROM topics WHERE id = ?').get(topicId);
  if (topicAuthor && topicAuthor.user_id && config.getBoolean('enable_notifications')) {
    createNotification(db, topicAuthor.user_id, 'reply', req.user.id, Number(topicId), result.lastInsertRowid);
  }

  // 更新帖子的 updated_at
  db.prepare(
    "UPDATE topics SET updated_at = datetime('now','localtime') WHERE id = ?"
  ).run(topicId);

  const reply = db.prepare(
    `SELECT r.*, u.id AS author_user_id, u.username, u.nickname, u.avatar
     FROM replies r LEFT JOIN users u ON r.user_id = u.id
     WHERE r.id = ?`
  ).get(result.lastInsertRowid);

  res.status(201).json({ reply });
});

// PUT /api/replies/:id — 编辑回复（作者或管理员）
router.put('/replies/:id', requireAuth, (req, res) => {
  const db = getDb();
  const { id } = req.params;
  const { content } = req.body;

  const reply = db.prepare('SELECT * FROM replies WHERE id = ?').get(id);
  if (!reply) {
    return res.status(404).json({ error: '回复不存在' });
  }

  if (reply.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: '无权编辑此回复' });
  }

  const newContent = (content !== undefined ? content.trim() : reply.content);
  if (!newContent || newContent.length > 10000) {
    return res.status(422).json({ error: '回复内容为 1-10000 个字符' });
  }

  db.prepare(
    "UPDATE replies SET content = ?, updated_at = datetime('now','localtime') WHERE id = ?"
  ).run(newContent, Number(id));

  const updated = db.prepare(
    `SELECT r.*, u.id AS author_user_id, u.username, u.nickname, u.avatar
     FROM replies r LEFT JOIN users u ON r.user_id = u.id
     WHERE r.id = ?`
  ).get(id);

  res.json({ reply: updated });
});

// DELETE /api/replies/:id — 删除回复（作者或管理员）
router.delete('/replies/:id', requireAuth, (req, res) => {
  const db = getDb();
  const { id } = req.params;

  const reply = db.prepare('SELECT * FROM replies WHERE id = ?').get(id);
  if (!reply) {
    return res.status(404).json({ error: '回复不存在' });
  }

  if (reply.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: '无权删除此回复' });
  }

  db.prepare('DELETE FROM replies WHERE id = ?').run(Number(id));
  // 触发器 + ON DELETE CASCADE 自动处理 reply_count, like_count
  res.json({ message: '回复已删除' });
});

// POST /api/replies/:id/like — 点赞/取消点赞 toggle
router.post('/replies/:id/like', requireAuth, (req, res) => {
  const db = getDb();
  const { id } = req.params;

  const reply = db.prepare('SELECT id, user_id, topic_id, like_count FROM replies WHERE id = ?').get(id);
  if (!reply) {
    return res.status(404).json({ error: '回复不存在' });
  }

  const existing = db.prepare(
    'SELECT id FROM likes WHERE user_id = ? AND reply_id = ?'
  ).get(req.user.id, Number(id));

  if (existing) {
    db.prepare('DELETE FROM likes WHERE id = ?').run(existing.id);
    const updated = db.prepare('SELECT like_count FROM replies WHERE id = ?').get(id);
    return res.json({ liked: false, like_count: updated.like_count });
  }

  db.prepare('INSERT INTO likes (user_id, reply_id) VALUES (?, ?)').run(req.user.id, Number(id));
  if (config.getBoolean('enable_notifications')) {
    createNotification(db, reply.user_id, 'like_reply', req.user.id, reply.topic_id, reply.id);
  }
  const updated = db.prepare('SELECT like_count FROM replies WHERE id = ?').get(id);
  res.json({ liked: true, like_count: updated.like_count });
});

module.exports = router;
