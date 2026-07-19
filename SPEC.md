# 论坛项目技术规格说明书

**版本**: v2.9
**更新日期**: 2026-07-19

---

## 0. 项目定位与非目标

这是一个小型论坛项目，用户规模预期不大（接近百人社区或更小）。基于此定位，以下功能已明确决定**不做**，后续不再讨论或提起：

| 不做事项 | 理由 |
|---------|------|
| 私信系统 | 10.1~10.4 方案曾经确认过，现决定不做。小社区在帖子里直接交流已经足够 |
| 举报功能 + 内容审核队列 | 管理员人数少，人工巡查帖子列表 + 删除操作已覆盖内容治理需求 |
| 帖子分级置顶 | 首页置顶/版块内置顶的区别。现有单一 `is_pinned` 状态足够，无需细分 |
| 无限滚动改造 | 帖子量不大，现有分页翻页体验足够，保持 SSR 第 1 页 + JS 异步翻页 |
| 单设备登录（阶段二） | allow_multi_device 方案仅在真正有多用户场景需求时才评估，附录 D 保留 |

---

## 0.1 开发协作模式

本项目当前采用双模型协作开发：

| 角色 | 模型 | 职责 |
|------|------|------|
| 后端/功能开发 | **DeepSeek** | 数据库 schema、路由 API、JWT 鉴权、消息通知系统、论坛核心逻辑 |
| UI/视觉/全栈迭代 | **kimi-k2.6** | CSS 样式系统、EJS 模板结构、动画效果、响应式布局、设计规范、全栈功能开发 |

v2.1+ 起 kimi-k2.6 承担全部功能开发+UI 工作，包括后台管理全套、搜索系统、通知中心升级、弹窗/Toast 系统重构、邮箱体系、头像系统、中间件日志注入等端到端实现。

---

## 1. 项目概述

基于 Node.js + Express + SQLite + EJS 的全栈论坛系统，支持版块管理、帖子发布、Markdown 渲染、点赞、权限控制、JWT 鉴权、系统消息通知、全站搜索、后台统计图表、操作日志审计。

### 技术栈

| 层 | 技术 |
|----|------|
| 运行时 | Node.js 22 |
| 框架 | Express 4 |
| 数据库 | SQLite (better-sqlite3) |
| 模板引擎 | EJS (SSR + JS 异步翻页) |
| 鉴权 | JWT (Cookie httpOnly) |
| Markdown | marked + DOMPurify (服务端预渲染) |
| 密码 | bcryptjs |
| 文件上传 | multer |
| 输入校验 | express-validator |
| 限流 | express-rate-limit |
| 图表 | Chart.js 4.4.0 (CDN，仅后台加载) |
| 生产部署 | systemd + Nginx 反向代理，阿里云 ECS |

---

## 2. 数据库结构

### 2.1 users

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | |
| username | TEXT UNIQUE | 3-20 字符，支持中英文数字下划线，登录账号，不可修改 |
| password_hash | TEXT | bcrypt |
| email | TEXT DEFAULT '' | |
| avatar | TEXT DEFAULT '' | 头像（本地路径如 `/uploads/avatars/xxx.png` 或外部 URL 如 QQ 头像地址） |
| bio | TEXT DEFAULT '' | 个人简介，200 字上限 |
| nickname | TEXT DEFAULT '' | **v2.2 新增** — 显示昵称，可自由修改，默认为 username |
| role | TEXT DEFAULT 'user' | 'user' \| 'admin' |
| email_notify | INTEGER DEFAULT 1 | **v2.4 新增** — 邮件通知开关 |
| token_version | INTEGER DEFAULT 1 | **v2.5 新增** — 修改密码时递增，旧 token 失效 |
| created_at | TEXT | datetime('now','localtime') |
| updated_at | TEXT | datetime('now','localtime') |

**v2.2 设计要点**：
- `username`：登录账号，注册后不可修改，保证唯一。登录仅以此字段匹配
- `nickname`：显示昵称，可自由修改，可重复。所有前端展示优先使用 nickname，若 nickname 为空则回退到 username
- 用户注销后（ON DELETE SET NULL），LEFT JOIN 查不到行，username/nickname 均为 NULL，展示"已注销用户"

### 2.2 categories

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | |
| name | TEXT UNIQUE | 版块名称 |
| description | TEXT | 版块描述 |
| sort_order | INTEGER DEFAULT 0 | 排序权重 — 支持管理后台 UI 调整 |
| topic_count | INTEGER DEFAULT 0 | 由触发器自动维护 |
| created_at | TEXT | |

### 2.3 topics

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | |
| title | TEXT | 1-100 字符 |
| content | TEXT | 1-20000 字符，Markdown |
| category_id | INTEGER FK → categories | |
| user_id | INTEGER FK → users | ON DELETE SET NULL |
| is_pinned | INTEGER DEFAULT 0 | 置顶 |
| is_essence | INTEGER DEFAULT 0 | 精华 |
| view_count | INTEGER DEFAULT 0 | |
| reply_count | INTEGER DEFAULT 0 | 触发器自动维护 |
| like_count | INTEGER DEFAULT 0 | 触发器自动维护 |
| created_at | TEXT | |
| updated_at | TEXT | |

### 2.4 replies

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | |
| content | TEXT | |
| topic_id | INTEGER FK → topics | ON DELETE CASCADE |
| user_id | INTEGER FK → users | ON DELETE SET NULL |
| floor | INTEGER | UNIQUE(topic_id, floor) |
| like_count | INTEGER DEFAULT 0 | 触发器自动维护 |
| created_at | TEXT | |
| updated_at | TEXT | |

### 2.5 likes

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | |
| user_id | INTEGER FK → users | ON DELETE CASCADE |
| topic_id | INTEGER FK → topics | topic 或 reply 二选一 |
| reply_id | INTEGER FK → replies | topic 或 reply 二选一 |
| created_at | TEXT | |

