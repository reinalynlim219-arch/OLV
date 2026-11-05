// Starts the system on a cloud server (for example Render), so it stays online 24/7
// without the station laptop. See docs/cloud-hosting.md.
//
// - The database lives on the server's saved disk (OLV_DB_PATH, e.g.
//   /var/data/olv_database.db), so it survives updates and restarts.
// - FIRST START: the disk is empty. If OLV_IMPORT_TOKEN is set, the server waits for
//   the station's current database, sent from the laptop with
//   `npm run cloud:upload -- https://your-address`. Only a request with the same
//   secret token is accepted, and only while there is no database yet.
// - It refuses to start while an account still uses an easy default password.
// - Behind the host's https, links in emails use SITE_URL (your own .com) or the
//   host's address.
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const port = Number(process.env.PORT) || 3000;
const dbPath = process.env.OLV_DB_PATH ? path.resolve(process.env.OLV_DB_PATH) : "";
const MAX_UPLOAD = 300 * 1024 * 1024; // 300 MB
const WEAK = ["admin123", "staff123", "driver123", "password", "password123", "12345678", "admin"];

function fail(message) {
    console.error(message);
    process.exit(1);
}

// The address customers use, for links in emails.
function publicAddress() {
    const host = String(process.env.SITE_URL || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)) return `https://${host.toLowerCase()}`;
    return String(process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || "").replace(/\/+$/, "");
}

// First start only: wait for the station's database from the laptop.
function waitForUpload(token) {
    return new Promise(resolve => {
        const server = http.createServer((req, res) => {
            if (req.method !== "POST" || req.url !== "/__import-database") {
                res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
                return res.end("OLV system: waiting for the station's data to be uploaded. See docs/cloud-hosting.md, step 5.");
            }
            const given = Buffer.from(String(req.headers["x-import-token"] || ""));
            const expected = Buffer.from(token);
            if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
                res.writeHead(403, { "Content-Type": "text/plain" });
                return res.end("Wrong upload key.");
            }
            const chunks = [];
            let size = 0;
            req.on("data", chunk => {
                size += chunk.length;
                if (size > MAX_UPLOAD) { res.writeHead(413); res.end("The database is too large."); req.destroy(); return; }
                chunks.push(chunk);
            });
            req.on("end", () => {
                if (res.writableEnded) return;
                const data = Buffer.concat(chunks);
                if (data.subarray(0, 16).toString("latin1") !== "SQLite format 3\0") {
                    res.writeHead(400, { "Content-Type": "text/plain" });
                    return res.end("That is not an OLV database file.");
                }
                fs.mkdirSync(path.dirname(dbPath), { recursive: true });
                fs.writeFileSync(dbPath + ".upload", data);
                fs.renameSync(dbPath + ".upload", dbPath);
                res.writeHead(200, { "Content-Type": "text/plain" });
                res.end(`Received ${(data.length / 1024 / 1024).toFixed(1)} MB. The system is starting.`);
                console.log("Station data received. Starting the system...");
                server.close(() => resolve());
            });
        });
        server.listen(port, () => console.log(`No data yet. Waiting for the station's data upload on port ${port}...`));
    });
}

async function checkPasswords(justUploaded) {
    const bcrypt = require("bcrypt");
    const db = require("../database/database");
    const users = await new Promise((resolve, reject) => db.all("SELECT username, password FROM users WHERE status = 'active'", [], (error, rows) => error ? reject(error) : resolve(rows)));
    const weak = [];
    for (const user of users) {
        for (const guess of WEAK) if (await bcrypt.compare(guess, user.password).catch(() => false)) { weak.push(user.username); break; }
    }
    const problem = weak.length
        ? `Not starting: ${weak.join(", ")} still ${weak.length === 1 ? "uses" : "use"} an easy default password. Change it on the laptop, then upload again.`
        : !users.length ? "The uploaded database has no staff accounts, so nobody could sign in. Upload the station's database again." : "";
    if (!problem) return;
    // Data that was just uploaded is set aside, so a corrected copy can be uploaded.
    if (justUploaded) {
        for (const connection of [db.transactions, db].filter(Boolean)) await new Promise(resolve => connection.close(() => resolve()));
        fs.renameSync(dbPath, `${dbPath}.rejected-${Date.now()}`);
    }
    fail(problem);
}

async function main() {
    if (!dbPath) fail("Set OLV_DB_PATH to a file on the server's saved disk, e.g. /var/data/olv_database.db (see docs/cloud-hosting.md).");
    let justUploaded = false;
    if (!fs.existsSync(dbPath)) {
        const token = String(process.env.OLV_IMPORT_TOKEN || "").trim();
        if (token.length < 20) fail("There is no database on the server yet. Set OLV_IMPORT_TOKEN (a secret of 20+ characters) and upload the station's data (docs/cloud-hosting.md, step 5).");
        await waitForUpload(token);
        justUploaded = true;
    }
    await checkPasswords(justUploaded);
    process.env.OLV_BEHIND_PROXY = "1"; // the host's https proxy sends the visitor's address
    const address = publicAddress();
    if (address) process.env.APP_URL = address; // links in emails open the public address
    require("../app.js");
    console.log(`The system is online${address ? ` at ${address}` : ""}.`);
}

main().catch(error => fail("Unable to start: " + error.message));
