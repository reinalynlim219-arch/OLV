// npm run cloud:upload -- https://your-address
// Sends this laptop's database (customers, orders, accounts, stock) to the new cloud
// server, once, right after the server is first created. See docs/cloud-hosting.md.
//
// - Uses OLV_IMPORT_TOKEN from .env: the same secret you put in the cloud settings.
// - Stop the system on this laptop first, so no order is placed here after the copy.
// - The cloud server accepts it only while it has no data yet.
const fs = require("fs");
const os = require("os");
const path = require("path");

// Same .env reading as app.js.
const envFile = path.join(__dirname, "..", ".env");
if (fs.existsSync(envFile)) {
    const settings = require("util").parseEnv(fs.readFileSync(envFile, "utf8").replace(/^﻿/, ""));
    for (const [key, value] of Object.entries(settings)) if (!(key in process.env)) process.env[key] = value;
}

function fail(message) { console.error(message); process.exit(1); }

async function main() {
    const address = String(process.argv[2] || "").trim().replace(/\/+$/, "");
    // https for a real server; http only for a test on this computer.
    if (!/^(https:\/\/[a-z0-9.-]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/i.test(address)) fail("Give the cloud address, for example:  npm run cloud:upload -- https://olv-water.onrender.com");
    const token = String(process.env.OLV_IMPORT_TOKEN || "").trim();
    if (token.length < 20) fail("Put the same OLV_IMPORT_TOKEN (20+ characters) in this laptop's .env as in the cloud settings.");

    // A clean, complete copy of the database (works even while it is open).
    const sqlite3 = require("sqlite3");
    const source = process.env.OLV_DB_PATH ? path.resolve(process.env.OLV_DB_PATH) : path.join(__dirname, "..", "database", "olv_database.db");
    if (!fs.existsSync(source)) fail(`The database was not found at ${source}.`);
    const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "olv-upload-")), "olv_database.db");
    await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(source, sqlite3.OPEN_READONLY, error => {
            if (error) return reject(error);
            db.run("VACUUM INTO ?", [copy], vacuumError => db.close(() => vacuumError ? reject(vacuumError) : resolve()));
        });
    });
    const data = fs.readFileSync(copy);
    console.log(`Sending ${(data.length / 1024 / 1024).toFixed(1)} MB of station data to ${address} ...`);

    let response;
    try {
        response = await fetch(address + "/__import-database", {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream", "X-Import-Token": token },
            body: data,
            signal: AbortSignal.timeout(5 * 60 * 1000)
        });
    } catch (error) {
        fail("Could not reach the cloud server: " + error.message + ". Check the address and that the server shows \"waiting for the station's data\".");
    } finally {
        fs.rmSync(path.dirname(copy), { recursive: true, force: true });
    }
    const text = await response.text();
    if (response.ok && /^Received /.test(text)) console.log(text);
    else if (/^(Wrong upload key|That is not|The database is too large)/.test(text)) fail(`The cloud server refused the upload: ${text}`);
    else fail("The cloud server already has data, so nothing was sent. (Uploading works only on a new, empty server.)");
    console.log(`Done. Open ${address} and sign in. You can now remove OLV_IMPORT_TOKEN from the cloud settings.`);
}

main().catch(error => fail("Upload failed: " + error.message));