UNIQUE(user_id, topic_id)、UNIQUE(user_id, reply_id)。CHECK 约束确保 topic_id/reply_id 互斥。

### 2.6 notifications

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | |
| user_id | INTEGER FK → users | ON DELETE CASCADE |
| type | TEXT | 'reply' \| 'like_topic' \| 'like_reply' \| 'system' |
| actor_id | INTEGER FK → users | ON DELETE SET NULL |
| topic_id | INTEGER FK → topics | ON DELETE CASCADE |
| reply_id | INTEGER FK → replies | ON DELETE CASCADE |
| is_read | INTEGER DEFAULT 0 | 未读/已读标记 |
| title | TEXT DEFAULT '' | 系统消息专用 — 消息标题 |
| content | TEXT DEFAULT '' | 系统消息专用 — 消息正文 |
| created_at | TEXT | datetime('now','localtime') |

**设计要点**：
- `title` 和 `content` 仅在 `type='system'` 时有值
- 全体广播时通过单条 `INSERT INTO ... SELECT` 为每个用户创建通知行
- 去重逻辑：`GET /api/admin/messages/history` 按 `(title, content, created_at, actor_id)` 分组

### 2.7 logs（v2.1 新增）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | |
| type | TEXT DEFAULT 'system' | 日志类型：system/admin/user/security |
| level | TEXT DEFAULT 'info' | 日志等级：info/warning/error |
| user_id | INTEGER | 操作用户 ID（可空） |
| username | TEXT | 操作用户名（可空） |
| action | TEXT NOT NULL | 操作描述 |
| detail | TEXT | 详细信息（可空） |
| ip | TEXT | 客户端 IP |
| user_agent | TEXT | 浏览器 UA（当前未传入，始终 null） |
| created_at | TEXT | datetime('now','localtime') |

索引：`idx_logs_type`、`idx_logs_level`、`idx_logs_user_id`、`idx_logs_created_at`。

### 2.8 settings（v2.1 新增）

| 字段 | 类型 | 说明 |
|------|------|------|
| key | TEXT PK | 设置键名 |
| value | TEXT NOT NULL DEFAULT '' | 设置值 |
| type | TEXT NOT NULL DEFAULT 'string' | 值类型：string/boolean/number |
| updated_at | TEXT | datetime('now','localtime') |

### 2.9 user_settings（v2.2 新增）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | |
| user_id | INTEGER FK UNIQUE | ON DELETE CASCADE |
| email_notify | INTEGER DEFAULT 1 | 邮件通知开关 |
| updated_at | TEXT | datetime('now','localtime') |

### 2.10 triggers

| 触发器 | 触发时机 | 作用 |
|--------|---------|------|
| trg_reply_count_inc | INSERT ON replies | topics.reply_count +1 |
| trg_reply_count_dec | DELETE ON replies | topics.reply_count -1 |
| trg_topic_like_inc | INSERT ON likes (topic) | topics.like_count +1 |
| trg_topic_like_dec | DELETE ON likes (topic) | topics.like_count -1 |
| trg_reply_like_inc | INSERT ON likes (reply) | replies.like_count +1 |
| trg_reply_like_dec | DELETE ON likes (reply) | replies.like_count -1 |
| trg_category_topic_inc | INSERT ON topics | categories.topic_count +1 |
| trg_category_topic_dec | DELETE ON topics | categories.topic_count -1 |

---

## 3. 中间件与鉴权

### 3.1 JWT 方案

- 签名字段: `{ id, username, role, tv }`
- 过期时间: 7 天
- 传输方式: httpOnly Cookie (`forum_token`)
- 全局中间件 `authenticate` 解析 Cookie → `req.user`
- `token_version` 校验：每次请求比对 JWT 中的 `tv` 与数据库当前值，不匹配则清 Cookie + 标记 `req.tokenExpired`

### 3.2 requireAuth / requireAdmin

- `requireAuth`: 检查 `req.user`，未登录返回 302 `/login?redirect=原路径`（API 返回 401）
- `requireAdmin`: 检查 `req.user.role === 'admin'`，否则返回 403
- token_version 不匹配时：页面请求重定向 `/login?kicked=1`，API 请求返回 401 code=TOKEN_EXPIRED

### 3.3 限流

- 全局限流: 100 req/min
- 登录/注册: 10 req/min
- 发帖: 5 req/min
- 回复: 5 req/min
- 验证码发送: 1 req/min per email

### 3.4 日志中间件（v2.1 新增）

`server.js` 中 `app.use()` 注册，使用 `res.on('finish')` 在响应完成后异步记录操作日志。按路由模式匹配确定 action 类型，覆盖约 20 种操作事件。

---

## 4. 路由总览

### 4.1 公开 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/auth/register | 注册并自动登录 |
| POST | /api/auth/login | 登录返回 JWT |
| POST | /api/auth/logout | 清除 Cookie |
| POST | /api/auth/send-code | **v2.4 新增** — 发送邮箱验证码（注册/找回密码/修改邮箱共用） |
| POST | /api/auth/reset-password | **v2.4 新增** — 第一阶段：验证邮箱 → 发验证码 |
| POST | /api/auth/reset-password-confirm | **v2.4 新增** — 第二阶段：验证码 + 新密码 |
| GET | /api/categories | 版块列表 (ORDER BY sort_order ASC, id ASC) |
| GET | /api/topics | 帖子列表 (支持 category_id/search/pagination) |
| GET | /api/topics/:id | 帖子详情 |
| GET | /api/topics/:topicId/replies | 回复列表 |
| GET | /api/search | **v2.1** — 搜索帖子 (支持 scope/sort/pagination) |

