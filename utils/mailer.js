const nodemailer = require("nodemailer");

// One look for every email the system sends: station header, greeting, message,
// optional details table and button, and a footer with the station's contacts.
// Each email has an HTML version and a plain-text version for simple mail apps.
const STATION = {
    name: "OLV Water Refilling Station",
    // 7th Street, Our Lady's Village (OLV): the street painted on the road in the station's Street View photo.
    address: "1095 St. Agatha Road, 7th Street, Our Lady's Village (OLV), Bitano, Legazpi City",
    phones: ["+63 919 841 7627", "+63 968 531 0277"],
    facebook: "https://www.facebook.com/profile.php?id=61588981554478"
};
const BLUE = "#0b6fb3";

// OLV_MAIL_OUTBOX (tests only): emails are written to that file, one JSON per line,
// instead of being sent, so tests can read the codes without a real Gmail account.
const outbox = () => String(process.env.OLV_MAIL_OUTBOX || "").trim();

function configured() {
    return Boolean(outbox() || (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD));
}

let transporter = null;
function getTransporter() {
    if (!transporter) transporter = nodemailer.createTransport({ service: "gmail", auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });
    return transporter;
}

const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[c]);
const peso = value => "₱" + Number(value || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const phTime = (date = new Date()) => date.toLocaleString("en-PH", { timeZone: "Asia/Manila", dateStyle: "long", timeStyle: "short" });

/**
 * Builds the email.
 * @param {object} o
 * @param {string} o.title        Heading inside the email.
 * @param {string} [o.greeting]   e.g. "Hi Luna,".
 * @param {string[]} [o.paragraphs]
 * @param {Array<[string,string]>} [o.details]  Label/value rows shown in a box.
 * @param {{label:string,url:string}} [o.button]
 * @param {string} [o.note]       Small grey text under the button (expiry, safety notice).
 * @param {string} [o.preheader]  Preview line shown by mail apps next to the subject.
 */
function render(o) {
    const paragraphs = o.paragraphs || [];
    const details = o.details || [];
    const detailRows = details.map(([label, value]) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#5b6b7b;font-size:14px;vertical-align:top;width:38%">${escape(label)}</td><td style="padding:6px 0;color:#0f172a;font-size:14px;font-weight:600">${escape(value)}</td></tr>`).join("");
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(o.title)}</title></head><body style="margin:0;padding:0;background:#eef4f9">
<div style="display:none;max-height:0;overflow:hidden;color:transparent">${escape(o.preheader || paragraphs[0] || o.title)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef4f9;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;border:1px solid #dbe5ee">
  <tr><td style="background:${BLUE};padding:18px 24px;color:#ffffff">
    <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;opacity:.85">Clean, safe drinking water</div>
    <div style="font-size:20px;font-weight:700;margin-top:2px">${escape(STATION.name)}</div>
  </td></tr>
  <tr><td style="padding:26px 24px 8px">
    <h1 style="margin:0 0 14px;font-size:20px;color:#0f172a">${escape(o.title)}</h1>
    ${o.greeting ? `<p style="margin:0 0 12px;font-size:15px;color:#1e293b">${escape(o.greeting)}</p>` : ""}
    ${paragraphs.map(p => `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:#1e293b">${escape(p)}</p>`).join("")}
    ${o.code ? `<p style="margin:8px 0 18px;text-align:center"><span style="display:inline-block;padding:14px 26px;background:#f5f9fc;border:1px solid #dbe5ee;border-radius:10px;font-family:'Courier New',monospace;font-size:32px;font-weight:700;letter-spacing:10px;color:#0f172a">${escape(o.code)}</span></p>` : ""}
    ${detailRows ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:6px 0 16px;background:#f5f9fc;border:1px solid #dbe5ee;border-radius:10px;padding:8px 14px">${detailRows}</table>` : ""}
    ${o.button ? `<p style="margin:18px 0 8px"><a href="${escape(o.button.url)}" style="display:inline-block;background:${BLUE};color:#ffffff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px">${escape(o.button.label)}</a></p>
    <p style="margin:0 0 14px;font-size:12px;color:#64748b;line-height:1.5">If the button does not work, copy this link into your browser:<br><a href="${escape(o.button.url)}" style="color:${BLUE};word-break:break-all">${escape(o.button.url)}</a></p>` : ""}
    ${o.note ? `<p style="margin:0 0 16px;font-size:13px;color:#64748b;line-height:1.5">${escape(o.note)}</p>` : ""}
  </td></tr>
  <tr><td style="padding:16px 24px 20px;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b;line-height:1.6">
    <strong style="color:#334155">${escape(STATION.name)}</strong><br>
    ${escape(STATION.address)}<br>
    Call or message us: ${STATION.phones.map(escape).join(" · ")}<br>
    <a href="${STATION.facebook}" style="color:${BLUE}">Follow us on Facebook</a><br>
    <span style="color:#94a3b8">This is an automatic message. Please do not reply to this email.</span>
  </td></tr>
</table></td></tr></table></body></html>`;

    const text = [
        STATION.name, "",
        o.title, "",
        ...(o.greeting ? [o.greeting, ""] : []),
        ...paragraphs.flatMap(p => [p, ""]),
        ...(o.code ? [`Your code: ${o.code}`, ""] : []),
        ...details.map(([label, value]) => `${label}: ${value}`), ...(details.length ? [""] : []),
        ...(o.button ? [`${o.button.label}: ${o.button.url}`, ""] : []),
        ...(o.note ? [o.note, ""] : []),
        "—", STATION.name, STATION.address,
        `Call or message us: ${STATION.phones.join(" / ")}`,
        `Facebook: ${STATION.facebook}`,
        "This is an automatic message. Please do not reply to this email."
    ].join("\n");
    return { html, text };
}

async function send({ to, subject, ...content }) {
    if (!configured()) throw new Error("Email is not configured. Please contact the station administrator.");
    const { html, text } = render(content);
    if (outbox()) return require("fs").appendFileSync(outbox(), JSON.stringify({ to, subject, code: content.code || null, text }) + "\n");
    await getTransporter().sendMail({ from: `"${STATION.name}" <${process.env.GMAIL_USER}>`, to, subject, html, text });
}

module.exports = { STATION, configured, render, send, escape, peso, phTime };
