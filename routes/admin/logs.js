const { Router } = require('express');
const { getDb } = require('../../db/init');
const { requireAdmin } = require('../../middleware/auth');
const config = require('../../config');

const router = Router();

router.get('/', requireAdmin, (req, res) => {
  const db = getDb();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize) || config.getNumber('page_size', 20)));
  const offset = (page - 1) * pageSize;
  const { keyword, type, level, user, start, end } = req.query;

  const conditions = [];
  const params = [];

  if (keyword && keyword.trim()) {
    conditions.push('(action LIKE ? OR detail LIKE ? OR username LIKE ?)');
    const k = '%' + keyword.trim() + '%';
    params.push(k, k, k);
  }
  if (type && ['system', 'user', 'admin', 'security'].includes(type)) {
    conditions.push('type = ?');
    params.push(type);
  }
  if (level && ['info', 'warning', 'error'].includes(level)) {
    conditions.push('level = ?');
    params.push(level);
  }
  if (user && user.trim()) {
    conditions.push('username LIKE ?');
    params.push('%' + user.trim() + '%');
  }
  if (start && start.trim()) {
    conditions.push('created_at >= ?');
    params.push(start.trim());
  }
  if (end && end.trim()) {
    conditions.push('created_at <= ?');
    params.push(end.trim() + ' 23:59:59');
  }

  const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const countRow = db.prepare(
    `SELECT COUNT(*) AS total FROM logs ${whereClause}`
  ).get(...params);

  const logs = db.prepare(
    `SELECT * FROM logs ${whereClause}
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`
  ).all(...params, pageSize, offset);

  res.json({
    logs,
    total: countRow.total,
    page,
    pageSize,
    totalPages: Math.ceil(countRow.total / pageSize),
  });
});

module.exports = router;