### 4.2 需登录 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/auth/me | 获取当前用户信息 |
| PUT | /api/auth/profile | 更新 nickname/avatar/bio |
| PUT | /api/auth/email | **v2.3** — 绑定/修改邮箱（格式校验） |
| PUT | /api/auth/settings | **v2.3** — 更新用户偏好设置 |
| PUT | /api/auth/password | **v2.5** — 修改密码（需验证当前密码，bcrypt） |
| POST | /api/auth/avatar/upload | **v2.7** — 本地上传头像（multer，PNG/JPG/GIF/WebP，2MB） |
| POST | /api/auth/avatar/qq | **v2.7** — 输入 QQ 号获取头像 URL（校验 5-11 位数字） |
| POST | /api/topics | 发帖 |
| PUT | /api/topics/:id | 编辑帖子 (作者/管理员) |
| DELETE | /api/topics/:id | 删除帖子 (作者/管理员) |
| PUT | /api/topics/:id/move | **v2.4 新增** — 管理员移动帖子到其他版块（同步 topic_count） |
| POST | /api/topics/:id/like | 点赞/取消点赞帖子 (+ 通知帖主) |
| PUT | /api/topics/:id/pin | requireAdmin — 置顶/取消 |
| PUT | /api/topics/:id/essence | requireAdmin — 精华/取消 |
| POST | /api/topics/:topicId/replies | 发表回复 (+ 通知帖主) |
| PUT | /api/replies/:id | 编辑回复 (作者/管理员) |
| DELETE | /api/replies/:id | 删除回复 (作者/管理员) |
| POST | /api/replies/:id/like | 点赞/取消点赞回复 (+ 通知回复者) |
| GET | /api/notifications | 通知列表 (支持 ?type=reply\|like\|system) |
| PUT | /api/notifications/:id/read | 标记单条已读 |
| PUT | /api/notifications/read-all | 全部已读 (支持 ?type=) |
| DELETE | /api/notifications/:id | 删除单条通知 |
| GET | /api/notifications/unread-count | 未读数 |

### 4.3 管理后台 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/admin/stats | 仪表盘统计数据 |
| GET | /api/admin/stats/charts | 7 天活跃趋势 + Top5 排名 |
| GET | /api/admin/users | 用户列表 (支持 search) |
| PUT | /api/admin/users/:id/role | 修改用户角色 |
| DELETE | /api/admin/users/:id | 删除用户 |
| PUT | /api/admin/users/:id/unbind-email | **v2.5** — 解绑用户邮箱 |
| POST | /api/admin/users/:id/send-reset | **v2.5** — 向用户发送密码重置邮件 |
| POST | /api/categories | 创建版块 |
| PUT | /api/categories/:id | 编辑版块 (含 sort_order) |
| PUT | /api/categories/reorder | 上移/下移调整排序 |
| DELETE | /api/categories/:id | 删除版块 (仅空版块) |
| GET | /api/admin/topics | 帖子管理列表 (支持 category_id/search) |
| GET | /api/admin/settings | 获取全部配置 |
| PUT | /api/admin/settings | 批量更新配置 |
| GET | /api/admin/email-status | **v2.6 新增** — SMTP 账号健康状态 |
| POST | /api/admin/email-test | **v2.6 新增** — 测试发信 |
| POST | /api/admin/upload-logo | **v2.6 新增** — Logo 上传（multer，2MB） |
| GET | /api/admin/logs | 操作日志列表（支持筛选 + 分页） |
| POST | /api/admin/messages | 发送系统消息 |
| GET | /api/admin/messages/history | 系统消息发送记录 (去重) |

### 4.4 页面路由 (SSR)

| 路由 | 模板 | 鉴权 | 说明 |
|------|------|------|------|
| GET / | home | 公开 | 首页 — Hero + 最新帖子流 |
| GET /category/:id | category | 公开 | 版块帖子列表 |
| GET /topic/:id | topic | 公开 | 帖子详情 |
| GET /topic/new | new-topic | requireAuth | 发帖页（支持 ?category_id= 预选版块） |
| GET /topic/:id/edit | edit-topic | requireAuth | 编辑帖子页 |
| GET /login | login | 公开 | 登录页（支持 ?kicked=1 强制下线提示） |
| GET /register | register | 公开 | 注册页 |
| GET /search | search | 公开 | 搜索页 |
| GET /categories | categories | 公开 | 全部版块浏览 |
| GET /messages | messages | requireAuth | 消息流（类型标签页 + 时间分组） |
| GET /profile | profile | requireAuth | 个人中心主页 |
| GET /profile/topics | profile/topics | requireAuth | 我的帖子 |
| GET /profile/likes | profile/likes | requireAuth | 我赞过的内容 |
| GET /profile/settings | profile/settings | requireAuth | 账号设置（邮箱/密码/通知） |
| GET /profile/password | profile/password | requireAuth | 修改密码 |
| GET /user/:id | user | 公开 | 公开用户主页 |
| GET /admin | admin/dashboard | requireAdmin | 管理后台概览 |
| GET /admin/users | admin/users | requireAdmin | 用户管理 |
| GET /admin/categories | admin/categories | requireAdmin | 版块管理 |
| GET /admin/topics | admin/topics | requireAdmin | 帖子管理 |
| GET /admin/messages | admin/messages | requireAdmin | 系统消息 |
| GET /admin/settings | admin/settings | requireAdmin | 站点设置 |
| GET /admin/logs | admin/logs | requireAdmin | 日志中心 |

---

## 5. 底部 Tab 导航栏

```
首页(SVG房子)  |  版块(SVG网格)  |  发布(48px紫色圆)  |  消息(SVG对话)  |  我的(SVG人形)
```

- 文件: `views/partials/tabbar.ejs`
- 定位: `position: fixed; bottom: 0; height: 64px; z-index: 90`
- 背景: `rgba(255,255,255,.92)` + `backdrop-filter: blur(16px)`
- 发布按钮: 48x48px 紫色圆形 `＋`
- 消息 Tab 红色角标显示未读数，`updateBadge()` 全局函数
- 管理后台页面隐藏 Tab 栏

### 5.1 v2.7 发布流程增强

点击发布按钮的行为按页面上下文区分：

