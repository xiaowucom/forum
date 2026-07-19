const jwt = require('jsonwebtoken');
const { getDb } = require('../db/init');

const JWT_SECRET = process.env.FORUM_JWT_SECRET || 'forum-dev-secret-change-in-production';
const JWT_EXPIRES = '7d';
const COOKIE_NAME = 'forum_token';

function signToken(payload, tokenVersion) {
  const p = { ...payload };
  if (tokenVersion !== undefined) {
    p.tv = tokenVersion;
  }
  return jwt.sign(p, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function setTokenCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function clearTokenCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

// 解析 token，将用户信息挂载到 req.user（不阻断）
// 同时校验 token_version，若版本不匹配则清除 token 并标记 req.tokenExpired
async function authenticate(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) {
    req.user = null;
    return next();
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // 校验 token_version：token 中 tv 字段与数据库当前值必须一致
    if (decoded.tv !== undefined && decoded.id) {
      const db = getDb();
      const row = db.prepare('SELECT token_version FROM users WHERE id = ?').get(decoded.id);
      if (!row || row.token_version !== decoded.tv) {
        // token_version 不匹配：密码已修改或账号状态变更
        clearTokenCookie(res);
        req.user = null;
        req.tokenExpired = true;
        return next();
      }
    }

    req.user = decoded;
  } catch (err) {
    req.user = null;
    clearTokenCookie(res);
  }
  next();
}

// 要求已登录，未登录返回 401（API）或重定向（页面）
function requireAuth(req, res, next) {
  if (!req.user) {
    if (req.path.startsWith('/api/')) {
      if (req.tokenExpired) {
        return res.status(401).json({ error: '密码已修改或登录已失效，请重新登录', code: 'TOKEN_EXPIRED' });
      }
      return res.status(401).json({ error: '请先登录' });
    }
    // 页面请求：若因 token_version 过期，带 kicked 参数跳转登录页
    if (req.tokenExpired) {
      return res.redirect('/login?kicked=1');
    }
    return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
  }
  next();
}

// 要求管理员角色
function requireAdmin(req, res, next) {
  if (!req.user) {
    if (req.path.startsWith('/api/')) {
      if (req.tokenExpired) {
        return res.status(401).json({ error: '密码已修改或登录已失效，请重新登录', code: 'TOKEN_EXPIRED' });
      }
      return res.status(401).json({ error: '请先登录' });
    }
    if (req.tokenExpired) {
      return res.redirect('/login?kicked=1');
    }
    return res.redirect('/login');
  }
  if (req.user.role !== 'admin') {
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ error: '需要管理员权限' });
    }
    return res.status(403).send('需要管理员权限');
  }
  next();
}

module.exports = {
  JWT_SECRET,
  signToken,
  setTokenCookie,
  clearTokenCookie,
  authenticate,
  requireAuth,
  requireAdmin,
};
