const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'forum.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initDatabase() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    UNIQUE NOT NULL,
      password_hash TEXT    NOT NULL,
      nickname      TEXT    DEFAULT '',
      email         TEXT    DEFAULT '',
      avatar        TEXT    DEFAULT '',
          bio           TEXT    DEFAULT '',
      role          TEXT    DEFAULT 'user',
      token_version INTEGER DEFAULT 1,
      created_at    TEXT    DEFAULT (datetime('now','localtime')),
      updated_at    TEXT    DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS categories (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      name              TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      description       TEXT    DEFAULT '',
      sort_order        INTEGER DEFAULT 0,
      topic_count       INTEGER DEFAULT 0,
      post_restricted   INTEGER DEFAULT 0,
      reply_restricted  INTEGER DEFAULT 0,
      created_at        TEXT    DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS topics (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      title         TEXT    NOT NULL,
      content       TEXT    NOT NULL,
      category_id   INTEGER NOT NULL REFERENCES categories(id),
      user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
      is_pinned     INTEGER DEFAULT 0,
      is_essence    INTEGER DEFAULT 0,
      view_count    INTEGER DEFAULT 0,
      reply_count   INTEGER DEFAULT 0,
      like_count    INTEGER DEFAULT 0,
      created_at    TEXT    DEFAULT (datetime('now','localtime')),
      updated_at    TEXT    DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS replies (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      content       TEXT    NOT NULL,
      topic_id      INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
      floor         INTEGER DEFAULT 1,
      like_count    INTEGER DEFAULT 0,
      created_at    TEXT    DEFAULT (datetime('now','localtime')),
      updated_at    TEXT    DEFAULT (datetime('now','localtime')),
      UNIQUE(topic_id, floor)
    );

    CREATE TABLE IF NOT EXISTS likes (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      topic_id      INTEGER REFERENCES topics(id) ON DELETE CASCADE,
      reply_id      INTEGER REFERENCES replies(id) ON DELETE CASCADE,
      created_at    TEXT    DEFAULT (datetime('now','localtime')),
      UNIQUE(user_id, topic_id),
      UNIQUE(user_id, reply_id),
      CHECK ((topic_id IS NOT NULL AND reply_id IS NULL)
          OR (topic_id IS NULL AND reply_id IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type          TEXT    NOT NULL,
      actor_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      topic_id      INTEGER REFERENCES topics(id) ON DELETE CASCADE,
      reply_id      INTEGER REFERENCES replies(id) ON DELETE CASCADE,
      is_read       INTEGER DEFAULT 0,
      title         TEXT    DEFAULT '',
      content       TEXT    DEFAULT '',
      created_at    TEXT    DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key           TEXT PRIMARY KEY,
      value         TEXT NOT NULL DEFAULT '',
      type          TEXT NOT NULL DEFAULT 'string',
      updated_at    TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS verification_codes (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT    NOT NULL,
      code          TEXT    NOT NULL,
      purpose       TEXT    NOT NULL,
      user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
      expires_at    TEXT    NOT NULL,
      used          INTEGER NOT NULL DEFAULT 0,
      attempts      INTEGER NOT NULL DEFAULT 0,
      ip            TEXT,
      created_at    TEXT    DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_vc_email_purpose ON verification_codes(email, purpose, created_at);

    CREATE TABLE IF NOT EXISTS email_logs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_type    TEXT    NOT NULL,
      topic_id      INTEGER,
      sent_at       TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_el_user_event ON email_logs(user_id, event_type, topic_id, sent_at);
  `);

  // Logs 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      type        TEXT    NOT NULL DEFAULT 'system',
      level       TEXT    NOT NULL DEFAULT 'info',
      user_id     INTEGER,
      username    TEXT,
      action      TEXT    NOT NULL,
      detail      TEXT,
      ip          TEXT,
      user_agent  TEXT,
      created_at  TEXT    DEFAULT (datetime('now','localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_logs_type ON logs(type);
    CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
    CREATE INDEX IF NOT EXISTS idx_logs_user_id ON logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at);
  `);

  // Migration: add bio column for existing databases
  try { db.exec('ALTER TABLE users ADD COLUMN bio TEXT DEFAULT \'\''); } catch(e) {}
  // Migration: add nickname column for existing databases
  try { db.exec('ALTER TABLE users ADD COLUMN nickname TEXT DEFAULT \'\''); } catch(e) {}
  // Initialize nickname for users that don't have one
  db.prepare("UPDATE users SET nickname = username WHERE nickname = '' OR nickname IS NULL").run();
  // Migration: add title/content columns for system notifications
  try { db.exec('ALTER TABLE notifications ADD COLUMN title TEXT DEFAULT \'\''); } catch(e) {}
  try { db.exec('ALTER TABLE notifications ADD COLUMN content TEXT DEFAULT \'\''); } catch(e) {}
  // Migration: add email_notify column for email notification preferences
  try { db.exec('ALTER TABLE users ADD COLUMN email_notify INTEGER NOT NULL DEFAULT 0'); } catch(e) {}
  // Migration: add token_version for JWT invalidation (v2.5)
  try { db.exec('ALTER TABLE users ADD COLUMN token_version INTEGER DEFAULT 1'); } catch(e) {}
  // Migration: add attempts column for verification code retry tracking
  try { db.exec('ALTER TABLE verification_codes ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0'); } catch(e) {}

  createTriggers(db);
  seedData(db);
  seedSettings(db);

  try {
    const { logSystem } = require('../utils/logger');
    logSystem('数据库初始化完成');
  } catch (e) {}

  console.log('[DB] 数据库初始化完成');
}

function createTriggers(db) {
  // topics.reply_count: +1 when reply inserted
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_reply_count_inc
    AFTER INSERT ON replies
    BEGIN
      UPDATE topics SET reply_count = reply_count + 1 WHERE id = NEW.topic_id;
    END;
  `);

  // topics.reply_count: -1 when reply deleted
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_reply_count_dec
    AFTER DELETE ON replies
    BEGIN
      UPDATE topics SET reply_count = MAX(reply_count - 1, 0) WHERE id = OLD.topic_id;
    END;
  `);

  // topics.like_count: +/- 1 on like insert/delete for topic
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_topic_like_inc
    AFTER INSERT ON likes
    WHEN NEW.topic_id IS NOT NULL
    BEGIN
      UPDATE topics SET like_count = like_count + 1 WHERE id = NEW.topic_id;
    END;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_topic_like_dec
    AFTER DELETE ON likes
    WHEN OLD.topic_id IS NOT NULL
    BEGIN
      UPDATE topics SET like_count = MAX(like_count - 1, 0) WHERE id = OLD.topic_id;
    END;
  `);

  // replies.like_count: +/- 1 on like insert/delete for reply
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_reply_like_inc
    AFTER INSERT ON likes
    WHEN NEW.reply_id IS NOT NULL
    BEGIN
      UPDATE replies SET like_count = like_count + 1 WHERE id = NEW.reply_id;
    END;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_reply_like_dec
    AFTER DELETE ON likes
    WHEN OLD.reply_id IS NOT NULL
    BEGIN
      UPDATE replies SET like_count = MAX(like_count - 1, 0) WHERE id = OLD.reply_id;
    END;
  `);

  // categories.topic_count: +1 when topic inserted
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_category_topic_inc
    AFTER INSERT ON topics
    BEGIN
      UPDATE categories SET topic_count = topic_count + 1 WHERE id = NEW.category_id;
    END;
  `);

  // categories.topic_count: -1 when topic deleted
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_category_topic_dec
    AFTER DELETE ON topics
    BEGIN
      UPDATE categories SET topic_count = MAX(topic_count - 1, 0) WHERE id = OLD.category_id;
    END;
  `);
}

function seedData(db) {
  const adminCount = db.prepare('SELECT COUNT(*) AS cnt FROM users WHERE role = ?').get('admin');
  if (adminCount.cnt > 0) return;

  // 创建管理员
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO users (username, password_hash, nickname, email, role) VALUES (?, ?, ?, ?, ?)').run(
    'admin', hash, 'admin', 'admin@forum.local', 'admin'
  );

  // 创建测试用户
  const userHash = bcrypt.hashSync('123456', 10);
  const testUsers = ['程序员老张', '前端小鱼', '后端大刘', '全栈小王', '设计师小美', '产品经理老陈'];
  const insertUser = db.prepare('INSERT INTO users (username, password_hash, nickname, email, role) VALUES (?, ?, ?, ?, ?)');
  for (const name of testUsers) {
    insertUser.run(name, userHash, name, name + '@test.com', 'user');
  }

  // 创建版块
  const insertCat = db.prepare('INSERT INTO categories (name, description, sort_order) VALUES (?, ?, ?)');
  const categories = [
    ['技术交流', '编程、架构、前沿技术讨论', 1],
    ['项目合作', '找伙伴、接外包、开源项目', 2],
    ['职业发展', '面试经验、职场心得、学习路径', 3],
    ['灌水闲聊', '工作之余，随便聊聊', 4],
  ];
  for (const c of categories) {
    insertCat.run(c[0], c[1], c[2]);
  }

  // 创建示例帖子
  const insertTopic = db.prepare(
    'INSERT INTO topics (title, content, category_id, user_id, is_essence, is_pinned) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertReply = db.prepare('INSERT INTO replies (content, topic_id, user_id, floor) VALUES (?, ?, ?, ?)');

  const topics = [
    {
      title: '2024 年前端技术趋势总结',
      content: '分享我对今年前端技术发展的观察：React Server Components、Vite 生态、Bun 运行时...',
      cat: 1, user: 2, essence: 1, pinned: 1,
      replies: ['React RSC 确实是大趋势', 'Vite 太好用了', 'Bun 性能真的很强'],
    },
    {
      title: '如何从零搭建一个 Node.js 项目',
      content: '从目录结构、环境变量管理、数据库选型到部署上线，完整分享我的经验。',
      cat: 1, user: 3, essence: 1, pinned: 0,
      replies: ['学到了，感谢分享', '中间件部分讲得很清楚'],
    },
    {
      title: '找个前端合伙人一起做开源项目',
      content: '我做了一个后台管理模板的后端部分，希望找一位前端同学一起完善。技术栈 Vue3 + Express + PostgreSQL。',
      cat: 2, user: 4, essence: 0, pinned: 0,
      replies: ['我可以，加你了', '有没有 React 的项目？'],
    },
    {
      title: '大厂面试经验分享（2024 版）',
      content: '年初面试了一圈，整理了高频算法题、系统设计题的应对思路，以及 HR 面的注意事项。',
      cat: 3, user: 5, essence: 1, pinned: 0,
      replies: ['mark 一下', '请问系统设计怎么准备？', '已收藏'],
    },
    {
      title: '大家周末都做什么？',
      content: '连续加班三周了，这周末终于能休息，求推荐放松方式。',
      cat: 4, user: 6, essence: 0, pinned: 0,
      replies: ['睡觉！', '去爬山', '打游戏'],
    },
  ];

  for (const t of topics) {
    const result = insertTopic.run(t.title, t.content, t.cat, t.user, t.essence, t.pinned);
    const topicId = result.lastInsertRowid;
    for (let i = 0; i < t.replies.length; i++) {
      insertReply.run(t.replies[i], topicId, i + 2, i + 1);
    }
  }

  console.log('[DB] 种子数据已插入');
}

function seedSettings(db) {
  const count = db.prepare('SELECT COUNT(*) AS cnt FROM settings').get();
  if (count.cnt > 0) return;

  const insert = db.prepare('INSERT INTO settings (key, value, type) VALUES (?, ?, ?)');
  const seeds = [
    ['site_name', 'MonkeyCode 社区', 'string'],
    ['site_description', '发现精彩，参与讨论', 'string'],
    ['site_logo', '', 'url'],
    ['footer_text', '论坛 — 轻量级社区系统', 'string'],
    ['enable_register', 'true', 'boolean'],
    ['enable_new_topic', 'true', 'boolean'],
    ['enable_reply', 'true', 'boolean'],
    ['enable_notifications', 'true', 'boolean'],
    ['page_size', '20', 'number'],
    ['site_closed', 'false', 'boolean'],
  ];
  for (const s of seeds) {
    insert.run(s[0], s[1], s[2]);
  }
  console.log('[DB] Settings 种子数据已插入');
}

module.exports = { getDb, initDatabase };