| 当前页面 | 行为 |
|---------|------|
| 首页 / 帖子页 / profile / 等普通页面 | 弹出快速版块选择层（复用 `.cat-chip` 样式，图标首字母 + 色块 + 名称） |
| 版块内页 `/category/:id` | **跳过选择层**，直接跳转 `/topic/new?category_id=X`（当前版块自动预选） |

选择层数据通过 `GET /api/categories` 异步获取，首次打开后缓存。关闭方式：点击遮罩层或右上角 × 按钮。

发帖页接收到 `?category_id=` 参数后自动选中对应版块 chip，版块选择器保留以供用户改选。

### 5.2 防遮挡处理

`.main-content` 的 `padding-bottom` 设为 `72px`（64px Tab 栏 + 8px 缓冲）。管理后台页面添加 `main-content--no-tab` 类恢复为 `28px`。

---

## 6. Header 设计

- 左侧: "MonkeyCode 社区" Logo，点击回首页
- 右侧: 搜索图标 → 跳转 /search
- 未登录: 搜索图标旁显示 "登录" 按钮
- 背景: `rgba(255,255,255,.82)` + `backdrop-filter: blur(20px) saturate(1.4)`

---

## 7. 消息通知系统

### 7.1 通知类型

| type | 触发条件 | 前端渲染 |
|------|---------|---------|
| reply | 有人回复你的帖子 | "{actor} 回复了你" + 跳转帖子 |
| like_topic | 有人点赞你的帖子 | "{actor} 赞了你的帖子" + 跳转帖子 |
| like_reply | 有人点赞你的回复 | "{actor} 赞了你的回复" + 跳转帖子 |
| system | 管理员发送系统消息 | 标题 + "管理员 · 时间" + 展开正文 |

`createNotification()` 内部自动跳过 `userId === actorId`（不自通知）。

---

## 8. 弹窗与 Toast 组件（v2.1）

### 8.1 showConfirm(message, options)

自定义确认模态框（取代 `confirm()`）。支持 `danger` 模式（红色标题+按钮）、自定义按钮文字。返回 Promise。

### 8.2 showToast(message, type)

轻量 Toast，页面顶部居中滑入（`toastSlideIn`），2.5 秒后滑出（`toastSlideOut`）。type: `'success'`（青绿）/ `'error'`（红色）。

### 8.3 跨页面 Toast

`sessionStorage.setItem('toast_msg', ...)` → 下页 `DOMContentLoaded` 读取并展示。

---

## 9. 邮箱功能体系（v2.4）

### 9.1 SMTP 多账号故障转移

`utils/mailer.js` — 环境变量 `SMTP_USERS`、`SMTP_PASSWORDS`（逗号分隔多账号），发送时依次尝试，遇 ECONNRETRY 等临时错误自动切换到下一个 SMTP 账号。

### 9.2 发送邮箱验证码

`utils/code-utils.js` — `generateCode()` 生成 6 位数字验证码，`storeCode()` 存入内存（5 分钟 TTL），`verifyCode()` 校验。同一邮箱每小时限发 3 次。

### 9.3 邮箱功能清单

| 功能 | API | 说明 |
|------|-----|------|
| 注册邮箱验证 | `POST /api/auth/register` | 可选填写邮箱 + 验证码，受 `force_verify_email` 配置控制 |
| 找回密码 | `POST /api/auth/reset-password` → `POST /api/auth/reset-password-confirm` | 两阶段：验证邮箱 → 发验证码 → 设置新密码 |
| 修改邮箱 | `PUT /api/auth/email` | 向新邮箱发验证码，验证后更新（QQ 邮箱自动检测截取 QQ 号） |
| 邮件通知 | `user_settings.email_notify` | 控制是否接收回复/点赞/系统消息邮件 |
| 全局邮件开关 | `global_email_notify` config | 全站邮件总闸，关闭后所有邮件不发送 |
| 管理员测试发信 | `POST /api/admin/email-test` | 后端直接调用 sendMail |
| SMTP 健康追踪 | `GET /api/admin/email-status` | per-account：成功/失败计数、最近错误、历史记录（内存存储） |

### 9.4 邮件通知触发器

在 `routes/replies.js`、`routes/topics.js`、`routes/admin.js` 的相应操作点注入邮件发送：
- 新回复通知帖主
- 新点赞通知作者
- 管理员发送系统消息

每个注入点检查 `global_email_notify` 和接收者的 `email_notify` 开关，两者均为 true 时才发送。

---

## 10. 头像系统（v2.7）

### 10.1 四种设置方式

| 方式 | 前端入口 | 实现 |
|------|---------|------|
| 本地上传 | "上传图片"标签页 → 选择文件 → 点上传 | multer 接收 → `/uploads/avatars/avatar_xxx.png`，限制 PNG/JPG/GIF/WebP、2MB |
| 填写 URL | "填写链接"标签页 → 输入 URL | 直接使用用户输入的 URL 字符串 |
| 输入 QQ 号 | "输入QQ号"标签页 → 输入号码 → 获取头像 | `POST /api/auth/avatar/qq` 校验 5-11 位纯数字 → 返回 `https://q1.qlogo.cn/g?b=qq&nk={QQ}&s=100` |
| QQ 邮箱快捷 | "输入QQ号"标签页下方快捷按钮 | 仅绑定纯数字 @qq.com 时显示，自动提取数字部分作为 QQ 号 |

10.2 存储

上传目录 `public/uploads/avatars/`，服务器启动时自动创建。`avatar` 字段存最终 URL/路径（`string` 类型），通过 `PUT /api/auth/profile` 写入。

---

## 11. Logo 双模式设置（v2.6）

| 方式 | 实现 |
|------|------|
| URL 输入 | 在设置页"基础设置"标签页直接填写外部图片地址 |
| 本地上传 | `POST /api/admin/upload-logo` → `/uploads/logo_xxx.png`，限制 PNG/JPG/GIF/WebP/SVG、2MB |

两种方式二选一，最终存入 `site_logo` 字段（`string` 类型，兼容本地路径和外部 URL）。

