const { Router } = require('express');
const { getDb } = require('../db/init');
const config = require('../config');

const router = Router();

router.get('/', (req, res) => {
  const db = getDb();
  const q = (req.query.q || '').trim();

  if (!q) {
    return res.json({ topics: [], total: 0, page: 1, pageSize: 20, totalPages: 0 });
  }

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize) || config.getNumber('page_size', 20)));
  const offset = (page - 1) * pageSize;
  const scope = req.query.scope || 'all';
  const sort = req.query.sort || 'newest';
  const keyword = '%' + q + '%';

  const conditions = [];
  const params = [];

  switch (scope) {
    case 'title':
      conditions.push('t.title LIKE ?');
      params.push(keyword);
      break;
    case 'content':
      conditions.push('t.content LIKE ?');
      params.push(keyword);
      break;
    case 'user':
      conditions.push('u.username LIKE ?');
      params.push(keyword);
      break;
    case 'category':
      conditions.push('c.name LIKE ?');
      params.push(keyword);
      break;
    default:
      conditions.push('(t.title LIKE ? OR t.content LIKE ? OR u.username LIKE ? OR c.name LIKE ?)');
      params.push(keyword, keyword, keyword, keyword);
  }

  const whereClause = 'WHERE ' + conditions.join(' AND ');

  let orderClause;
  switch (sort) {
    case 'replies':
      orderClause = 't.reply_count DESC, t.created_at DESC';
      break;
    case 'likes':
      orderClause = 't.like_count DESC, t.created_at DESC';
      break;
    case 'views':
      orderClause = 't.view_count DESC, t.created_at DESC';
      break;
    default:
      orderClause = 't.created_at DESC';
  }

  const countRow = db.prepare(
    `SELECT COUNT(*) AS total FROM topics t
     LEFT JOIN users u ON t.user_id = u.id
     LEFT JOIN categories c ON t.category_id = c.id
     ${whereClause}`
  ).get(...params);

  const topics = db.prepare(
    `SELECT t.id, t.title, t.content, t.reply_count, t.like_count, t.view_count,
            t.is_pinned, t.is_essence, t.created_at,
            u.id AS author_user_id, u.username, u.nickname, u.avatar,
            c.name as category_name, c.id as category_id
     FROM topics t
     LEFT JOIN users u ON t.user_id = u.id
     LEFT JOIN categories c ON t.category_id = c.id
     ${whereClause}
     ORDER BY ${orderClause}
     LIMIT ? OFFSET ?`
  ).all(...params, pageSize, offset);

  const totalPages = Math.ceil(countRow.total / pageSize);

  res.json({
    topics,
    total: countRow.total,
    page,
    pageSize,
    totalPages,
    keyword: q,
    scope,
    sort,
  });
});

module.exports = router;
