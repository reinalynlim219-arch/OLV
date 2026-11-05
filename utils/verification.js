const crypto = require('crypto');
const mailer = require('./mailer');

// Password resets and email changes use one-time links sent by email
// (sign-up and sign-in use 6-digit codes instead: see utils/otp.js).
// Links are kept in memory, expire, and can be used only once.
const links = new Map();

function configured() {
    return mailer.configured();
}
function email(value) {
    value = String(value || '').trim();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254) return value.toLowerCase();
    throw new Error('Enter a valid email address.');
}
// Links always point at the configured address, never at the request's Host
// header, so a forged request cannot send customers to another website.
function baseUrl() {
    return String(process.env.APP_URL || `http://localhost:${Number(process.env.PORT) || 3000}`).replace(/\/+$/, '');
}
// Without APP_URL, an emailed link uses the address the person opened the site with,
// but only when it is a known safe one: this computer, a home/office network address
// (192.168.x.x, 10.x.x.x, 172.16-31.x.x), or the NGROK_URL / SITE_URL in .env.
// Any other Host header is ignored, so a forged request cannot point links elsewhere.
function linkBase(req) {
    if (process.env.APP_URL) return baseUrl();
    const host = String(req?.headers?.host || '').trim().toLowerCase();
    const named = ['NGROK_URL', 'SITE_URL'].map(key => String(process.env[key] || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean);
    if (named.includes(host)) return `https://${host}`;
    const local = /^(localhost|127\.0\.0\.1|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2})(:\d{1,5})?$/;
    if (local.test(host)) return `${req.socket?.encrypted ? 'https' : 'http'}://${host}`;
    return baseUrl();
}
function createLink(purpose, data, minutes = 30) {
    const now = Date.now();
    for (const [token, entry] of links) if (entry.expires < now) links.delete(token);
    const token = crypto.randomBytes(32).toString('hex');
    links.set(token, { ...data, purpose, expires: now + minutes * 60000 });
    return token;
}
// Returns and removes the entry so the same link cannot be used twice.
function takeLink(token, purpose) {
    const entry = links.get(String(token || ''));
    if (!entry || entry.purpose !== purpose) return null;
    links.delete(String(token));
    return entry.expires < Date.now() ? null : entry;
}
function dropLinks(match) {
    for (const [token, entry] of links) if (match(entry)) links.delete(token);
}
// Sends an email with a one-time link (account confirmation, password reset, email change).
// `options` adds a greeting, a title, extra paragraphs, and details rows.
async function sendLink(to, subject, message, link, action, options = {}) {
    if (!configured()) throw new Error('Email is not configured. Please contact the station administrator.');
    const minutes = options.minutes || 30;
    await mailer.send({
        to, subject,
        title: options.title || subject,
        greeting: options.name ? `Hi ${options.name},` : 'Hello,',
        paragraphs: [message, ...(options.paragraphs || [])],
        details: options.details,
        button: { label: action, url: link },
        note: `For your security, this link expires in ${minutes} minutes and works only once. ${options.ignoreNote || 'If you did not request this, you can safely ignore this email; nothing will change.'}`
    });
}

module.exports = { configured, email, baseUrl, linkBase, createLink, takeLink, dropLinks, sendLink };
