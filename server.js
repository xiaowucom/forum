// 环境变量加载（必须在所有 require 之前）
require('dotenv').config();

const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { marked } = require('marked');
const createDOMPurify = require('dompurify');
const { JSDOM } = require('jsdom');

const { initDatabase } = require('./db/init');
const { authenticate } = require('./middleware/auth');
const config = require('./config');

const app = express();
const PORT = process.env.PORT || 3100;

function sanitizeMarkdown(text) {
  const window = new JSDOM('').window;
  const purify = createDOMPurify(window);
  return purify.sanitize(marked.parse(text || ''));
}

// 生产环境部署在 Nginx 后时取消注释
app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// 全局限流：所有请求每分钟 100 次
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '请求过于频繁，请稍后再试' },
});
app.use(globalLimiter);

app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 上传目录（Logo 图片等）
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) { fs.mkdirSync(uploadsDir, { recursive: true }); }

// Multer 配置（Logo 上传）
const logoStorage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, 'logo_' + Date.now() + ext);
  },
});
const logoUpload = multer({
  storage: logoStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

// JWT 解析（全局）
app.use(authenticate);

// 配置注入中间件（每次请求从内存拷贝，不查数据库）
app.use((req, res, next) => {
  res.locals.settings = config.getAllSettings();
  next();
});

// API 路由
const authRoutes = require('./routes/auth');
const categoryRoutes = require('./routes/categories');
const topicRoutes = require('./routes/topics');
const replyRoutes = require('./routes/replies');
const adminRoutes = require('./routes/admin');
const { router: notificationRoutes } = require('./routes/notifications');
const searchRoutes = require('./routes/search');
const logRoutes = require('./routes/admin/logs');
const logger = require('./utils/logger');

app.use('/api/auth', authRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/topics', topicRoutes);
app.use('/api', replyRoutes);       // 含 /api/topics/:topicId/replies 和 /api/replies/:id
app.use('/api/admin', adminRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/admin/logs', logRoutes);

// Logo 上传接口（需在 authenticate 之后）
app.post('/api/admin/upload-logo', logoUpload.single('logo'), (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(401).json({ error: '需要管理员权限' });
  }
  if (!req.file) {
    return res.status(400).json({ error: '请选择图片文件（支持 PNG/JPG/GIF/WebP/SVG，最大 2MB）' });
  }
  const url = '/uploads/' + req.file.filename;
  res.json({ url });
});

// 自动日志记录中间件
app.use((req, res, next) => {
  res.on('finish', function() {
    if (!req.path.startsWith('/api/')) return;
    var statusCode = res.statusCode;
    var method = req.method;
    var path = req.path;
    var user = req.user;
    var ip = req.ip || req.connection.remoteAddress;

    function log(entry) {
      if (!entry) return;
      if (entry.type === 'security') {
        logger.logSecurity(entry.action, entry.detail, entry.level, user, ip);
      } else if (entry.type === 'admin') {
        logger.logAdmin(entry.action, entry.detail, user, ip);
      } else if (entry.type === 'user') {
        logger.logUser(entry.action, entry.detail, user, ip);
      } else if (entry.type === 'system') {
        logger.logSystem(entry.action, entry.detail);
      }
    }

    // 安全事件
    if (statusCode === 401 && path === '/api/auth/login') {
      log({ type: 'security', level: 'warning', action: '登录失败', detail: '用户名或密码错误' });
      return;
    }
    if (statusCode === 403) {
      log({ type: 'security', level: 'warning', action: '403 禁止访问', detail: method + ' ' + path });
      return;
    }
    if (statusCode === 429) {
      log({ type: 'security', level: 'warning', action: '429 请求过于频繁', detail: method + ' ' + path });
      return;
    }
    if (statusCode === 422 && path === '/api/auth/send-code') {
      log({ type: 'security', level: 'warning', action: '验证码发送失败', detail: method + ' ' + path });
      return;
    }
    if (statusCode === 422 && (path === '/api/auth/verify-code' || path === '/api/auth/reset-password-confirm')) {
      log({ type: 'security', level: 'warning', action: '验证码校验失败', detail: method + ' ' + path });
      return;
    }
    if (statusCode >= 500) {
      log({ type: 'security', level: 'error', action: '500 服务器错误', detail: method + ' ' + path });
      return;
    }
    if (statusCode >= 400) return;

    // 邮箱/验证码
    if (method === 'POST' && path === '/api/auth/send-code') {
      log({ type: 'security', level: 'info', action: '发送验证码', detail: (req.body && req.body.purpose) || '' });
      return;
    }
    if (method === 'POST' && path === '/api/auth/verify-code') {
      log({ type: 'security', level: 'info', action: '验证码校验通过' });
      return;
    }
    if (method === 'POST' && path === '/api/auth/reset-password-confirm') {
      log({ type: 'user', action: '重置密码' });
      return;
    }
    if (method === 'PUT' && path === '/api/auth/settings') {
      log({ type: 'user', action: '修改通知设置' });
      return;
    }

    // 认证
    if (method === 'POST' && path === '/api/auth/register') {
      log({ type: 'user', action: '注册', detail: req.body && req.body.username });
      return;
    }
    if (method === 'POST' && path === '/api/auth/login') {
      log({ type: 'user', action: '登录' });
      return;
    }
    if (method === 'POST' && path === '/api/auth/logout') {
      log({ type: 'user', action: '退出' });
      return;
    }
    if (method === 'PUT' && path === '/api/auth/profile') {
      log({ type: 'user', action: '修改资料' });
      return;
    }
    if (method === 'PUT' && path === '/api/auth/password') {
      log({ type: 'user', action: '修改密码' });
      return;
    }
    if (method === 'PUT' && path === '/api/auth/email') {
      log({ type: 'user', action: '修改邮箱' });
      return;
    }

    // 版块管理
    if (method === 'POST' && path === '/api/categories') {
      log({ type: 'admin', action: '创建版块', detail: req.body && req.body.name });
      return;
    }
    if (method === 'PUT' && /^\/api\/categories\/\d+$/.test(path)) {
      log({ type: 'admin', action: '修改版块' });
      return;
    }
    if (method === 'DELETE' && /^\/api\/categories\/\d+$/.test(path)) {
      log({ type: 'admin', action: '删除版块' });
      return;
    }

    // 帖子
    if (method === 'POST' && path === '/api/topics') {
      log({ type: 'user', action: '发帖', detail: req.body && req.body.title });
      return;
    }
    if (method === 'PUT' && /^\/api\/topics\/\d+$/.test(path)) {
      log({ type: 'user', action: '编辑帖子' });
      return;
    }
    if (method === 'DELETE' && /^\/api\/topics\/\d+$/.test(path)) {
      var isAdmin = user && user.role === 'admin';
      log({ type: isAdmin ? 'admin' : 'user', action: '删除帖子' });
      return;
    }
    if (method === 'PUT' && /^\/api\/topics\/\d+\/pin$/.test(path)) {
      log({ type: 'admin', action: '置顶/取消置顶帖子' });
      return;
    }
    if (method === 'PUT' && /^\/api\/topics\/\d+\/essence$/.test(path)) {
      log({ type: 'admin', action: '加精/取消加精帖子' });
      return;
    }

    // 回复
    if (method === 'POST' && /^\/api\/topics\/\d+\/replies$/.test(path)) {
      log({ type: 'user', action: '回复' });
      return;
    }
    if (method === 'DELETE' && /^\/api\/replies\/\d+$/.test(path)) {
      log({ type: 'user', action: '删除回复' });
      return;
    }

    // 管理后台
    if (method === 'PUT' && /^\/api\/admin\/users\/\d+\/role$/.test(path)) {
      log({ type: 'admin', action: '修改用户角色' });
      return;
    }
    if (method === 'DELETE' && /^\/api\/admin\/users\/\d+$/.test(path)) {
      log({ type: 'admin', action: '删除用户' });
      return;
    }
    if (method === 'PUT' && /^\/api\/admin\/users\/\d+\/unbind-email$/.test(path)) {
      log({ type: 'admin', action: '解绑用户邮箱' });
      return;
    }
    if (method === 'POST' && /^\/api\/admin\/users\/\d+\/send-reset$/.test(path)) {
      log({ type: 'admin', action: '发送重置密码邮件' });
      return;
    }
    if (method === 'PUT' && path === '/api/admin/settings') {
      log({ type: 'admin', action: '修改网站设置' });
      return;
    }
    if (method === 'POST' && path === '/api/admin/messages') {
      log({ type: 'admin', action: '发送系统消息' });
      return;
    }
  });
  next();
});

// 页面路由（SSR）
app.get('/', (req, res) => {
  const db = require('./db/init').getDb();
  const categories = db.prepare('SELECT * FROM categories ORDER BY sort_order ASC').all();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = config.getNumber('page_size', 20);
  const offset = (page - 1) * pageSize;

  const countRow = db.prepare('SELECT COUNT(*) AS total FROM topics').get();
  const topics = db.prepare(
    `SELECT t.id, t.title, t.reply_count, t.view_count, t.is_pinned, t.is_essence, t.created_at,
            u.id AS author_user_id, u.username, u.nickname, c.name as category_name, c.id as category_id
     FROM topics t
     LEFT JOIN users u ON t.user_id = u.id
     LEFT JOIN categories c ON t.category_id = c.id
     ORDER BY t.is_pinned DESC, t.created_at DESC
     LIMIT ? OFFSET ?`
  ).all(pageSize, offset);

  const pagination = {
    page,
    pageSize,
    total: countRow.total,
    totalPages: Math.ceil(countRow.total / pageSize),
  };

  res.render('layout', { title: '首页', body: 'home', user: req.user, categories, topics, pagination });
});

app.get('/category/:id', (req, res) => {
  const db = require('./db/init').getDb();
  const category = db.prepare('SELECT id, name, description, post_restricted, reply_restricted FROM categories WHERE id = ?').get(req.params.id);
  if (!category) return res.status(404).send('版块不存在');
  res.render('layout', { title: '版块', body: 'category', user: req.user, categoryId: req.params.id, category: JSON.stringify(category) });
});

app.get('/topic/new', (req, res) => {
  if (req.tokenExpired) return res.redirect('/login?kicked=1'); if (!req.user) return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
  if (!config.getBoolean('enable_new_topic')) return res.redirect('/');
  const db = require('./db/init').getDb();
  const categories = db.prepare('SELECT id, name, post_restricted FROM categories ORDER BY sort_order ASC').all();
  res.render('layout', { title: '发帖', body: 'new-topic', user: req.user, categories });
});

app.get('/topic/:id/edit', (req, res) => {
  if (req.tokenExpired) return res.redirect('/login?kicked=1'); if (!req.user) return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
  const db = require('./db/init').getDb();
  const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(req.params.id);
  if (!topic) return res.status(404).send('帖子不存在');
  if (topic.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).send('无权编辑');
  const categories = db.prepare('SELECT id, name FROM categories ORDER BY sort_order ASC').all();
  res.render('layout', { title: '编辑帖子', body: 'edit-topic', user: req.user, topic, categories });
});

app.get('/topic/:id', (req, res) => {
  const db = require('./db/init').getDb();
  const topic = db.prepare(
    `SELECT t.*, u.id AS author_user_id, u.username, u.nickname, u.avatar
     FROM topics t LEFT JOIN users u ON t.user_id = u.id
     WHERE t.id = ?`
  ).get(req.params.id);

  if (!topic) return res.status(404).send('帖子不存在');

  // 服务端预渲染 Markdown → 安全 HTML，SEO 友好
  topic.contentHTML = sanitizeMarkdown(topic.content);

  // view_count +1
  db.prepare('UPDATE topics SET view_count = view_count + 1 WHERE id = ?').run(topic.id);
  topic.view_count += 1;

  // 查询版块权限信息
  const category = db.prepare('SELECT reply_restricted FROM categories WHERE id = ?').get(topic.category_id);

  res.render('layout', { title: topic.title, body: 'topic', user: req.user, topic, categoryReplyRestricted: category ? category.reply_restricted : 0 });
});

app.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('layout', {
    title: '登录',
    body: 'login',
    user: null,
    redirect: req.query.redirect || '',
    kicked: req.query.kicked || '',
  });
});

app.get('/register', (req, res) => {
  if (req.user) return res.redirect('/');
  if (!config.getBoolean('enable_register')) return res.redirect('/login');
  res.render('layout', { title: '注册', body: 'register', user: null });
});

app.get('/search', (req, res) => {
  res.render('layout', {
    title: '搜索', body: 'search', user: req.user,
    keyword: req.query.q || '',
    scope: req.query.scope || 'all',
    sort: req.query.sort || 'newest',
  });
});

app.get('/categories', (req, res) => {
  const db = require('./db/init').getDb();
  const categories = db.prepare(
    `SELECT c.*,
            t.title as latest_title, t.created_at as latest_time
     FROM categories c
     LEFT JOIN topics t ON t.id = (
       SELECT id FROM topics WHERE category_id = c.id ORDER BY created_at DESC LIMIT 1
     )
     ORDER BY c.sort_order ASC`
  ).all();
  res.render('layout', { title: '全部版块', body: 'categories', user: req.user, categories });
});

app.get('/messages', (req, res) => {
  if (req.tokenExpired) return res.redirect('/login?kicked=1'); if (!req.user) return res.redirect('/login?redirect=/messages');
  if (!config.getBoolean('enable_notifications')) return res.redirect('/');
  res.render('layout', { title: '消息', body: 'messages', user: req.user });
});

app.get('/profile', (req, res) => {
  if (req.tokenExpired) return res.redirect('/login?kicked=1'); if (!req.user) return res.redirect('/login?redirect=/profile');
  const db = require('./db/init').getDb();

  // 查询完整用户信息（JWT 中不含 created_at 等字段）
  const profileUser = db.prepare(
    'SELECT id, username, nickname, email, avatar, bio, role, email_notify, created_at FROM users WHERE id = ?'
  ).get(req.user.id);

  const stats = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM topics WHERE user_id = ?) AS topic_count,
       (SELECT COUNT(*) FROM replies WHERE user_id = ?) AS reply_count,
       (SELECT COALESCE(SUM(like_count),0) FROM topics WHERE user_id = ?)
       + (SELECT COALESCE(SUM(like_count),0) FROM replies WHERE user_id = ?) AS total_likes,
       (SELECT COUNT(*) FROM likes WHERE user_id = ?) AS likes_count`
  ).get(req.user.id, req.user.id, req.user.id, req.user.id, req.user.id);

  res.render('layout', { title: '我的', body: 'profile', user: profileUser, stats });
});

// GET /profile/topics — 我的帖子（独立页面，分页）
app.get('/profile/topics', (req, res) => {
  if (req.tokenExpired) return res.redirect('/login?kicked=1'); if (!req.user) return res.redirect('/login?redirect=/profile/topics');
  const db = require('./db/init').getDb();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = config.getNumber('page_size', 20);
  const offset = (page - 1) * pageSize;

  const countRow = db.prepare('SELECT COUNT(*) AS total FROM topics WHERE user_id = ?').get(req.user.id);
  const topics = db.prepare(
    `SELECT t.id, t.title, t.reply_count, t.view_count, t.like_count,
            t.is_pinned, t.is_essence, t.created_at,
            c.name AS category_name, c.id AS category_id
     FROM topics t LEFT JOIN categories c ON t.category_id = c.id
     WHERE t.user_id = ? ORDER BY t.created_at DESC LIMIT ? OFFSET ?`
  ).all(req.user.id, pageSize, offset);

  const pagination = {
    page, pageSize, total: countRow.total,
    totalPages: Math.ceil(countRow.total / pageSize),
  };

  res.render('layout', { title: '我的帖子', body: 'profile/topics', user: req.user, topics, pagination });
});

// GET /profile/likes — 我赞过的内容（独立页面，分页）
app.get('/profile/likes', (req, res) => {
  if (req.tokenExpired) return res.redirect('/login?kicked=1'); if (!req.user) return res.redirect('/login?redirect=/profile/likes');
  const db = require('./db/init').getDb();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = config.getNumber('page_size', 20);
  const offset = (page - 1) * pageSize;

  const countRow = db.prepare('SELECT COUNT(*) AS total FROM likes WHERE user_id = ?').get(req.user.id);
  const likedItems = db.prepare(
    `SELECT l.id AS like_id, l.created_at AS liked_at, l.topic_id, l.reply_id,
            t.title AS topic_title, t.content AS topic_content,
            ut.username AS topic_author_name, ut.nickname AS topic_author_nickname,
            r.content AS reply_content, r.topic_id AS reply_topic_id,
            rp.title AS reply_topic_title,
            ur.username AS reply_author_name, ur.nickname AS reply_author_nickname,
            COALESCE(ct.name, cr.name) AS category_name
     FROM likes l
     LEFT JOIN topics t ON l.topic_id = t.id
     LEFT JOIN users ut ON t.user_id = ut.id
     LEFT JOIN categories ct ON t.category_id = ct.id
     LEFT JOIN replies r ON l.reply_id = r.id
     LEFT JOIN topics rp ON r.topic_id = rp.id
     LEFT JOIN users ur ON r.user_id = ur.id
     LEFT JOIN categories cr ON rp.category_id = cr.id
     WHERE l.user_id = ?
     ORDER BY l.created_at DESC LIMIT ? OFFSET ?`
  ).all(req.user.id, pageSize, offset);

  const pagination = {
    page, pageSize, total: countRow.total,
    totalPages: Math.ceil(countRow.total / pageSize),
  };

  res.render('layout', { title: '赞过的内容', body: 'profile/likes', user: req.user, likedItems, pagination });
});

// GET /user/:id — 公开用户主页
app.get('/user/:id', (req, res) => {
  const db = require('./db/init').getDb();
  const userId = parseInt(req.params.id);
  if (isNaN(userId) || userId < 1) return res.status(404).send('用户不存在');

  const profileUser = db.prepare(
    'SELECT id, username, nickname, avatar, bio, role, created_at FROM users WHERE id = ?'
  ).get(userId);

  if (!profileUser) return res.status(404).send('用户不存在');

  const stats = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM topics WHERE user_id = ?) AS topic_count,
       (SELECT COUNT(*) FROM replies WHERE user_id = ?) AS reply_count,
       (SELECT COALESCE(SUM(like_count),0) FROM topics WHERE user_id = ?)
       + (SELECT COALESCE(SUM(like_count),0) FROM replies WHERE user_id = ?) AS total_likes`
  ).get(userId, userId, userId, userId);

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = config.getNumber('page_size', 20);
  const offset = (page - 1) * pageSize;

  const countRow = db.prepare('SELECT COUNT(*) AS total FROM topics WHERE user_id = ?').get(userId);
  const topics = db.prepare(
    `SELECT t.id, t.title, t.reply_count, t.view_count, t.is_pinned, t.is_essence, t.created_at,
            c.name AS category_name
     FROM topics t LEFT JOIN categories c ON t.category_id = c.id
     WHERE t.user_id = ? ORDER BY t.created_at DESC LIMIT ? OFFSET ?`
  ).all(userId, pageSize, offset);

  const pagination = {
    page, pageSize, total: countRow.total,
    totalPages: Math.ceil(countRow.total / pageSize),
  };

  const isSelf = req.user && req.user.id === userId;

  res.render('layout', { title: (profileUser.nickname || profileUser.username) + ' 的主页', body: 'user', user: req.user, profileUser, stats, topics, pagination, isSelf });
});
app.get('/profile/settings', (req, res) => {
  if (req.tokenExpired) return res.redirect('/login?kicked=1');
  if (!req.user) return res.redirect('/login?redirect=/profile/settings');
  const db = require('./db/init').getDb();
  const profileUser = db.prepare(
    'SELECT id, username, nickname, email, avatar, bio, role, email_notify, created_at FROM users WHERE id = ?'
  ).get(req.user.id);
  res.render('layout', { title: '设置', body: 'profile/settings', user: profileUser });
});

