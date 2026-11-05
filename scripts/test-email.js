// npm run email:test — checks the Gmail settings in .env by sending one test email
// to REPORT_RECIPIENT (or to the address given: npm run email:test -- someone@example.com).
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", ".env");
if (!fs.existsSync(file)) {
    console.error("No .env file yet. Copy .env.example to .env, then fill in GMAIL_USER and GMAIL_APP_PASSWORD.");
    process.exit(1);
}
const settings = require("util").parseEnv(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
Object.assign(process.env, settings);
const mailer = require("../utils/mailer");

const to = process.argv[2] || process.env.REPORT_RECIPIENT || process.env.GMAIL_USER;
const missing = ["GMAIL_USER", "GMAIL_APP_PASSWORD"].filter(key => !String(process.env[key] || "").trim());
if (missing.length) {
    console.error(`Fill in ${missing.join(" and ")} in .env first.`);
    process.exit(1);
}
if (/example\.com$|your-reporting-account|16-character/.test(`${process.env.GMAIL_USER} ${process.env.GMAIL_APP_PASSWORD}`)) {
    console.error("The .env file still has the sample values. Replace them with the station's Gmail address and App Password.");
    process.exit(1);
}

mailer.send({
    to,
    subject: "OLV system – test email",
    title: "Email is working",
    greeting: "Good day,",
    paragraphs: ["This test message confirms that the OLV Tracking and Inventory System can send email. Account activation links, password reset links, order updates, and station summaries will now be delivered."],
    details: [["Sent from", process.env.GMAIL_USER], ["Links open at", process.env.APP_URL || "http://localhost:3000"], ["Sent", mailer.phTime()]]
}).then(() => {
    console.log(`Test email sent to ${to}. Check that inbox (and the Spam folder).`);
}).catch(error => {
    const text = String(error && error.message || error);
    if (/535|Username and Password not accepted|BadCredentials/i.test(text)) {
        console.error("Gmail refused the login. GMAIL_APP_PASSWORD must be a 16-letter App Password (not the normal Gmail password),\nmade at https://myaccount.google.com/apppasswords on the account in GMAIL_USER, with 2-Step Verification turned on.");
    } else if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET/i.test(text)) {
        console.error("Could not reach Gmail. Check the internet connection and try again.");
    } else {
        console.error("The test email could not be sent:", text);
    }
    process.exit(1);
});
