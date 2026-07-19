/**
 * 邮件发送模块 — SMTP 多账号故障转移 + 健康追踪
 *
 * 环境变量 SMTP_ACCOUNTS 为 JSON 数组，每项含 host/port/user/pass。
 * SMTP_FROM 为发件人显示名+邮箱。
 * 均未配置时进入「占位模式」——控制台打印提示日志，不报错。
 */

const nodemailer = require('nodemailer');
const { logSystem } = require('./logger');

let accounts = [];
let fromAddress = '';
let fromDisplayName = '';

try {
  const raw = process.env.SMTP_ACCOUNTS;
  if (raw) {
    accounts = JSON.parse(raw);
  }
} catch (e) {
  console.warn('[Mailer] SMTP_ACCOUNTS 解析失败，邮件功能将不可用。错误:', e.message);
}

fromAddress = process.env.SMTP_FROM || '';

// 解析 SMTP_FROM 的显示名和邮箱地址
if (fromAddress) {
  const match = fromAddress.match(/^\s*(.+?)\s*<(.+?)>\s*$/);
  if (match) {
    fromDisplayName = match[1].trim();
  }
}

const PLACEHOLDER_MODE = accounts.length === 0 || !fromAddress;

if (PLACEHOLDER_MODE) {
  console.log('[Mailer] 占位模式 — 未检测到 SMTP_ACCOUNTS / SMTP_FROM 环境变量。');
  console.log('[Mailer] 邮件内容将仅打印到控制台日志，不会真实发送。');
  console.log('[Mailer] 配置示例:');
  console.log('[Mailer]   SMTP_FROM="论坛通知 <your@qq.com>"');
  console.log('[Mailer]   SMTP_ACCOUNTS=\'[{"host":"smtp.qq.com","port":465,"user":"...","pass":"授权码"}]\'');
}

// ═══════════════════════════════════════════════════════════════
// 健康追踪（内存）
// ═══════════════════════════════════════════════════════════════

const MAX_HISTORY = 20;

const health = {
  accounts: accounts.map((a, i) => ({
    index: i,
    user: a.user,
    host: a.host || 'smtp.qq.com',
    lastUsedAt: null,
    successCount: 0,
    failCount: 0,
    lastError: null,
    lastErrorType: null,
    recentHistory: [], // { success, category, message, time }
  })),
  placeholderMode: PLACEHOLDER_MODE,
};

function recordHealth(accountIndex, success, err) {
  const entry = health.accounts[accountIndex];
  if (!entry) return;
  const now = new Date().toISOString();
  entry.lastUsedAt = now;
  if (success) {
    entry.successCount++;
    entry.lastError = null;
    entry.lastErrorType = null;
  } else {
    entry.failCount++;
    const cat = classifyError(err, accountIndex);
    entry.lastError = err.message;
    entry.lastErrorType = cat;
  }
  entry.recentHistory.unshift({
    success,
    category: success ? 'Success' : (err ? classifyError(err, accountIndex) : 'Unknown'),
    message: success ? '发送成功' : (err ? err.message : '未知错误'),
    time: now,
  });
  if (entry.recentHistory.length > MAX_HISTORY) {
    entry.recentHistory = entry.recentHistory.slice(0, MAX_HISTORY);
  }
}

function getHealth() {
  return {
    placeholderMode: health.placeholderMode,
    accounts: health.accounts.map(a => ({
      index: a.index,
      user: a.user ? a.user[0] + '***@' + a.user.split('@')[1] : '',
      host: a.host,
      lastUsedAt: a.lastUsedAt,
      successCount: a.successCount,
      failCount: a.failCount,
      lastError: a.lastError,
      lastErrorType: a.lastErrorType,
      recentHistory: a.recentHistory,
    })),
  };
}

/**
 * 对邮箱地址做简单脱敏（用于日志）
 * user@example.com → u***@example.com
 */
function maskEmail(email) {
  const at = email.indexOf('@');
  if (at <= 1) return email;
  return email[0] + '***' + email.slice(at);
}

/**
 * 分类 SMTP 错误
 */
function classifyError(err, accountIndex) {
  const code = err.code || '';
  const msg = err.message || '';
  const response = (err.response || '').toString();

  if (code === 'EAUTH' || response.includes('535')) return 'AuthError';
  if (response.includes('550') || response.includes('552') || msg.includes('quota') || msg.includes('limit')) return 'QuotaError';
  if (code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'ECONNREFUSED' || code === 'ECONNRESET') return 'NetworkError';
  return 'UnknownError';
}

/**
 * 发送邮件
 * @param {string} to      收件人邮箱
 * @param {string} subject 主题
 * @param {string} html    HTML 正文
 * @returns {Promise<{success:boolean, message:string}>}
 */
async function sendMail(to, subject, html) {
  if (PLACEHOLDER_MODE) {
    console.log(`[Mailer:占位] 收件: ${maskEmail(to)} | 主题: ${subject}`);
    console.log(`[Mailer:占位] 正文预览: ${html.substring(0, 200)}...`);
    logSystem('邮件(占位)', `to=${maskEmail(to)} subject="${subject}"`);
    return { success: true, message: '占位模式 — 邮件未真实发送' };
  }

  const errors = [];

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    const label = `[${i + 1}/${accounts.length}] ${maskEmail(account.user)}`;

    try {
      const transporter = nodemailer.createTransport({
        host: account.host || 'smtp.qq.com',
        port: account.port || 465,
        secure: true,
        auth: { user: account.user, pass: account.pass },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000,
      });

      // QQ SMTP 要求发件地址必须和授权账号一致，使用账号邮箱作为发件人
      const from = fromDisplayName ? `${fromDisplayName} <${account.user}>` : account.user;

      await transporter.sendMail({ from, to, subject, html });

      console.log(`[Mailer] 发送成功 via ${label} → ${maskEmail(to)}`);
      logSystem('邮件发送', `to=${maskEmail(to)} subject="${subject}" account=${label}`);
      recordHealth(i, true, null);
      return { success: true, message: '已发送' };
    } catch (err) {
      const category = classifyError(err, i);
      console.warn(`[Mailer] 失败 ${label}: [${category}] ${err.message}`);
      errors.push({ index: i, account: maskEmail(account.user), category, message: err.message });
      recordHealth(i, false, err);
    }
  }

  // 全部账号失败
  const summary = errors.map(e => `[${e.index}] ${e.account}(${e.category})`).join('; ');
  console.error(`[Mailer] 全部 ${accounts.length} 个账号发送失败: ${summary}`);
  logSystem('邮件发送失败', `to=${maskEmail(to)} errors=${summary}`);

  return { success: false, message: `邮件发送失败 (${summary})` };
}

module.exports = { sendMail, maskEmail, getHealth, isPlaceholder: PLACEHOLDER_MODE };
