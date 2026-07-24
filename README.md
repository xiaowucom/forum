# 🐵 MonkeyCode 论坛

> 轻量级论坛系统 — Node.js + Express + SQLite + EJS 服务端渲染

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-2.9.0-green.svg)](https://github.com/xiaowucom/forum/releases/tag/v2.9.0)

---

## 🚀 快速开始

### 本地开发

```bash
# 安装依赖
npm install

# 启动服务（自动初始化数据库并插入种子数据）
npm start
```

服务默认运行在 `http://localhost:3100`。

### 生产部署

```bash
# 克隆代码
cd /var/www/forum
git clone https://github.com/xiaowucom/forum.git .
npm install

# 启动（推荐 systemd + Nginx 反向代理）
node server.js
```

生产部署路径：`/var/www/forum`，反向代理域名：`bbs.xiaowu.live`（HTTPS）。

---

## 🔑 默认账号

首次启动自动创建以下种子数据：

| 角色 | 用户名 | 密码 |
|------|--------|------|
| 管理员 | admin | 见环境变量 `ADMIN_DEFAULT_PASSWORD`（默认 admin123） |
| 测试用户 | 程序员老张 / 前端小鱼 / 后端大刘 / 全栈小王 / 设计师小美 / 产品经理老陈 | 默认 password123 |

> ⚠️ 生产环境部署后请立即修改管理员密码。

---

## 📋 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 3100 | 服务端口 |
| `FORUM_JWT_SECRET` | 内置开发用默认值 | JWT 签名密钥，**生产环境必须修改** |
| `ADMIN_DEFAULT_PASSWORD` | admin123 | 管理员初始密码 |
| `USER_DEFAULT_PASSWORD` | password123 | 测试用户初始密码 |
| `SMTP_USERS` | — | SMTP 邮箱账号（逗号分隔多账号） |
| `SMTP_PASSWORDS` | — | SMTP 邮箱密码 |

---

## 🛠️ 技术栈

| 层 | 技术 |
|----|------|
| 运行时 | Node.js 22 |
| 框架 | Express ^4.18 |
| 数据库 | SQLite (better-sqlite3 ^11) |
| 模板引擎 | EJS 服务端渲染 |
| 认证 | JWT (httpOnly Cookie, SameSite Lax) |
| 安全 | bcryptjs 密码哈希, DOMPurify XSS 防护, express-validator 输入校验, express-rate-limit 速率限制 |
| 部署 | Systemd + Nginx 反向代理, 阿里云 ECS |

---

## 📁 目录结构

```
forum/
├── server.js              # 入口
├── db/init.js             # 建表 + 触发器 + 种子数据
├── middleware/auth.js      # JWT 认证中间件
├── routes/
│   ├── auth.js            # 注册/登录/登出
│   ├── categories.js      # 版块管理
│   ├── topics.js          # 帖子 + 点赞 + 搜索
│   ├── replies.js         # 回复 + 点赞
│   └── admin.js           # 管理后台
├── views/                 # EJS 页面
│   ├── layout.ejs
│   ├── home.ejs           # 首页（版块列表）
│   ├── category.ejs       # 版块内帖子列表
│   ├── topic.ejs          # 帖子详情 + 回复
│   ├── new-topic.ejs      # 发帖
│   ├── edit-topic.ejs     # 编辑帖子
│   ├── login.ejs          # 登录
│   ├── register.ejs       # 注册
│   ├── search.ejs         # 搜索
│   └── admin/
│       ├── dashboard.ejs  # 仪表盘
│       ├── users.ejs      # 用户管理
│       └── categories.ejs # 版块管理
├── public/style.css       # 全站样式
└── SPEC.md                # 设计规格说明书
```

---

## 🌟 功能特性

- ✅ **用户系统** — 注册、登录、JWT 鉴权、token_version 强制下线
- ✅ **版块管理** — 多版块、排序、发帖/回复权限控制
- ✅ **帖子系统** — Markdown 发帖、编辑、删除、置顶、精华
- ✅ **回复系统** — 楼中楼、编辑、删除
- ✅ **点赞系统** — 帖子/回复点赞 + 通知作者
- ✅ **消息通知** — 回复/点赞/系统消息通知中心
- ✅ **全站搜索** — 按标题/内容/用户名/版块搜索 + 关键字高亮
- ✅ **个人中心** — 资料编辑、头像（上传/URL/QQ）、我的帖子、我赞过的
- ✅ **邮箱体系** — 多账号 SMTP 故障转移、验证码、找回密码、邮件通知
- ✅ **后台管理** — 用户/帖子/版块/设置管理 + 操作日志 + 统计图表
- ✅ **安全机制** — XSS 防护、SQL 注入防护、bcrypt 密码、限流、操作日志审计

---

## 📖 API 文档

完整 RESTful API 接口清单（共 50+ 端点）见 [SPEC.md](SPEC.md) 第 4 节。

涵盖了认证、版块、帖子、回复、通知、搜索、管理后台等全部接口。

---

## 🔗 相关链接

- [在线论坛](https://bbs.xiaowu.live) — 已部署在生产环境，Nginx + HTTPS
- [GitHub 仓库](https://github.com/xiaowucom/forum)
- [发布版本](https://github.com/xiaowucom/forum/releases)

---

> ⚡ 这是一个纯个人项目，代码风格和功能迭代主打一个"够用就行"。