app.get('/admin', (req, res) => {
  if (req.tokenExpired) return res.redirect('/login?kicked=1'); if (!req.user) return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
  if (req.user.role !== 'admin') return res.status(403).send('需要管理员权限');
  res.render('layout', { title: '管理后台', body: 'admin/dashboard', user: req.user });
});

app.get('/admin/users', (req, res) => {
  if (req.tokenExpired) return res.redirect('/login?kicked=1'); if (!req.user) return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
  if (req.user.role !== 'admin') return res.status(403).send('需要管理员权限');
  res.render('layout', { title: '用户管理', body: 'admin/users', user: req.user });
});

app.get('/admin/categories', (req, res) => {
  if (req.tokenExpired) return res.redirect('/login?kicked=1'); if (!req.user) return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
  if (req.user.role !== 'admin') return res.status(403).send('需要管理员权限');
  res.render('layout', { title: '版块管理', body: 'admin/categories', user: req.user });
});

app.get('/admin/messages', (req, res) => {
  if (req.tokenExpired) return res.redirect('/login?kicked=1'); if (!req.user) return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
  if (req.user.role !== 'admin') return res.status(403).send('需要管理员权限');
  res.render('layout', { title: '发送系统消息', body: 'admin/messages', user: req.user });
});

app.get('/admin/topics', (req, res) => {
  if (req.tokenExpired) return res.redirect('/login?kicked=1'); if (!req.user) return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
  if (req.user.role !== 'admin') return res.status(403).send('需要管理员权限');
  res.render('layout', { title: '帖子管理', body: 'admin/topics', user: req.user });
});