---

## 12. 个人中心系统

### 12.1 页面结构

v2.8 重构后，profile 页和 settings 页取消所有文字分组标题，改为卡片容器 + 细横线分割线传达分类关系：

**profile 页** 分四个区域：个人信息卡片（头像+昵称+简介）、数据统计、内容入口卡片（我的帖子 / 我赞过的 / 我的收藏）、管理卡片（管理后台 + 账号设置）、退出登录。

**settings 页** 分三张卡片：邮箱卡片（当前邮箱+修改输入框，独立）、安全与通知卡片（修改密码 / 邮件通知 toggle，v2.8 合并）、关于卡片（版本 / 用户协议 / 隐私政策）。

卡片内部通过 `.profile-menu-item` 的 `border-bottom` 分割每行选项，`last-child` 去掉底部线条。

### 12.2 子页面

| 路由 | 页面 | 说明 |
|------|------|------|
| /profile/topics | 我的帖子 | 独立分页列表 |
| /profile/likes | 我赞过的内容 | 按点赞时间倒序 |
| /profile/settings | 账号设置页 | 三张无标题卡片：邮箱修改（独立）、修改密码+通知（合并）、关于信息。v2.8 取消分类标题 |
| /profile/password | 修改密码 | 当前密码 + 新密码 + 确认新密码，成功后带 kicked 参数跳转登录页 |

### 12.3 公开用户主页

`GET /user/:id` — 任何人均可查看，展示用户信息卡片 + 统计 + 最新帖子列表。当 `profileUser.id === user.id` 时标记 `isSelf`，隐藏编辑按钮。

### 12.4 全站昵称展示

所有前端展示位置使用 `nickname`（空时回退 `username`），三层兜底：`escapeHTML(t.nickname || t.username)`，两者均为 NULL 时显示"已注销用户"。

---

## 13. 后台管理系统

### 13.1 7 个管理页面

| 页面 | 路由 | 功能 |
|------|------|------|
| 概览 | /admin | 统计卡片（用户/帖子/回复/版块）+ Chart.js 图表（7 天趋势 + Top5 排名），30 秒自动刷新 |
| 用户管理 | /admin/users | 卡片列表 + 实时搜索 + 角色变更 + 删除 + 解绑邮箱 + 发送重置邮件 |
| 版块管理 | /admin/categories | 创建/编辑/删除 + 上移/下移排序 |
| 系统消息 | /admin/messages | 发送全体/单用户消息 + 发送记录 |
| 帖子管理 | /admin/topics | 筛选 + 置顶/精华/移动版块/删除 |
| 设置 | /admin/settings | 双标签页（基础设置 / 邮件管理），15 个配置项全部中文标签 |
| 日志中心 | /admin/logs | 筛选（关键字/类型/等级/用户/日期范围）+ 卡片列表 + 展开详情 + 分页 |

### 13.2 后台导航栏

顶部横向导航栏，7 个页面完整覆盖，桌面 flex 横排，移动端 4 列 grid。

### 13.3 日志中心特性

按 `keyword`、`type`、`level`、`user`、`start`、`end` 筛选，每条日志可展开查看 detail。分页查询。

---

## 14. 搜索系统

`GET /search` — 范围标签页（全部/帖子标题/帖子内容/用户名/版块名称），排序（最新发布/最多回复/最多点赞/最多浏览），关键字 `<mark>` 高亮，内容预览截断 150 字，空态 + 分页。

---

## 15. 安全机制

| 机制 | 实现位置 | 说明 |
|------|---------|------|
| XSS 防护 | `server.js:sanitizeMarkdown()` | marked + DOMPurify 服务端预渲染 |
| SQL 注入防护 | 全局 | better-sqlite3 参数化查询（`?` 占位符），全项目无字符串拼接 SQL |
| 密码安全 | `routes/auth.js` | bcryptjs 10 轮哈希 |
| JWT 安全 | `middleware/auth.js` | httpOnly Cookie，token_version 强制下线 |
| 限流 | `server.js` + 各路由 | express-rate-limit 多等级限流 |
| 管理员权限校验 | `middleware/auth.js:requireAdmin` | 每个管理 API 独立检查 |
| 请求日志 | `server.js:113-177` | 全量操作日志入库 |

---

## 16. 弹窗/Tooltip/Alert 替换完整清单

全站 7 处 `confirm()` + 3 处 `alert()` 已全部替换为 `showConfirm()` + `showToast()`：

| 文件 | 操作 | 新组件 |
|------|------|--------|
| views/admin/topics.ejs | 删除帖子 / 移动版块 | showConfirm(danger) + showToast(success) |
| views/admin/users.ejs | 角色变更 / 删除用户 / 解绑邮箱 / 发送重置 | showConfirm + showToast(success) |
| views/admin/categories.ejs | 删除版块 | showConfirm(danger) + showToast(success) |
| views/messages.ejs | 删除通知 | showConfirm |
| views/topic.ejs | 删除帖子 / 删除回复 / 编辑失败 | showConfirm(danger) + showToast(success/error) + cross-page toast |

---

## 17. 设计规范

### 颜色

| Token | 值 | 用途 |
|-------|-----|------|
| --primary | #7c3aed | 主题紫色 |
| --primary-hover | #6d28d9 | 深紫 hover |
| --primary-light | #ede9fe | 浅紫边框 |
| --primary-subtle | #f5f3ff | 极浅紫背景 |
| --danger | #dc2626 | 危险/删除红色 |
| --bg | #faf8f5 | 页面背景 |
| --surface | #ffffff | 卡片/表单背景 |
| --border | #e8e4db | 边框 |
| --text | #1c1917 | 主文字 |
| --text-muted | #787570 | 次要文字 |
| --text-subtle | #a8a39a | 最淡文字 |

### 圆角/阴影/动画/排版

