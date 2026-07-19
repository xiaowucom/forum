# 论坛系统

轻量级论坛系统，Node.js + Express + SQLite + EJS 服务端渲染。

## 快速启动

```bash
# 安装依赖
npm install

# 启动服务（自动初始化数据库并插入种子数据）
npm start
```

服务默认运行在 `http://localhost:3100`。

## 默认账号

首次启动时自动创建以下种子数据：

| 角色 | 用户名 | 密码 |
|------|--------|------|
| 管理员 | admin | 见环境变量 `ADMIN_DEFAULT_PASSWORD`（默认 admin123） |
| 测试用户 | 程序员老张 / 前端小鱼 / 后端大刘 / 全栈小王 / 设计师小美 / 产品经理老陈 | 见环境变量 `USER_DEFAULT_PASSWORD`（默认 password123） |

> 生产环境部署后请立即修改管理员密码。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 3100 | 服务端口 |
| `FORUM_JWT_SECRET` | 内置开发用默认值 | JWT 签名密钥，**生产环境必须修改** |

## 技术栈

- 后端：Express ^4.18
- 数据库：SQLite (better-sqlite3 ^11)
- 前端：EJS 服务端渲染
- 认证：JWT (httpOnly cookie, SameSite Lax)
- 安全：bcryptjs 密码哈希, DOMPurify XSS 防护, express-validator 输入校验, express-rate-limit 速率限制

## 目录结构

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
├── public/style.css       # 样式
└── SPEC.md                # 设计规格说明书
```

## 数据库

SQLite 单文件 `db/forum.db`，首次启动时自动创建并插入种子数据（1 管理员 + 6 测试用户 + 4 版块 + 5 示例帖子）。

无需手动执行初始化脚本，`server.js` 启动时会调用 `initDatabase()`。

如需重置数据库，删除 `db/forum.db` 后重启服务即可。

## API 接口

完整接口清单见 `SPEC.md` 第 5 节。共 21 个 RESTful API 端点，涵盖认证、版块、帖子、回复、管理后台。

## 已知待办

- [ ] 生产环境取消 `server.js` 中 `app.set('trust proxy', 1)` 的注释（部署在 Nginx 反向代理后面时必须启用）
- [ ] 错误处理根据 `NODE_ENV` 判断，生产环境不暴露 `err.stack`
- [ ] `user` 变量目前由每个 `res.render()` 显式传入，长期建议改为 `authenticate` 中间件里 `res.locals.user` 统一挂载
- [ ] `topics.view_count` 目前每次访问 +1，未来可优化为同一用户/IP 限时只计一次
- [ ] 生产环境修改 `FORUM_JWT_SECRET` 环境变量，替换默认开发密钥