app.get('/admin/settings', (req, res) => {
  if (req.tokenExpired) return res.redirect('/login?kicked=1'); if (!req.user) return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
  if (req.user.role !== 'admin') return res.status(403).send('需要管理员权限');
  res.render('layout', { title: '网站设置', body: 'admin/settings', user: req.user });
});

app.get('/admin/logs', (req, res) => {
  if (req.tokenExpired) return res.redirect('/login?kicked=1'); if (!req.user) return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
  if (req.user.role !== 'admin') return res.status(403).send('需要管理员权限');
  res.render('layout', { title: '日志中心', body: 'admin/logs', user: req.user });
});

// 全局错误处理
app.get('/profile/password', (req, res) => {
  if (req.tokenExpired) return res.redirect('/login?kicked=1');
  if (!req.user) return res.redirect('/login?redirect=/profile/password');
  res.render('layout', { title: '修改密码', body: 'profile/password', user: req.user });
});

// 占位页面
app.get('/about/terms', (req, res) => {
  res.render('layout', { title: '用户协议', body: 'about/terms', user: req.user });
});
app.get('/about/privacy', (req, res) => {
  res.render('layout', { title: '隐私政策', body: 'about/privacy', user: req.user });
});

app.use((err, req, res, next) => {
  console.error('[Error]', err);
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({ error: '服务器内部错误' });
  }
  res.status(500).send('服务器内部错误');
});

// 404
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    try { logger.logSecurity('404 页面不存在', req.method + ' ' + req.path, 'info', req.user, req.ip); } catch (e) {}
    return res.status(404).json({ error: '接口不存在' });
  }
  res.status(404).send('页面不存在');
});

// 初始化数据库并启动
initDatabase();
config.loadSettings();

app.listen(PORT, () => {
  console.log(`[Server] 论坛服务已启动 http://localhost:${PORT}`);
  try {
    logger.logSystem('Node 启动', '端口 ' + PORT);
  } catch (e) {}
});
