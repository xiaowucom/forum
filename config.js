const { getDb } = require('./db/init');

let _settings = {};

const DEFAULTS = {
  site_name: 'MonkeyCode 社区',
  site_description: '发现精彩，参与讨论',
  site_logo: '',
  footer_text: '论坛 — 轻量级社区系统',
  enable_register: 'true',
  enable_new_topic: 'true',
  enable_reply: 'true',
  enable_notifications: 'true',
  page_size: '20',
  site_closed: 'false',
  force_verify_email: 'false',
  enable_password_reset: 'true',
  global_email_notify: 'true',
};

const TYPES = {
  site_name: 'string',
  site_description: 'string',
  site_logo: 'string',
  footer_text: 'string',
  enable_register: 'boolean',
  enable_new_topic: 'boolean',
  enable_reply: 'boolean',
  enable_notifications: 'boolean',
  page_size: 'number',
  site_closed: 'boolean',
  force_verify_email: 'boolean',
  enable_password_reset: 'boolean',
  global_email_notify: 'boolean',
};

const ALLOWED_KEYS = Object.keys(TYPES);

function loadSettings() {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  _settings = Object.assign({}, DEFAULTS);
  for (const r of rows) {
    _settings[r.key] = r.value;
  }
}

function reloadSettings() {
  loadSettings();
}

function getSetting(key, defaultValue) {
  if (process.env['SETTING_' + key.toUpperCase()] !== undefined) {
    return process.env['SETTING_' + key.toUpperCase()];
  }
  if (_settings[key] !== undefined && _settings[key] !== '') {
    return _settings[key];
  }
  if (defaultValue !== undefined) return defaultValue;
  return DEFAULTS[key] || '';
}

function getBoolean(key) {
  return getSetting(key) === 'true';
}

function getNumber(key, defaultValue) {
  const v = parseInt(getSetting(key, String(defaultValue)), 10);
  return isNaN(v) ? defaultValue : v;
}

function getAllSettings() {
  const result = {};
  for (const key of ALLOWED_KEYS) {
    result[key] = getSetting(key);
  }
  return result;
}

function getAllowedKeys() {
  return ALLOWED_KEYS.slice();
}

function getTypes() {
  return Object.assign({}, TYPES);
}

module.exports = {
  loadSettings,
  reloadSettings,
  getSetting,
  getBoolean,
  getNumber,
  getAllSettings,
  getAllowedKeys,
  getTypes,
};