详见原 SPEC v2.1 设计规范表格（radius: xs/sm//lg/xl，shadow: sm//md/lg/xl，动画: fadeInUp/fadeIn/fadeInScale/slideDown/likeBounce/toastSlideIn/toastSlideOut/floatSlow/pulseGlow，字号: Hero 34px → 辅助 12px）。

---

## 18. 文件清单

### 核心逻辑

| 文件 | 用途 |
|------|------|
| `server.js` | Express 入口 + 页面路由 + 全局日志中间件 + multer Logo 上传路由 |
| `db/init.js` | SQLite 初始化 + schema + triggers + seed + 迁移块 |
| `middleware/auth.js` | JWT 签名/验证/requireAuth/requireAdmin + token_version 校验 |
| `config.js` | 站点设置全局配置（DEFAULTS/TYPES/loadSettings/getSetting/getBoolean/getNumber） |
| `utils/logger.js` | 日志写入工具 |
| `utils/mailer.js` | SMTP 多账号故障转移 + 健康追踪（recordHealth/getHealth） |
| `utils/code-utils.js` | 邮箱验证码生成/存储/校验/频率限制 |
| `routes/auth.js` | 登录/注册/登出/我/编辑资料/修改密码/邮箱验证/找回密码/头像上传/QQ头像 |
| `routes/topics.js` | 帖子 CRUD + 点赞 + 列表 + 置顶/精华/移动 |
| `routes/replies.js` | 回复 CRUD + 点赞 |
| `routes/categories.js` | 版块 CRUD + 排序调整 |
| `routes/notifications.js` | 通知 API + createNotification 辅助函数 |
| `routes/search.js` | 搜索 API (scope/sort/pagination + 高亮) |
| `routes/admin.js` | 管理后台（统计/图表/用户/帖子/系统消息/设置/邮箱管理） |
| `routes/admin/logs.js` | 日志中心 API (筛选 + 分页) |

### 视图

| 文件 | 用途 |
|------|------|
| `views/layout.ejs` | 全局布局（header + tabbar + main + showConfirm/showToast/跨页 Toast） |
| `views/partials/header.ejs` | 顶部导航 |
| `views/partials/tabbar.ejs` | 底部 5 Tab 栏 + 版块快速选择层 + updateBadge |
| `views/partials/footer.ejs` | 页脚 |
| `views/home.ejs` | 首页 |
| `views/categories.ejs` | 全部版块浏览 |
| `views/category.ejs` | 版块帖子列表 |
| `views/topic.ejs` | 帖子详情（操作按钮三组分隔） |
| `views/new-topic.ejs` | 发帖（色块选择器 + URLSearchParams 自动预选） |
| `views/edit-topic.ejs` | 编辑帖子 |
| `views/login.ejs` | 登录（support ?kicked=1 banner） |
| `views/register.ejs` | 注册（含邮箱验证码流程） |
| `views/search.ejs` | 搜索（范围标签 + 排序 + 高亮 + 分页） |
| `views/messages.ejs` | 消息流（类型标签页 + 时间分组 + 删除） |
| `views/profile.ejs` | 个人中心主页（头像四模式 + 编辑资料弹窗） |
| `views/profile/topics.ejs` | 我的帖子 |
| `views/profile/likes.ejs` | 我赞过的内容 |
| `views/profile/settings.ejs` | 账号设置页 |
| `views/profile/password.ejs` | 修改密码表单 |
| `views/user.ejs` | 公开用户主页 |
| `views/admin/dashboard.ejs` | 管理后台概览 |
| `views/admin/users.ejs` | 用户管理（解绑邮箱 + 发送重置） |
| `views/admin/categories.ejs` | 版块管理 |
| `views/admin/topics.ejs` | 帖子管理 |
| `views/admin/messages.ejs` | 系统消息 |
| `views/admin/settings.ejs` | 站点设置（双标签页 + Logo 双模式 + 邮件管理） |
| `views/admin/logs.ejs` | 日志中心 |

### 静态资源

| 文件 | 用途 |
|------|------|
| `public/style.css` | 全站样式（~3244 行），含完整动画/响应式/组件样式。稳定备份：`style.css.stable-verified-backup` |
| `public/uploads/` | Logo 上传根目录 |
| `public/uploads/avatars/` | 头像上传目录 |

---

## 19. 启动与部署

### 本地开发

```bash
cd /workspace/main-site/forum
node server.js
# → http://localhost:3100
```

### 测试账号

```
admin / admin123        (管理员)
程序员老张 / 123456     (普通用户)
前端小鱼 / 123456       (普通用户)
后端大刘 / 123456       (普通用户)
```

### 生产部署

```
阿里云 ECS: 120.26.243.219
部署路径: /var/www/forum
端口: 3100
Nginx 反向代理: bbs.xiaowu.live:80 → 127.0.0.1:3100
systemd: sudo systemctl restart forum
```

### 重建数据库

```bash
rm -f /workspace/main-site/forum/db/forum.db*
node server.js
```

---

## 20. 已修复 Bug 记录

