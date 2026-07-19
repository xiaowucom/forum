const { Router } = require('express');
const { getDb } = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const config = require('../config');

const router = Router();

function createNotification(db, userId, type, actorId, topicId, replyId) {
  if (userId === actorId) return;
  db.prepare(
    'INSERT INTO notifications (user_id, type, actor_id, topic_id, reply_id) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, type, actorId, topicId || null, replyId || null);
}

// GET /api/notifications — 我的通知列表（分页，可选 type 筛选）
router.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize) || config.getNumber('page_size', 20)));
  const offset = (page - 1) * pageSize;
  const { type } = req.query;

  const params = [req.user.id];
  let typeFilter = '';
  if (type === 'system') {
    typeFilter = " AND n.type = 'system'";
  } else if (type === 'reply') {
    typeFilter = " AND n.type = 'reply'";
  } else if (type === 'like') {
    typeFilter = " AND n.type IN ('like_topic', 'like_reply')";
  } else if (type === 'interaction') {
    typeFilter = " AND n.type IN ('reply', 'like_topic', 'like_reply')";
  }

  const countRow = db.prepare(
    `SELECT COUNT(*) AS total FROM notifications n WHERE n.user_id = ?${typeFilter}`
  ).get(...params);

  const notifications = db.prepare(
    `SELECT n.*, u.username AS actor_name, u.nickname AS actor_nickname, u.avatar AS actor_avatar
     FROM notifications n
     LEFT JOIN users u ON n.actor_id = u.id
     WHERE n.user_id = ?${typeFilter}
     ORDER BY n.created_at DESC
     LIMIT ? OFFSET ?`
  ).all(...params, pageSize, offset);

  res.json({
    notifications,
    total: countRow.total,
    page,
    pageSize,
    totalPages: Math.ceil(countRow.total / pageSize),
  });
});

// PUT /api/notifications/:id/read — 标记单条已读
router.put('/:id/read', requireAuth, (req, res) => {
  const db = getDb();
  const { id } = req.params;

  const n = db.prepare('SELECT * FROM notifications WHERE id = ? AND user_id = ?').get(Number(id), req.user.id);
  if (!n) return res.status(404).json({ error: '通知不存在' });

  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(Number(id));
  res.json({ message: '已读' });
});

// PUT /api/notifications/read-all — 按类型标记全部已读
router.put('/read-all', requireAuth, (req, res) => {
  const db = getDb();
  const { type } = req.query;

  let typeFilter = '';
  const params = [req.user.id];
  if (type === 'system') {
    typeFilter = " AND type = 'system'";
  } else if (type === 'reply') {
    typeFilter = " AND type = 'reply'";
  } else if (type === 'like') {
    typeFilter = " AND type IN ('like_topic', 'like_reply')";
  } else if (type === 'interaction') {
    typeFilter = " AND type IN ('reply', 'like_topic', 'like_reply')";
  }

  db.prepare(
    `UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0${typeFilter}`
  ).run(...params);
  res.json({ message: '全部已读' });
});

// DELETE /api/notifications/:id — 删除通知
router.delete('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const { id } = req.params;

  const n = db.prepare('SELECT * FROM notifications WHERE id = ? AND user_id = ?').get(Number(id), req.user.id);
  if (!n) return res.status(404).json({ error: '通知不存在' });

  db.prepare('DELETE FROM notifications WHERE id = ?').run(Number(id));
  res.json({ message: '已删除' });
});

// GET /api/notifications/unread-count — 未读数
router.get('/unread-count', requireAuth, (req, res) => {
  const db = getDb();
  const row = db.prepare(
    'SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0'
  ).get(req.user.id);
  res.json({ count: row.count });
});

module.exports = { router, createNotification };
