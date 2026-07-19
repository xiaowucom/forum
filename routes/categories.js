const { Router } = require('express');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../db/init');
const { requireAdmin } = require('../middleware/auth');

const router = Router();

const categoryRules = [
  body('name').trim().isLength({ min: 1, max: 30 }).withMessage('版块名称为 1-30 个字符'),
];

// GET /api/categories — 版块列表
router.get('/', (req, res) => {
  const db = getDb();
  const categories = db.prepare(
    'SELECT * FROM categories ORDER BY sort_order ASC, id ASC'
  ).all();
  res.json({ categories });
});

// POST /api/categories — 创建版块（管理员）
router.post('/', requireAdmin, categoryRules, (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ error: errors.array()[0].msg });
  }

  const db = getDb();
  const { name, description } = req.body;

  const existing = db.prepare('SELECT id FROM categories WHERE LOWER(name) = LOWER(?)').get(name.trim());
  if (existing) {
    return res.status(409).json({ error: '版块名称已存在' });
  }

  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM categories').get().next;
  const result = db.prepare(
    'INSERT INTO categories (name, description, sort_order) VALUES (?, ?, ?)'
  ).run(name.trim(), (description || '').trim(), maxOrder);

  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ category });
});

// PUT /api/categories/reorder — 上移/下移调整排序 (必须在 /:id 之前)
router.put('/reorder', requireAdmin, (req, res) => {
  const db = getDb();
  const { id, direction } = req.body;

  if (!id || !['up', 'down'].includes(direction)) {
    return res.status(422).json({ error: '参数无效' });
  }

  const cat = db.prepare('SELECT id, sort_order FROM categories WHERE id = ?').get(Number(id));
  if (!cat) return res.status(404).json({ error: '版块不存在' });

  const allCats = db.prepare('SELECT id, sort_order FROM categories ORDER BY sort_order ASC, id ASC').all();
  const idx = allCats.findIndex(c => c.id === cat.id);
  if (idx === -1) return res.status(404).json({ error: '版块不存在' });

  if (direction === 'up' && idx === 0) return res.json({ message: '已在最前' });
  if (direction === 'down' && idx === allCats.length - 1) return res.json({ message: '已在最后' });

  const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
  const target = allCats[targetIdx];

  const swap = db.prepare('UPDATE categories SET sort_order = ? WHERE id = ?');
  swap.run(target.sort_order, cat.id);
  swap.run(cat.sort_order, target.id);

  const categories = db.prepare('SELECT * FROM categories ORDER BY sort_order ASC, id ASC').all();
  res.json({ categories });
});

// PUT /api/categories/:id — 编辑版块（管理员）
router.put('/:id', requireAdmin, categoryRules, (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ error: errors.array()[0].msg });
  }

  const db = getDb();
  const { id } = req.params;
  const { name, description, sort_order, post_restricted, reply_restricted } = req.body;

  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  if (!category) {
    return res.status(404).json({ error: '版块不存在' });
  }

  const dup = db.prepare('SELECT id FROM categories WHERE LOWER(name) = LOWER(?) AND id != ?').get(name.trim(), Number(id));
  if (dup) {
    return res.status(409).json({ error: '版块名称已存在' });
  }

  const newSortOrder = sort_order !== undefined ? Math.max(0, parseInt(sort_order) || 0) : category.sort_order;
  const pr = post_restricted !== undefined ? (post_restricted ? 1 : 0) : category.post_restricted;
  const rr = reply_restricted !== undefined ? (reply_restricted ? 1 : 0) : category.reply_restricted;
  db.prepare(
    'UPDATE categories SET name = ?, description = ?, sort_order = ?, post_restricted = ?, reply_restricted = ? WHERE id = ?'
  ).run(name.trim(), (description || '').trim(), newSortOrder, pr, rr, Number(id));

  const updated = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  res.json({ category: updated });
});

// DELETE /api/categories/:id — 删除版块（管理员，仅空版块可删）
router.delete('/:id', requireAdmin, (req, res) => {
  const db = getDb();
  const { id } = req.params;

  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  if (!category) {
    return res.status(404).json({ error: '版块不存在' });
  }

  if (category.topic_count > 0) {
    return res.status(400).json({ error: '该版块下还有帖子，无法删除' });
  }

  db.prepare('DELETE FROM categories WHERE id = ?').run(Number(id));
  res.json({ message: '版块已删除' });
});

module.exports = router;