| Bug | 原因 | 修复 |
|-----|------|------|
| 回复点赞/编辑/删除 404 | routes/replies.js 路由路径未挂载 | 修复路由路径 |
| 点赞按钮无响应 | IIFE 执行顺序不兼容 CDN | 调整脚本加载顺序 |
| 表格溢出截断 | overflow:hidden | 改为 overflow-x:auto + min-width |
| 僵尸进程占端口 | node 进程未清理 | 改用 ss -tlnp + kill PID |
| 个人资料缺少编辑功能 | 无 API + 无 UI | 新增 PUT /api/auth/profile + 模态框 |
| 我的帖子重复展示 | 菜单项 + 列表重复 | 去掉菜单项 |
| Tab 图标风格混乱 | emoji 混用 | 统一为 SVG 线性图标 |
| 版块排序 reorder 路由被 /:id 拦截 | Express 路由顺序错误 | reorder 移到 /:id 之前 |
| iOS Safari 输入框自动放大 | font-size 14px < 16px | font-size → 16px + maximum-scale=1 |
| 日志中心路由崩溃 | require 路径错误 | 修复三处路径 |
| 统计图表 404 | 路由嵌套在 settings 回调内 | 移出为独立模块级路由 |
| admin/topics "加载中"卡死 | deleteTopic 缺少闭合 `});` | 补上闭合 |
| topic.ejs 重复 deleteReply | 旧版函数副本未删除 | 删除重复函数 |
| QQ 号标签页输入框不显示 (v2.7) | switchAvatarMode 中 'qq'.toUpperCase → 'Qq' 不匹配 'QQ' | 改用显式映射字典 `{ upload:'Upload', url:'Url', qq:'QQ' }` |
| 密码修改后无强制下线反馈 (v2.8) | views/profile/password.ejs 修改密码成功后只显示 toast，未执行跳转，用户看不到 token_version 机制生效的视觉确认 | 在 `PUT /api/auth/password` 成功回调中增加 `setTimeout(() => window.location.href = '/login?kicked=1', 800)` |
| 回复列表头像始终显示首字母 (v2.8) | topic.ejs `authorHTML` 忽略 API 返回的 `u.avatar` 字段，始终渲染色块首字母；`.text-avatar` CSS 类缺失定义导致无样式 | authorHTML 改为优先渲染 `<img>` 真实头像（失败回落首字母）；style.css 新增 `.text-avatar`、`.reply-avatar-img`、`.reply-avatar-fallback` 三个 CSS 类 |
| 个人中心/设置页分组标题冗余 (v2.8) | profile.ejs 和 settings.ejs 使用文字标题（内容/管理/邮箱/安全/通知/关于）做分类，占据额外高度 | 移除所有 `<h2 class="profile-section-title">` 分组标题，靠卡片容器和 `border-bottom` 分割线传达分类关系；settings.ejs 中"安全"+"通知"两张卡片合并为一张 |

---

## 21. 附录 A: v2.1 变更摘要 (kimi-k2.6)

新增：搜索 API + 页面、日志中心（logs 表 + logger + API + 页面）、站点设置（settings 表 + config.js + 页面）、Chart.js 后台图表、showConfirm/showToast 弹窗组件、全站 10 处 confirm/alert 替换、跨页面 Toast。

---

## 附录 B: v2.2 变更摘要 (kimi-k2.6)

个人中心重构：nickname/username 拆分、全站昵称替换、个人中心新信息架构、我的帖子独立页面、我赞过的内容页面、头像上传方案设计、修改密码接口设计。

---

## 附录 C: v2.3 变更摘要 (kimi-k2.6)

公开用户主页 /user/:id、统一设置页 /profile/settings（邮箱/密码/通知/关于）、邮箱格式校验、email_notify 开关、admin 页面 Tab 栏隐藏 + padding 修复。

---

## 附录 D: v2.4 变更摘要 (kimi-k2.6)

邮箱功能体系完整实现：SMTP 多账号故障转移（mailer.js）、验证码工具（code-utils.js）、注册邮箱验证、找回密码两阶段方案、修改邮箱验证+通知旧邮箱、邮件通知触发器（回复/点赞/系统消息）、帖子移动版块功能（含 topic_count 同步）、版块描述展示。

---

## 附录 E: v2.5 变更摘要 (kimi-k2.6)

修改密码强制下线：`token_version` 字段、`signToken` 携带 tv、`authenticate` 异步校验、不匹配清除 Cookie 标记 `req.tokenExpired`、API 返回 401 TOKEN_EXPIRED、页面重定向 `/login?kicked=1`、登录页黄色提示横幅。管理员解绑邮箱 + 发送重置邮件。

---

## 附录 F: v2.6 变更摘要 (kimi-k2.6)

后台管理增强：SMTP 健康追踪（recordHealth/getHealth，内存存储，per-account 成功/失败/最近错误/历史）、邮箱测试发信 API、Logo 双模式（上传/URL）、邮件功能三开关（force_verify_email/enable_password_reset/global_email_notify）、设置页重写为双标签页（基础设置/邮件管理）+ 5 个中文标签修复。

---

## 附录 G: v2.7 变更摘要 (kimi-k2.6)

头像系统四模式：本地上传（`POST /api/auth/avatar/upload`，multer，`public/uploads/avatars/`）、填写 URL、输入 QQ 号（`POST /api/auth/avatar/qq`，校验 5-11 位纯数字 → QQ 头像开放接口）、QQ 邮箱快捷提取。编辑资料弹窗三标签页切换（上传图片/填写链接/输入QQ号）。修复 switchAvatarMode 中 `'qq' → 'Qq'` 不匹配 `'QQ'` 导致面板不显示的 bug。

底部发布按钮快速版块选择：点击弹出选择层（复用 .cat-chip 样式，`GET /api/categories` 异步加载），版块内页跳过选择层直接预选当前版块。发帖页接收 `?category_id=` 参数自动选中对应 chip。

---

## 附录 H: v2.8 变更摘要 (kimi-k2.6)

**Bug 修复**：

1. 密码修改后即时跳转：`views/profile/password.ejs` 在 `PUT /api/auth/password` 成功后补上 `setTimeout(() => window.location.href = '/login?kicked=1', 800)`，用户可见 token_version 强制下线效果。（后端 token_version 机制始终完好，仅缺前端跳转反馈。）

2. 回复列表头像显示：`topic.ejs` 的 `authorHTML` 函数改为优先渲染 `<img class="reply-avatar-img">` 真实头像（API 返回的 `u.avatar` 字段），图片加载失败时 `onerror` 自动切换回首字母色块。`style.css` 新增 `.text-avatar`（34px 圆形 flex 居中色块）、`.reply-avatar-img`（34px 圆形图片）、`.reply-avatar-fallback` 三个 CSS 类。

**UI 重构**：

