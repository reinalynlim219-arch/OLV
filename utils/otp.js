const crypto = require('crypto');
const mailer = require('./mailer');

// One-time 6-digit codes sent by Gmail: confirming a new customer account and the
// second step of every sign-in. Codes are kept in memory (never in the database),
// are saved only as a hash, expire after 10 minutes, and allow 5 wrong tries.
// The browser holds a random ticket that says which code it is answering.
const MINUTES = 10;
const MAX_TRIES = 5;
const MAX_SENDS = 3;   // the first email plus 2 "Send a new code"
const pending = new Map();

const hash = code => crypto.createHash('sha256').update(String(code)).digest('hex');
function clean() {
    const now = Date.now();
    for (const [ticket, entry] of pending) if (entry.expires < now) pending.delete(ticket);
}
const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

// "reinalyn@gmail.com" -> "re******@gmail.com", so the screen does not show the whole address.
function hint(email) {
    const [name, domain] = String(email).split('@');
    return name.slice(0, 2) + '*'.repeat(Math.max(2, name.length - 2)) + '@' + domain;
}

async function sendCode(entry, code) {
    await mailer.send({
        to: entry.email,
        subject: `${code} is your OLV ${entry.purpose === 'register' ? 'confirmation' : 'sign-in'} code`,
        title: entry.purpose === 'register' ? 'Confirm your email address' : 'Your sign-in code',
        greeting: entry.name ? `Hi ${entry.name},` : 'Hello,',
        paragraphs: [entry.purpose === 'register'
            ? 'Enter this code on the sign-up page to finish creating your OLV customer account.'
            : 'Someone (hopefully you) entered your username and password. Enter this code to finish signing in.'],
        code,
        details: entry.details,
        note: `The code expires in ${MINUTES} minutes and works only once. Never share it with anyone, even station staff. ${entry.purpose === 'register'
            ? 'If you did not sign up, ignore this email; no account will be created.'
            : 'If this was not you, change your password right away.'}`
    });
}

// Makes a code, emails it, and returns the ticket for the browser.
async function start(purpose, email, data = {}, { name, details } = {}) {
    clean();
    const code = newCode();
    const ticket = crypto.randomBytes(32).toString('hex');
    const entry = { purpose, email, data, name, details, hash: hash(code), tries: 0, sends: 1, expires: Date.now() + MINUTES * 60000 };
    await sendCode(entry, code);
    pending.set(ticket, entry);
    return { ticket, email_hint: hint(email), minutes: MINUTES };
}

// A new code for the same ticket (the old one stops working).
async function resend(ticket, purpose) {
    clean();
    const entry = pending.get(String(ticket || ''));
    if (!entry || entry.purpose !== purpose) throw new Error('This code has expired. Start again.');
    if (entry.sends >= MAX_SENDS) throw new Error('Too many codes were sent. Wait a few minutes, then start again.');
    const code = newCode();
    await sendCode(entry, code);
    Object.assign(entry, { hash: hash(code), tries: 0, sends: entry.sends + 1, expires: Date.now() + MINUTES * 60000 });
    return { email_hint: hint(entry.email), minutes: MINUTES };
}

// Checks a typed code. Returns the saved data once; throws a message the person can read.
function check(ticket, purpose, code) {
    clean();
    const entry = pending.get(String(ticket || ''));
    if (!entry || entry.purpose !== purpose) throw new Error('This code has expired. Start again.');
    if (!/^\d{6}$/.test(String(code || '').trim())) throw new Error('Enter the 6-digit code from the email.');
    const typed = Buffer.from(hash(String(code).trim()));
    if (!crypto.timingSafeEqual(typed, Buffer.from(entry.hash))) {
        if (++entry.tries >= MAX_TRIES) { pending.delete(ticket); throw new Error('Too many wrong codes. Start again.'); }
        throw new Error(`Wrong code. ${MAX_TRIES - entry.tries} ${MAX_TRIES - entry.tries === 1 ? 'try' : 'tries'} left.`);
    }
    pending.delete(ticket);
    return entry.data;
}

// Drops waiting codes that match (e.g. a deleted account).
function drop(match) {
    for (const [ticket, entry] of pending) if (match(entry)) pending.delete(ticket);
}

module.exports = { start, resend, check, drop, hint, MINUTES };