3. 个人中心/设置页精简：`profile.ejs` 和 `profile/settings.ejs` 取消所有 `<h2 class="profile-section-title">` 文字分组标题（内容/管理/邮箱/安全/通知/关于），靠卡片容器本身和 `.profile-menu-item` 的 `border-bottom` 分割线传达分类。settings 页"修改密码"+"邮件通知"合并为一张卡片。页面总高度明显减少，无需频繁滑动。

4. 新增 `escapeHTMLAttr` 辅助函数到 `topic.ejs`，用于 URL 属性值转义。|---|---|---|

---

## 附录 I: v2.9 变更摘要 (kimi-k2.6)

**全局 CSS 缩小**：

全站 66 处 CSS 数值下调 10-15%：body 字号 15→14px、header 高度 56→50px、hero min-height 200→170px、按钮/输入框/表单 padding 收敛、卡片/列表/搜索/通知/表格/分页/模态框/页脚/tabbar 全面缩小、个人中心头像 72→60px + 名称 22→20px。移动端响应式同步适配（tabbar 64→56px 对应底部 padding 72→56px）。

**回复头像修复**：

`style.css` 新增 `.text-avatar`（34px 圆形色块首字母）、`.reply-avatar-img`（34px 圆形图片）、`.reply-avatar-fallback` 三个 CSS 类，配合 `topic.ejs` 中已有的 `authorHTML` 逻辑，修复评论回复区头像始终显示首字母色块的问题。

**页面滑动修复**：

新增 `html { overflow-x: hidden; }` 和 `.main-content { overflow-x: hidden; }`，与已有 `body { overflow-x: hidden; }` 形成三层横向溢出防护，彻底消除页面可随意左右滑动的问题。

**CSS 事故处理与文件保护**：

Subagent 批量编辑导致 style.css 从 3244 行截断至 1116 行（损失约 2100 行）。通过 SSH 从生产服务器取回完整原件覆盖恢复，再重新执行全局缩小。事后建立保护链：
- `style.css.stable-verified-backup`：稳定验证备份，此后任何批量修改前必须以此为基准先复制
- `style.css.backup`：批量修改前的生产原件快照
- `style.css.recovered-from-production`：从服务器取回的生产原件
- 规则：对大范围 CSS 做批量修改前必须先创建带日期戳的备份文件

**生产环境 SSL/HTTPS**：

为 `bbs.xiaowu.live` 申请 Let's Encrypt 证书，更新 Nginx 配置添加 443 端口 SSL 监听 + HTTP→HTTPS 301 跳转，移除重复的 `bbs.conf`。`https://bbs.xiaowu.live/` 现已正常访问论坛。CSS 更新已同步部署到生产服务器。

**JWT 密钥更换**：

将 `FORUM_JWT_SECRET` 从代码内置默认值 `forum-dev-secret-change-in-production`（公开可读的占位符，任何看过源代码的人都能伪造 token）替换为 256 位高熵随机密钥（`crypto.randomBytes(32).toString('hex')`，64 位十六进制字符串），写入 `.env` 文件并同步到生产服务器 `/var/www/forum/.env`。生产服务器上 admin 密码因 shell 传参时 bcrypt `$` 符被误解导致与数据库不匹配，通过 Node 脚本直接操作数据库重置为 `admin123`。重启 forum 服务后验证通过：旧 token 全部失效（未登录状态/访问受限页自动跳转 `?redirect=` 参数指向登录页），新 token 签发与验证正常。

**版块权限功能**：

数据库 `categories` 表新增 `post_restricted`（仅管理员可发帖）和 `reply_restricted`（仅管理员可回复）两个 INTEGER DEFAULT 0 字段。

发帖限制：版块内页将"发帖"按钮替换为灰色提示"仅管理员可在本版块发帖"（CSR 页面通过 `serverCategory` SSR 数据 + 异步 `/api/categories` 回填双重渲染，管理员仍显示按钮）；首页底部"发布"按钮弹出的版块选择层中，受限版块置灰 + "仅管理员"标签，点击弹 alert；后端 `POST /api/topics` 服务器二次校验 `post_restricted`，非管理员返回 403。

回复限制：帖子详情页将回复表单替换为灰色提示"本版块仅管理员可回复"（SSR 直出，`categoryReplyRestricted` 变量传入模板）；后端 `POST /api/topics/:id/replies` 通过 `topic.category_id` 连表查 `categories.reply_restricted`，非管理员返回 403。

后台管理：`views/admin/categories.ejs` 将编辑版块从双 `prompt()` 模式改为模态框表单（名称、描述两个 input + 两个 checkbox），check-box 通过 `PUT /api/categories/:id` 的 `post_restricted`/`reply_restricted` 参数持久化到数据库。CSS 新增 `.cat-chip-disabled`（opacity 0.45 + cursor not-allowed）、`.cat-chip-badge`（小标签样式）、`.restricted-tip`（灰色提示条）、`.checkbox-label` 四个样式类。

### 最高优先级：论坛视觉重塑

用户明确表示下一阶段核心目标为"论坛外观现代化、有流畅动画组件和 UI"。不是碎片化小修小补，而是系统性视觉重塑。

待用户确认的前置问题：
1. 是否换用专门的视觉设计模型（之前 kimi-k2.6 表现良好）
2. 设计风格方向：克制精致风（Linear/Notion），还是活泼社交风，还是玻璃拟态风。是在现有紫色主题+卡片圆角基础上做深，还是推翻重做
3. 实施策略：先做 1-2 个标杆页面验证效果，还是一次性覆盖全站

### 排队中但优先级低于视觉重塑

| 项目 | 状态 |
|------|------|
| 帖子图片功能 | 方案已写好，待发送指令 |
| 日志中心 UI 排查 | 待启动 |
| 数据备份机制 | 无主动备份，需关注 |
| 安全 TODO | trust proxy（已设置）、隐藏错误堆栈（已返回通用消息，OK）、JWT 密钥替换默认值（已完成） |
| 导航栏共享 partial 重构 | 7 个后台页面统一 `include('admin/nav')`，避免新增 Tab 时遗漏 |
