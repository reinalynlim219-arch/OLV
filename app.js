const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcrypt");

// Gmail and APP_URL settings from .env, for every way of starting the system.
// Settings already given to the process win, so tests can switch email off.
// A byte-order mark (Notepad's "UTF-8 with BOM") is ignored.
(function loadSettingsFile() {
    const file = path.join(__dirname, ".env");
    if (!fs.existsSync(file)) return;
    try {
        const settings = require("util").parseEnv(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
        for (const [key, value] of Object.entries(settings)) if (!(key in process.env)) process.env[key] = value;
    } catch (error) {
        console.error("Unable to read the .env settings file:", error.message);
    }
})();

const emailReports = require("./utils/emailReports");

const db = require("./database/database");
// Connection for multi-step changes (orders, completing orders, deleting products),
// one at a time; see database/database.js.
const txDb = db.transactions;
const authController = require("./controllers/authController");
const authMiddleware = require("./middleware/authMiddleware");
const logActivity = require("./utils/activityLog")(db);
const mailer = require("./utils/mailer");
const otp = require("./utils/otp");
const { isKnownBarangay, checkAddressParts, checkFullName } = require("./public/js/barangays");
// Product fields from the Add/Edit Product form. Money has at most 2 decimals; stock is
// counted in whole units. Returns a message for the first problem, or "".
function productFieldsProblem({ productName, unit, price, quantity, minimumStock, containerPrice }) {
    const isAmount = value => /^\d{1,6}(\.\d{1,2})?$/.test(String(value ?? "").trim()) && Number(value) <= 100000;
    const isCount = value => value === undefined || value === null || value === "" || (/^\d{1,7}$/.test(String(value).trim()) && Number(value) <= 1000000);
    if (String(productName || "").length > 80) return "The product name can have at most 80 characters.";
    if (String(unit || "").length > 20) return "The unit can have at most 20 characters, for example gallon.";
    if (!isAmount(price)) return "Enter the price as an amount in pesos, for example 30 or 35.50 (up to ₱100,000).";
    if (containerPrice !== undefined && containerPrice !== null && containerPrice !== "" && !isAmount(containerPrice))
        return "Enter the new gallon price as an amount in pesos, for example 100, or leave it empty if the product is sold as a refill only.";
    if (!isCount(quantity)) return "Enter the stock as a whole number, for example 50.";
    if (!isCount(minimumStock)) return "Enter the minimum stock as a whole number, for example 10.";
    return "";
}

// The same rules as customer registration, for every place customer details are saved
// (the customer's own profile, and staff adding or editing a customer).
function customerDetailsProblem(name, data) {
    const city = String(data.city ?? "Legazpi City").trim();
    return checkFullName(name)
        || (["Legazpi City", "Daraga"].includes(city) ? "" : "Choose Legazpi City or Daraga as the city / municipality.")
        || (isKnownBarangay(city, String(data.barangay || "").trim()) ? "" : `Choose a barangay of ${city} from the list.`)
        || checkAddressParts(data);
}
const orderEmails = require("./utils/orderEmails")(db);

// Keep existing SQLite databases compatible with the expanded user profile.
db.run("PRAGMA ignore_check_constraints = ON");
db.run("ALTER TABLE users ADD COLUMN contact_number TEXT DEFAULT ''", (error) => {
    if (error && !error.message.includes("duplicate column name")) {
        console.error("Unable to add user contact number field:", error.message);
    }
});

// Keep port 3000 as the student-friendly default, while allowing VS Code,
// automated checks, or another local service to choose a different port.
const PORT = Number(process.env.PORT) || 3000;

// ERROR HANDLING

// One request's unexpected error must not stop the system for everyone (nobody may be
// at the laptop to restart it). The error is logged and saved to logs/errors.log so it
// can be fixed; the system keeps running. Only a burst of errors (a real breakdown)
// stops it.
const recentCrashes = [];
process.on("uncaughtException", (error) => {
    console.error("Unexpected error (the system keeps running):", error);
    try {
        fs.mkdirSync(path.join(__dirname, "logs"), { recursive: true });
        fs.appendFileSync(path.join(__dirname, "logs", "errors.log"), `[${new Date().toISOString()}] ${error && error.stack || error}\n\n`);
    } catch { /* logging must never cause another error */ }
    const now = Date.now();
    recentCrashes.push(now);
    while (recentCrashes.length && now - recentCrashes[0] > 60000) recentCrashes.shift();
    if (recentCrashes.length > 20) {
        console.error("Too many unexpected errors in one minute; stopping the system.");
        process.exit(1);
    }
});

process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled rejection at:", promise, "reason:", reason);
});

// TEMPORARY LOGIN SESSIONS

const sessions = new Map();
const sessionTimestamps = new Map();
const sessionExpiry = new Map();

// Signed out after 30 minutes without activity (OLV_IDLE_SECONDS shortens it, for tests).
const SESSION_TIMEOUT = (Number(process.env.OLV_IDLE_SECONDS) || 30 * 60) * 1000;

// OLV business settings
// Delivery is free. (Orders placed before this change keep the fee they were charged.)
const DELIVERY_SERVICE_FEE = 0;
const DELIVERY_RADIUS_METERS = 150;
// A location reported with a larger error than this is too rough to compare.
const LOCATION_ACCURACY_METERS = 200;
// Rough box around Legazpi City and Daraga, Albay. A location outside it is a bad reading
// (e.g. a laptop's internet-based guess), not a real delivery address.
function inServiceArea(latitude, longitude) {
    return latitude >= 12.95 && latitude <= 13.30 && longitude >= 123.55 && longitude <= 123.90;
}
const accountVerification = require("./routes/accountVerification")({
    db, readBody: getRequestBody, sendJSON, strongPassword: validateStrongPassword,
    address: buildCustomerAddress, sessions, sessionExpiry, sessionTimestamps
});
const customerEmail = require('./routes/customerEmail')({
    db, requireAdmin: (req, res) => requireAdmin(sessions, req, res), readBody: getRequestBody, sendJSON
});
const deliverySchedule = require('./routes/deliverySchedule')({
    db, requireUser: (req, res) => requireLogin(sessions, req, res), readBody: getRequestBody, sendJSON
});
// Calendar page: deliveries and orders by day.
const calendarPage = require('./routes/calendar')({
    db, requireUser: (req, res) => requireLogin(sessions, req, res), sendJSON, servePage
});
const deliveryTracking = require('./routes/deliveryTracking')({
    db, requireUser: (req, res) => requireLogin(sessions, req, res), sendJSON
});
// Daily database backup (database/backups, plus BACKUP_COPY_DIR if set).
const backups = require('./utils/backup')(db);
if (process.env.OLV_DISABLE_AUTO_BACKUP !== "1") backups.start();
const gallons = require('./routes/gallons')({
    db, requireUser: (req, res) => requireLogin(sessions, req, res), readBody: getRequestBody, sendJSON
});
const deliveryPlan = require('./routes/deliveryPlan')({
    db, requireUser: (req, res) => requireLogin(sessions, req, res), readBody: getRequestBody, sendJSON,
    onOutForDelivery: deliveryId => orderEmails.send("out_for_delivery", { deliveryId })
});
// "Recently deleted" products: kept until restored or deleted permanently.
const recentlyRemoved = require('./routes/recentlyRemoved')({
    db, txDb, requireUser: (req, res) => requireLogin(sessions, req, res), readBody: getRequestBody, sendJSON, servePage
});
const stockMovements = require('./routes/stockMovements')({
    db, requireUser: (req, res) => requireLogin(sessions, req, res), readBody: getRequestBody, sendJSON
});
const stationRecords = require("./routes/stationRecords")({
    db, requireUser: (req, res) => requireLogin(sessions, req, res),
    readBody: getRequestBody, sendJSON, servePage
});
db.run(`CREATE TABLE IF NOT EXISTS customer_receipt_photos (
    delivery_id INTEGER PRIMARY KEY,
    photo BLOB NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
// Optional photo taken by the driver (or staff) when recording the drop-off.
db.run(`CREATE TABLE IF NOT EXISTS delivery_dropoff_photos (
    delivery_id INTEGER PRIMARY KEY,
    photo BLOB NOT NULL,
    taken_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// A photo sent from the browser as "data:image/jpeg;base64,...". Returns the JPEG
// bytes, or null when it is not a small, valid JPEG.
function jpegFromDataURL(photo) {
    photo = String(photo || "");
    if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(photo) || photo.length > 900000) return null;
    const bytes = Buffer.from(photo.split(",")[1], "base64");
    if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255 || bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217) return null;
    return bytes;
}

db.run(`CREATE TABLE IF NOT EXISTS stock_value_snapshots (
    snapshot_date TEXT PRIMARY KEY,
    stock_value REAL NOT NULL
)`);

const PASSWORD_RULE = "Use at least 8 characters with an uppercase letter, a lowercase letter, a number, and a symbol (for example !).";
function validateStrongPassword(password) {
    return typeof password === "string" &&
        password.length >= 8 &&
        /[A-Z]/.test(password) &&
        /[a-z]/.test(password) &&
        /[0-9]/.test(password) &&
        /[^A-Za-z0-9]/.test(password);
}

function buildCustomerAddress(data) {
    const city = String(data.city ?? "Legazpi City").trim();
    const barangay = String(data.barangay || "").trim();
    const zone = String(data.zone || "").trim();
    const street = String(data.street || "").trim();
    const houseNumber = String(data.house_number || "").trim();
    const landmark = String(data.landmark || "").trim();
    const parts = [];
    if (houseNumber) parts.push(houseNumber);
    if (street) parts.push(street);
    if (zone) parts.push(`Zone ${zone.replace(/^zone\s*/i, "")}`);
    if (barangay) parts.push(barangay);
    if (city) parts.push(city);
    if (landmark) parts.push(`Landmark: ${landmark}`);
    return parts.join(", ");
}

function ensureColumn(table, column, definition) {
    return new Promise(resolve => {
        db.all(`PRAGMA table_info(${table})`, [], (error, rows) => {
            if (error) {
                console.error(`Unable to inspect ${table}:`, error);
                resolve();
                return;
            }
            const exists = rows.some(row => row.name === column);
            if (exists) {
                resolve();
                return;
            }
            db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`, error2 => {
                if (error2) console.error(`Unable to add ${table}.${column}:`, error2);
                resolve();
            });
        });
    });
}

async function migrateSystemSchema() {
    await ensureColumn("customers", "city", "TEXT DEFAULT 'Legazpi City'");
    await ensureColumn("customers", "barangay", "TEXT DEFAULT ''");
    await ensureColumn("customers", "zone", "TEXT DEFAULT ''");
    await ensureColumn("customers", "street", "TEXT DEFAULT ''");
    await ensureColumn("customers", "house_number", "TEXT DEFAULT ''");
    await ensureColumn("customers", "landmark", "TEXT DEFAULT ''");
    await ensureColumn("customers", "latitude", "REAL");
    await ensureColumn("customers", "longitude", "REAL");
    await ensureColumn("customers", "payment_method", "TEXT DEFAULT 'Cash'");
    // When the customer agreed to the privacy notice (Data Privacy Act, RA 10173).
    await ensureColumn("customers", "privacy_consent_at", "DATETIME");
    await ensureColumn("products", "supplier_name", "TEXT DEFAULT ''");
    // Refill pricing: `price` is the refill price (the customer brings or returns their
    // own gallon). `new_container_price` is added when the customer needs a new gallon
    // (e.g. ₱35 refill + ₱100 gallon = ₱135 "new gallon + water"). 0 = not offered.
    await ensureColumn("products", "new_container_price", "REAL DEFAULT 0");
    await ensureColumn("order_items", "with_new_container", "INTEGER DEFAULT 0");
    await ensureColumn("orders", "service_fee", "REAL DEFAULT 5");
    await ensureColumn("orders", "fulfillment_method", "TEXT DEFAULT 'delivery'");
    // Delivery day the customer picked on the calendar when ordering (YYYY-MM-DD), or NULL.
    await ensureColumn("orders", "preferred_date", "TEXT");
    // Staff approval of a customer's order (the order stays pending until delivered or picked up).
    await ensureColumn("orders", "approved_at", "DATETIME");
    await ensureColumn("orders", "approved_by", "INTEGER");
    await ensureColumn("delivery_schedules", "driver_delivered_at", "DATETIME");
    await ensureColumn("delivery_schedules", "customer_received_at", "DATETIME");
    await ensureColumn("delivery_schedules", "driver_latitude", "REAL");
    await ensureColumn("delivery_schedules", "driver_longitude", "REAL");
    await ensureColumn("delivery_schedules", "delivery_proof", "TEXT DEFAULT ''");
    db.run(`UPDATE customers SET city = 'Legazpi City' WHERE city IS NULL OR city = ''`);
    db.run(`UPDATE orders SET fulfillment_method = 'delivery' WHERE fulfillment_method IS NULL OR fulfillment_method = ''`);
}

async function migrateDeliverySchedules() {
    // Add the fields needed for manually entered delivery requests.
    await ensureColumn("delivery_schedules", "pickup_by", "INTEGER");
    await ensureColumn("delivery_schedules", "assigned_to", "INTEGER");
    await ensureColumn("delivery_schedules", "customer_name", "TEXT DEFAULT ''");
    await ensureColumn("delivery_schedules", "contact_number", "TEXT DEFAULT ''");
    await ensureColumn("delivery_schedules", "delivery_reason", "TEXT DEFAULT ''");
    await ensureColumn("delivery_schedules", "delivery_items", "TEXT DEFAULT ''");

    await new Promise(resolve => {
        db.all("PRAGMA table_info(delivery_schedules)", [], (error, columns) => {
            if (error || !columns) return resolve();
            const orderColumn = columns.find(column => column.name === "order_id");
            if (!orderColumn || Number(orderColumn.notnull) !== 1) return resolve();

            // SQLite cannot drop NOT NULL from a column in-place. Rebuild this
            // table while preserving all existing delivery rows.
            db.serialize(() => {
                db.run("PRAGMA foreign_keys = OFF");
                db.run("BEGIN TRANSACTION");
                db.run(`CREATE TABLE delivery_schedules_migrated (
                    delivery_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    order_id INTEGER,
                    customer_name TEXT NOT NULL DEFAULT '',
                    contact_number TEXT NOT NULL DEFAULT '',
                    delivery_reason TEXT DEFAULT '',
                    delivery_items TEXT DEFAULT '',
                    delivery_date TEXT NOT NULL,
                    delivery_time TEXT,
                    delivery_address TEXT,
                    pickup_by INTEGER,
                    assigned_to INTEGER,
                    status TEXT NOT NULL DEFAULT 'scheduled',
                    driver_delivered_at DATETIME,
                    customer_received_at DATETIME,
                    driver_latitude REAL,
                    driver_longitude REAL,
                    delivery_proof TEXT DEFAULT '',
                    FOREIGN KEY (order_id) REFERENCES orders(order_id),
                    FOREIGN KEY (pickup_by) REFERENCES users(user_id),
                    FOREIGN KEY (assigned_to) REFERENCES users(user_id)
                )`);
                db.run(`INSERT INTO delivery_schedules_migrated
                    (delivery_id, order_id, customer_name, contact_number,
                     delivery_reason, delivery_items, delivery_date,
                     delivery_time, delivery_address, pickup_by, assigned_to,
                     status, driver_delivered_at, customer_received_at,
                     driver_latitude, driver_longitude, delivery_proof)
                    SELECT d.delivery_id, d.order_id,
                           COALESCE(c.customer_name, ''),
                           COALESCE(c.contact_number, ''), '', '',
                           d.delivery_date, d.delivery_time, d.delivery_address,
                           d.pickup_by, d.assigned_to, d.status,
                           d.driver_delivered_at, d.customer_received_at,
                           d.driver_latitude, d.driver_longitude, d.delivery_proof
                    FROM delivery_schedules d
                    LEFT JOIN orders o ON o.order_id = d.order_id
                    LEFT JOIN customers c ON c.customer_id = o.customer_id`);
                db.run("DROP TABLE delivery_schedules");
                db.run("ALTER TABLE delivery_schedules_migrated RENAME TO delivery_schedules");
                db.run("COMMIT", () => {
                    db.run("PRAGMA foreign_keys = ON");
                    resolve();
                });
            });
        });
    });
}

migrateSystemSchema()
    .then(migrateDeliverySchedules)
    .then(backfillDeliveryQueue)
    .then(reconcileDeliveryStatuses)
    .then(deliveryTracking.setup)
    .then(deliveryPlan.setup)
    .then(recentlyRemoved.setup)
    // Bring every customer's deliveries up to date with the customer record (same rule
    // as syncCustomerDeliveries), in case details changed before this was automatic.
    .then(() => dbRun(`UPDATE delivery_schedules
        SET customer_name = (SELECT c.customer_name FROM orders o JOIN customers c ON c.customer_id = o.customer_id WHERE o.order_id = delivery_schedules.order_id),
            contact_number = (SELECT c.contact_number FROM orders o JOIN customers c ON c.customer_id = o.customer_id WHERE o.order_id = delivery_schedules.order_id),
            delivery_address = CASE WHEN status IN ('scheduled', 'out_for_delivery')
                THEN COALESCE((SELECT NULLIF(c.address, '') FROM orders o JOIN customers c ON c.customer_id = o.customer_id WHERE o.order_id = delivery_schedules.order_id), delivery_address)
                ELSE delivery_address END
        WHERE order_id IN (SELECT o.order_id FROM orders o JOIN customers c ON c.customer_id = o.customer_id)`, []))
    .catch(error => console.error("Schema migration error:", error));

// Backfill delivery records for orders created before the delivery/pickup
// choice was added, so existing delivery orders also appear in the queue.
// Only pending orders that never had a delivery: a delivery that staff cancelled
// (or a cancelled order) must not come back by itself when the system restarts.
function backfillDeliveryQueue() {
    return new Promise(resolve => {
        db.all(`SELECT o.order_id, c.customer_name, c.contact_number, c.address, c.city, c.barangay, c.zone, c.street, c.house_number, c.landmark,
                       GROUP_CONCAT(p.product_name || ' × ' || oi.quantity || CASE WHEN oi.with_new_container = 1 THEN ' (with new gallon)' ELSE '' END, ', ') AS items
                FROM orders o JOIN customers c ON c.customer_id = o.customer_id
                LEFT JOIN order_items oi ON oi.order_id = o.order_id
                LEFT JOIN products p ON p.product_id = oi.product_id
                WHERE COALESCE(o.fulfillment_method, 'delivery') = 'delivery' AND o.status = 'pending'
                  AND NOT EXISTS (SELECT 1 FROM delivery_schedules d WHERE d.order_id = o.order_id)
                GROUP BY o.order_id`, [], (error, rows) => {
            if (error || !rows.length) return resolve();
            let pending = rows.length;
            rows.forEach(row => {
                const address = row.address || [row.house_number, row.street, row.zone ? `Zone ${row.zone}` : "", row.barangay, row.city, row.landmark ? `Landmark: ${row.landmark}` : ""].filter(Boolean).join(", ");
                db.run(`INSERT INTO delivery_schedules (order_id, customer_name, contact_number, delivery_reason, delivery_items, delivery_date, delivery_time, delivery_address, status) VALUES (?, ?, ?, 'Customer order delivery', ?, date('now', '+8 hours'), '', ?, 'scheduled')`, [row.order_id, row.customer_name, row.contact_number, row.items || "Customer order", address], () => { if (--pending === 0) resolve(); });
            });
        });
    });
}

// Older builds completed the order but left the delivery waiting for a
// customer confirmation that could no longer happen. Keep the history, but
// reconcile the delivery state with its already-completed order.
function reconcileDeliveryStatuses() {
    return new Promise(resolve => {
        db.run(`UPDATE delivery_schedules SET status = 'delivered', customer_received_at = COALESCE(customer_received_at, CURRENT_TIMESTAMP)
                WHERE status = 'awaiting_customer' AND order_id IN (SELECT order_id FROM orders WHERE status = 'completed')`, error => {
            if (error) console.error("Delivery status reconciliation error:", error);
            resolve();
        });
    });
}

// Supports customer accounts in existing installations without changing the
// employee users table or its admin/staff role constraint.
db.run(`
    CREATE TABLE IF NOT EXISTS customer_accounts (
        account_id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL UNIQUE,
        username TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (customer_id) REFERENCES customers(customer_id)
    )
`, error => {
    if (error) console.error("Customer account setup error:", error);
});

// Existing projects used a required order ID. A delivery may now also be a
// direct customer request, so migrate the schedule table once without losing
// the existing delivery records.

// Signs a customer out everywhere (used when their record is archived or their login is turned off).
function revokeCustomerSessions(customerId) {
    for (const [id, session] of sessions) {
        if (session.role === "customer" && Number(session.customer_id) === Number(customerId)) {
            sessions.delete(id); sessionExpiry.delete(id); sessionTimestamps.delete(id);
        }
    }
}

// Wrong sign-ins: 5 for one username, or 20 from one address, within 15 minutes
// make further attempts wait, so passwords cannot be guessed when the system is online.
const failedLogins = new Map();
// Online mode (npm run online) runs behind Cloudflare, which passes the visitor's
// real address and https in headers. Those headers are trusted only in that mode.
const behindProxy = () => process.env.OLV_BEHIND_PROXY === "1";
function clientAddress(req) {
    if (behindProxy()) {
        const forwarded = String(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || "").split(",")[0].trim();
        if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress || "";
}
const isHttps = req => Boolean(req.socket.encrypted) || (behindProxy() && req.headers["x-forwarded-proto"] === "https");
function loginBlocked(keys) {
    const now = Date.now();
    for (const [key, entry] of failedLogins) if (entry.until < now) failedLogins.delete(key);
    return keys.some(([key, max]) => (failedLogins.get(key)?.count || 0) >= max);
}
// The browser is on the station laptop itself (not through the online address).
const fromStationLaptop = req => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)
    && !req.headers["x-forwarded-for"] && !req.headers["cf-connecting-ip"];

function startSession(req, res, user, extraCookies = []) {
    logActivity.signedIn(user);
    const sessionId = crypto.randomBytes(32).toString("hex");
    const now = Date.now();
    sessions.set(sessionId, user);
    sessionTimestamps.set(sessionId, now);
    sessionExpiry.set(sessionId, now + SESSION_TIMEOUT);
    res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "Set-Cookie": [`sessionId=${sessionId}; HttpOnly; Path=/; SameSite=Lax${isHttps(req) ? "; Secure" : ""}`, ...extraCookies]
    });
    res.end(JSON.stringify({ success: true, user }));
}

// ---------- Remembered devices (every account: admin, staff, driver, customer) ----------
// The emailed sign-in code is asked the first time and on each new device or browser.
// After a right code the browser gets a private key (cookie "olvDevice", sent only to
// /login) and is remembered for that account; the next sign-in there with the right
// password needs no code. One browser can be remembered for several accounts (e.g. the
// station laptop). Only a hash of the key is stored. A device is forgotten after 180
// days without use, and all of an account's devices are forgotten when its password
// changes (each one is tied to the password it was remembered with).
const TRUSTED_DEVICE_DAYS = 180;
db.run(`CREATE TABLE IF NOT EXISTS remembered_devices (
    device_id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_type TEXT NOT NULL,
    account_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL,
    password_tag TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (token_hash, account_type, account_id)
)`, error => { if (error) console.error("Remembered devices setup error:", error); });
const sha256 = text => crypto.createHash("sha256").update(String(text)).digest("hex");
// Which table and row hold the account's password.
const accountRef = user => user.role === "customer"
    ? { type: "customer", id: Number(String(user.user_id).replace("customer-", "")), sql: "SELECT password FROM customer_accounts WHERE account_id = ?" }
    : { type: "user", id: Number(user.user_id), sql: "SELECT password FROM users WHERE user_id = ?" };
function deviceToken(req) {
    const found = String(req.headers.cookie || "").split(";").map(part => part.trim()).find(part => part.startsWith("olvDevice="));
    const token = found ? found.slice("olvDevice=".length) : "";
    return /^[a-f0-9]{64}$/.test(token) ? token : "";
}
async function currentPasswordTag(ref) {
    const row = await dbGet(ref.sql, [ref.id]);
    return row ? sha256(row.password) : null;
}
async function isTrustedDevice(req, user) {
    const token = deviceToken(req);
    if (!token) return false;
    const ref = accountRef(user);
    const row = await dbGet(`SELECT device_id FROM remembered_devices WHERE account_type = ? AND account_id = ? AND token_hash = ? AND password_tag = ?
        AND last_used_at >= datetime('now', ?)`, [ref.type, ref.id, sha256(token), await currentPasswordTag(ref), `-${TRUSTED_DEVICE_DAYS} days`]);
    if (!row) return false;
    await dbRun("UPDATE remembered_devices SET last_used_at = CURRENT_TIMESTAMP WHERE device_id = ?", [row.device_id]);
    return true;
}
// One code a day for customers: after a customer types a right code, they are not
// asked again for the rest of that day (Philippine time), on any device. A password
// change cancels it. Staff, drivers and admin still confirm each new device.
db.run(`CREATE TABLE IF NOT EXISTS signin_code_days (
    account_type TEXT NOT NULL,
    account_id INTEGER NOT NULL,
    ph_day TEXT NOT NULL,
    password_tag TEXT NOT NULL,
    PRIMARY KEY (account_type, account_id)
)`, error => { if (error) console.error("Sign-in code days setup error:", error); });
async function codeAlreadyUsedToday(user) {
    if (user.role !== "customer") return false;
    const ref = accountRef(user);
    return Boolean(await dbGet(`SELECT 1 FROM signin_code_days WHERE account_type = ? AND account_id = ? AND ph_day = date('now', '+8 hours') AND password_tag = ?`,
        [ref.type, ref.id, await currentPasswordTag(ref)]));
}
async function rememberCodeToday(user) {
    if (user.role !== "customer") return;
    const ref = accountRef(user);
    await dbRun(`INSERT INTO signin_code_days (account_type, account_id, ph_day, password_tag) VALUES (?, ?, date('now', '+8 hours'), ?)
        ON CONFLICT (account_type, account_id) DO UPDATE SET ph_day = excluded.ph_day, password_tag = excluded.password_tag`,
        [ref.type, ref.id, await currentPasswordTag(ref)]);
}

// Remembers this browser for the account; returns the cookie to send.
async function trustThisDevice(req, user) {
    const ref = accountRef(user);
    // Keep the browser's key if it has one, so accounts remembered before stay remembered.
    const token = deviceToken(req) || crypto.randomBytes(32).toString("hex");
    await dbRun("DELETE FROM remembered_devices WHERE last_used_at < datetime('now', ?)", [`-${TRUSTED_DEVICE_DAYS} days`]);
    await dbRun(`INSERT INTO remembered_devices (account_type, account_id, token_hash, password_tag) VALUES (?, ?, ?, ?)
        ON CONFLICT (token_hash, account_type, account_id) DO UPDATE SET password_tag = excluded.password_tag, last_used_at = CURRENT_TIMESTAMP`,
        [ref.type, ref.id, sha256(token), await currentPasswordTag(ref)]);
    return [`olvDevice=${token}; HttpOnly; Path=/login; Max-Age=${TRUSTED_DEVICE_DAYS * 86400}; SameSite=Lax${isHttps(req) ? "; Secure" : ""}`];
}

// Existing accounts sign in with username and password only; the 6-digit email code
// is used at sign-up to prove the email works. OLV_SIGNIN_CODE=1 turns a sign-in code
// back on (accounts with an email; once per device, customers once a day). If Gmail
// cannot be reached, only the station laptop itself may continue without the code.
async function signInStepTwo(req, res, user) {
    try {
        const email = String(process.env.OLV_SIGNIN_CODE ?? "0") === "1" && mailer.configured()
            ? (user.role === "customer"
                ? await dbGet("SELECT destination FROM verified_contacts WHERE account_type = 'customer' AND channel = 'email' AND account_id = ?", [Number(String(user.user_id).replace("customer-", ""))])
                : await dbGet("SELECT destination FROM verified_contacts WHERE account_type = 'user' AND channel = 'email' AND account_id = ?", [user.user_id]))?.destination
            : null;
        if (!email) return startSession(req, res, user);
        // On a device that already passed the code for this account, no code is needed.
        if (await isTrustedDevice(req, user)) return startSession(req, res, user);
        // A customer who already typed a code today is not asked again today (any device);
        // this device is remembered from now on too.
        if (await codeAlreadyUsedToday(user)) return startSession(req, res, user, await trustThisDevice(req, user));
        try {
            const sent = await otp.start("signin", email, user, { name: user.full_name || user.username, details: [["Username", user.username], ["Time", mailer.phTime()]] });
            sendJSON(res, 200, { success: true, otp_required: true, otp_ticket: sent.ticket, email_hint: sent.email_hint,
                message: `We sent a 6-digit sign-in code to ${sent.email_hint}. It expires in ${sent.minutes} minutes.` });
        } catch (mailError) {
            console.error("Sign-in code email error:", mailError.message);
            if (fromStationLaptop(req)) return startSession(req, res, user);
            sendJSON(res, 503, { success: false, message: "We could not send your sign-in code right now. Try again in a few minutes." });
        }
    } catch (lookupError) {
        console.error("Sign-in code error:", lookupError);
        sendJSON(res, 500, { success: false, message: "Server error." });
    }
}

// Email of an admin, staff or driver account (optional; used for sign-in codes and
// Forgot password). Saved in verified_contacts, like customer emails.
function staffEmailProblem(value) {
    const email = String(value ?? "").trim();
    return !email || (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254) ? "" : "Enter a valid email address, or leave it empty.";
}
async function saveStaffEmail(userId, value) {
    const email = String(value ?? "").trim().toLowerCase();
    if (!email) return dbRun("DELETE FROM verified_contacts WHERE account_type = 'user' AND account_id = ? AND channel = 'email'", [userId]);
    const taken = await dbGet("SELECT 1 FROM verified_contacts WHERE channel = 'email' AND destination = ? AND NOT (account_type = 'user' AND account_id = ?)", [email, userId]);
    if (taken) throw Object.assign(new Error("That email is already used by another account."), { status: 409 });
    await dbRun(`INSERT INTO verified_contacts (account_type, account_id, channel, destination) VALUES ('user', ?, 'email', ?)
        ON CONFLICT(account_type, account_id, channel) DO UPDATE SET destination = excluded.destination`, [userId, email]);
}

function recordFailedLogin(keys) {
    const now = Date.now();
    for (const [key] of keys) {
        const entry = failedLogins.get(key) || { count: 0, until: now + 15 * 60000 };
        entry.count++;
        failedLogins.set(key, entry);
    }
}

// Passwords from the setup scripts (database/createAdmin.js) and other easy guesses.
// Accounts still using one are flagged on the dashboard and block online mode.
const DEFAULT_PASSWORDS = ["admin123", "staff123", "driver123", "password", "password123", "12345678", "admin"];
async function accountsWithDefaultPasswords(users) {
    const weak = [];
    for (const user of users) {
        for (const guess of DEFAULT_PASSWORDS) {
            if (await bcrypt.compare(guess, user.password).catch(() => false)) { weak.push(user.username); break; }
        }
    }
    return weak;
}

// Clean up expired sessions every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [sessionId, expiry] of sessionExpiry) {
        if (now > expiry) {
            sessions.delete(sessionId);
            sessionTimestamps.delete(sessionId);
            sessionExpiry.delete(sessionId);
            console.log("Session expired:", sessionId);
        }
    }
}, 5 * 60 * 1000);


// CREATE SERVER

const requestHandler = (req, res) => {

    // Remove query string
    const url = req.url.split("?")[0];

    // Enforce the customer boundary at the server, not only in the UI.
    const activeSessionId = getSessionId(req);
    const activeUser = activeSessionId ? sessions.get(activeSessionId) : null;
    logActivity(req, res, activeUser);
    const customerRoutes = new Set([
        "/customer-portal", "/api/current-user", "/api/customer/profile",
        "/api/customer/products", "/api/customer/orders", "/api/customer/orders/complete", "/api/customer/orders/cancel", "/api/customer/gallons",
        "/api/customer/delivery/received", "/api/customer/delivery/photo", "/api/customer/location", "/api/customer/account", "/api/customer/account/deactivate",
        "/api/deliveries/tracking", "/api/deliveries/dropoff-photo", "/register", "/register/verify", "/register/resend", "/login/verify", "/login/resend", "/verify-email", "/logout", "/", "/api/public/info", "/login", "/offline.html", "/manifest.webmanifest", "/service-worker.js", "/favicon.ico"
    ]);
    const isCustomerStaticFile = url.startsWith("/css/") || url.startsWith("/js/") || url.startsWith("/images/") || url.startsWith("/vendor/");
    if (activeUser && activeUser.role === "customer" && !customerRoutes.has(url) && !isCustomerStaticFile) {
        sendJSON(res, 403, { success: false, message: "Customer accounts can only use their own account page." });
        return;
    }

    if (activeUser?.role === 'driver') {
        if (url === '/dashboard') { res.writeHead(302, { Location: '/delivery' }); res.end(); return; }
        const driverRoutes = new Set(['/delivery','/api/deliveries','/api/deliveries/status','/api/deliveries/tracking','/api/deliveries/dropoff-photo','/api/deliveries/plan','/api/deliveries/plan/start-batch','/api/remittance','/calendar','/api/calendar','/api/current-user','/logout','/','/api/public/info','/login','/manifest.webmanifest','/service-worker.js','/offline.html','/favicon.ico']);
        if (!driverRoutes.has(url) && !isCustomerStaticFile) return sendJSON(res, 403, { success: false, message: 'Driver accounts can only access assigned deliveries.' });
    }

    if (["/customer-history", "/api/customer-history"].includes(url)) {
        stationRecords(req, res);
        return;
    }

    // LOGIN PAGE

    // Public homepage of the station (no sign-in needed).
    if (req.method === "GET" && url === "/") {
        servePage("home.html", res);
        return;
    }
    // What the homepage shows: products for sale with prices, and delivery hours.
    // Only public facts; no stock counts, customers, or anything else.
    if (req.method === "GET" && url === "/api/public/info") {
        db.all(`SELECT product_name, unit, price, COALESCE(new_container_price, 0) AS new_container_price
                FROM products WHERE status = 'active' ORDER BY price, product_name`, [], (error, products) => {
            if (error) return sendJSON(res, 500, { success: false, message: "Unable to load the station's products." });
            db.get("SELECT first_trip, last_trip FROM delivery_settings WHERE id = 1", [], (settingsError, hours) => {
                sendJSON(res, 200, {
                    success: true,
                    products,
                    delivery_hours: settingsError || !hours ? { first_trip: "08:00", last_trip: "17:00" } : hours
                });
            });
        });
        return;
    }

    if (
        req.method === "GET" &&
        url === "/login"
    ) {

        servePage(
            "login.html",
            res
        );

        return;
    }

    // LOGIN

    if (
        req.method === "POST" &&
        url === "/login"
    ) {

        getRequestBody(req, (error, data) => {

            if (error) {

                sendJSON(res, 400, {
                    success: false,
                    message: "Invalid request."
                });

                return;
            }

            const username =
                String(data.username || "").trim();

            const password =
                String(data.password || "");

            if (!username || !password) {

                sendJSON(res, 400, {
                    success: false,
                    message:
                        "Username and password are required."
                });

                return;
            }

            const attemptKeys = [["user:" + username.toLowerCase(), 5], ["from:" + clientAddress(req), 20]];
            if (loginBlocked(attemptKeys)) {
                sendJSON(res, 429, { success: false, message: "Too many wrong sign-in attempts. Wait 15 minutes, then try again, or use Forgot password." });
                return;
            }

            authController.login(
                username,
                password,
                (loginError, result) => {

                    if (loginError) {

                        console.error(
                            "Login error:",
                            loginError
                        );

                        sendJSON(res, 500, {
                            success: false,
                            message: "Server error."
                        });

                        return;
                    }

                    if (!result.success) {

                        recordFailedLogin(attemptKeys);

                        sendJSON(
                            res,
                            401,
                            result
                        );

                        return;
                    }

                    failedLogins.delete(attemptKeys[0][0]);
                    signInStepTwo(req, res, result.user);

                }
            );

        });

        return;
    }

    // Second step of signing in: the 6-digit code from the email.
    if (req.method === "POST" && (url === "/login/verify" || url === "/login/resend")) {
        getRequestBody(req, async (error, data) => {
            if (error) return sendJSON(res, 400, { success: false, message: "Invalid request." });
            try {
                if (url === "/login/resend") {
                    const sent = await otp.resend(data.otp_ticket, "signin");
                    return sendJSON(res, 200, { success: true, message: `A new code was sent to ${sent.email_hint}. The old code no longer works.` });
                }
                const user = otp.check(data.otp_ticket, "signin", data.code);
                await rememberCodeToday(user).catch(error => console.error("Sign-in code day error:", error));
                // Remember this device, so this account is not asked for a code here again.
                startSession(req, res, user, await trustThisDevice(req, user).catch(error => { console.error("Trusted device error:", error); return []; }));
            } catch (codeError) {
                sendJSON(res, 400, { success: false, message: codeError.message });
            }
        });
        return;
    }

    if ((req.method === "POST" && ["/register", "/register/verify", "/register/resend", "/account/recover/request", "/account/recover"].includes(url)) || (req.method === "GET" && url === "/verify-email")) {
        accountVerification(req, res);
        return;
    }

    if (req.method === "GET" && url === "/customer-portal") {
        const user = requireCustomer(sessions, req, res);
        if (!user) return;
        servePage("customer-portal.html", res);
        return;
    }

    if (req.method === "GET" && url === "/api/customer/profile") {
        const user = requireCustomer(sessions, req, res);
        if (!user) return;
        db.get(`
            SELECT customer_name, contact_number, address, city, barangay, zone, street,
                   house_number, landmark, latitude, longitude, customer_type
            FROM customers WHERE customer_id = ?
        `, [user.customer_id], (error, customer) => {
            if (error || !customer) return sendJSON(res, error ? 500 : 404, { success: false, message: "Unable to load customer profile." });
            sendJSON(res, 200, { success: true, customer: customer, username: user.username });
        });
        return;
    }

    if (req.method === "PUT" && url === "/api/customer/profile") {
        const user = requireCustomer(sessions, req, res);
        if (!user) return;
        getRequestBody(req, (error, data) => {
            if (error) return sendJSON(res, 400, { success: false, message: "Invalid request." });
            const fullName = String(data.full_name || "").trim().replace(/\s+/g, " ");
            const detailsProblem = customerDetailsProblem(fullName, data);
            if (detailsProblem) return sendJSON(res, 400, { success: false, message: detailsProblem });
            const city = String(data.city ?? "Legazpi City").trim();
            if (!["Legazpi City", "Daraga"].includes(city)) return sendJSON(res, 400, { success: false, message: "Choose Legazpi City or Daraga as your city / municipality." });
            const barangay = String(data.barangay || "").trim();
            if (!isKnownBarangay(city, barangay)) return sendJSON(res, 400, { success: false, message: `Choose a barangay of ${city} from the list.` });
            const zone = String(data.zone || "").trim();
            const street = String(data.street || "").trim();
            const houseNumber = String(data.house_number || "").trim();
            const landmark = String(data.landmark || "").trim();
            const address = buildCustomerAddress(data);
            if (!fullName || !street || !houseNumber) {
                return sendJSON(res, 400, { success: false, message: "Name, barangay, street, and house/lot number are required." });
            }
            // The contact number is no longer edited from the portal; the saved one is kept.
            db.run(`UPDATE customers SET customer_name = ?, address = ?, city = ?, barangay = ?, zone = ?, street = ?, house_number = ?, landmark = ?, updated_at = CURRENT_TIMESTAMP WHERE customer_id = ?`,
                [fullName, address, city, barangay, zone, street, houseNumber, landmark, user.customer_id],
                function (updateError) {
                    if (updateError || this.changes === 0) return sendJSON(res, updateError ? 500 : 404, { success: false, message: "Unable to update your profile." });
                    user.full_name = fullName;
                    syncCustomerDeliveries(user.customer_id).then(() =>
                        sendJSON(res, 200, { success: true, message: "Profile updated successfully. Deliveries not yet dropped off will go to the new address." }));
                });
        });
        return;
    }

    if (req.method === "PUT" && url === "/api/customer/location") {
        const user = requireCustomer(sessions, req, res);
        if (!user) return;
        getRequestBody(req, (error, data) => {
            const latitude = Number(data.latitude);
            const longitude = Number(data.longitude);
            if (error || !Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
                return sendJSON(res, 400, { success: false, message: "A valid location is required." });
            }
            // Laptops and some phones only guess the location from the internet connection,
            // which can be kilometers off. Only a precise location inside the service area is saved.
            const accuracy = Number(data.accuracy);
            if (!inServiceArea(latitude, longitude)) return sendJSON(res, 400, { success: false, message: "This location is outside Legazpi City and Daraga, so it cannot be correct. Save your location using your phone while you are at home, with location (GPS) turned on." });
            if (data.accuracy != null && Number.isFinite(accuracy) && accuracy > LOCATION_ACCURACY_METERS) return sendJSON(res, 400, { success: false, message: `Your location is only accurate to about ${Math.round(accuracy)} meters. Use your phone at home with location (GPS) turned on, then try again.` });
            db.run(`UPDATE customers SET latitude = ?, longitude = ?, updated_at = CURRENT_TIMESTAMP WHERE customer_id = ?`, [latitude, longitude, user.customer_id], function (updateError) {
                if (updateError || this.changes === 0) return sendJSON(res, updateError ? 500 : 404, { success: false, message: "Unable to save location." });
                sendJSON(res, 200, { success: true, message: "Delivery location saved." });
            });
        });
        return;
    }

    if (req.method === "GET" && url === "/api/customer/products") {
        const user = requireCustomer(sessions, req, res);
        if (!user) return;
        // Customers see the stock they can still order: on hand minus what pending
        // orders were already promised (the same rule used when the order is saved).
        db.all(`SELECT product_id, product_name, category, description, unit, price, new_container_price,
                       MAX(free_stock, 0) AS stock_quantity, CASE WHEN free_stock > 0 THEN 1 ELSE 0 END AS available
                FROM (SELECT p.product_id, p.product_name, p.category, p.description, p.unit, p.price, COALESCE(p.new_container_price, 0) AS new_container_price,
                             COALESCE(i.quantity, 0) - COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.order_id = oi.order_id
                                                                WHERE oi.product_id = p.product_id AND o.status = 'pending'), 0) AS free_stock
                      FROM products p LEFT JOIN inventory i ON i.product_id = p.product_id
                      WHERE p.status = 'active')
                ORDER BY product_name`, [], (error, products) => {
            if (error) return sendJSON(res, 500, { success: false, message: "Unable to load products." });
            sendJSON(res, 200, { success: true, products: products });
        });
        return;
    }

    if (req.method === "GET" && url === "/api/customer/orders") {
        const user = requireCustomer(sessions, req, res);
        if (!user) return;
        db.all(`
            SELECT o.order_id, o.order_date, o.total_amount, COALESCE(o.service_fee, 0) AS service_fee,
                   o.status, COALESCE(o.fulfillment_method, 'delivery') AS fulfillment_method, o.approved_at,
                   ds.delivery_id, ds.delivery_date, ds.delivery_time, ds.status AS delivery_status,
                   ds.customer_received_at,
                   (SELECT GROUP_CONCAT(COALESCE(p.product_name, 'Unavailable product') || ' × ' || oi.quantity || CASE WHEN oi.with_new_container = 1 THEN ' (with new gallon)' ELSE '' END, ', ')
                    FROM order_items oi LEFT JOIN products p ON p.product_id = oi.product_id
                    WHERE oi.order_id = o.order_id) AS order_items,
                   EXISTS(SELECT 1 FROM customer_receipt_photos rp WHERE rp.delivery_id = ds.delivery_id) AS has_receipt_photo,
                   EXISTS(SELECT 1 FROM delivery_dropoff_photos dp WHERE dp.delivery_id = ds.delivery_id) AS has_dropoff_photo
            FROM orders o
            LEFT JOIN delivery_schedules ds ON ds.order_id = o.order_id AND ds.status != 'cancelled'
            WHERE o.customer_id = ?
            ORDER BY o.order_date DESC, o.order_id DESC
        `, [user.customer_id], async (error, orders) => {
            if (error) return sendJSON(res, 500, { success: false, message: "Unable to load your orders." });
            // Expected delivery time from the delivery batches (see routes/deliveryPlan.js).
            try {
                const eta = await deliveryPlan.etaByDelivery();
                orders.forEach(order => { if (eta.has(order.delivery_id)) order.eta = eta.get(order.delivery_id); });
            } catch (etaError) { console.error("Unable to estimate delivery times:", etaError); }
            sendJSON(res, 200, { success: true, orders: orders });
        });
        return;
    }

    if (req.method === "POST" && url === "/api/customer/orders") {
        const user = requireCustomer(sessions, req, res);
        if (!user) return;
        getRequestBody(req, (error, data) => {
            const productId = Number(data.product_id);
            const quantity = Number(data.quantity);
            const fulfillmentMethod = String(data.fulfillment_method || "").toLowerCase();
            if (error || !productId || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) return sendJSON(res, 400, { success: false, message: "Choose a product and a quantity between 1 and 100." });
            if (!["delivery", "pickup"].includes(fulfillmentMethod)) return sendJSON(res, 400, { success: false, message: "Choose either delivery or pickup." });
            // Preferred delivery day from the calendar: today up to 30 days ahead (Philippine time).
            let preferredDate = null;
            if (fulfillmentMethod === "delivery" && data.preferred_date) {
                preferredDate = String(data.preferred_date);
                const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
                const latest = new Date(Date.now() + 8 * 3600000 + 30 * 86400000).toISOString().slice(0, 10);
                if (!/^\d{4}-\d{2}-\d{2}$/.test(preferredDate) || Number.isNaN(Date.parse(preferredDate + "T00:00:00Z")) || preferredDate < today || preferredDate > latest)
                    return sendJSON(res, 400, { success: false, message: "Choose a delivery date from today up to 30 days ahead." });
            }
            db.get(`SELECT barangay, street, house_number FROM customers WHERE customer_id = ? AND status = 'active'`, [user.customer_id], (profileError, customer) => {
                if (profileError) return sendJSON(res, 500, { success: false, message: "Unable to check delivery details." });
                if (fulfillmentMethod === "delivery" && (!customer || !customer.barangay || !customer.street || !customer.house_number)) return sendJSON(res, 400, { success: false, message: "Complete your specific delivery address before choosing delivery." });
                checkProducts(user.customer_id, [{ product_id: productId, quantity: quantity, with_new_container: data.with_new_container === true }], res, fulfillmentMethod, preferredDate);
            });
        });
        return;
    }

    if (req.method === "PUT" && url === "/api/customer/account") {
        const user = requireCustomer(sessions, req, res);
        if (!user) return;
        getRequestBody(req, (error, data) => {
            if (error) return sendJSON(res, 400, { success: false, message: "Invalid request." });
            const username = String(data.username || "").trim();
            const newPassword = String(data.new_password || "");
            if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) return sendJSON(res, 400, { success: false, message: "Username must be 3–32 letters, numbers, dots, underscores, or hyphens." });
            if (newPassword && !validateStrongPassword(newPassword)) return sendJSON(res, 400, { success: false, message: PASSWORD_RULE });
            db.get("SELECT account_id FROM customer_accounts WHERE username = ? AND customer_id <> ?", [username, user.customer_id], (lookupError, duplicate) => {
                if (lookupError) return sendJSON(res, 500, { success: false, message: "Unable to check username." });
                if (duplicate) return sendJSON(res, 409, { success: false, message: "That username is already in use." });
                const values = newPassword ? [username, bcrypt.hashSync(newPassword, 12), user.customer_id] : [username, null, user.customer_id];
                const sql = newPassword ? "UPDATE customer_accounts SET username = ?, password = ? WHERE customer_id = ?" : "UPDATE customer_accounts SET username = ? WHERE customer_id = ?";
                const params = newPassword ? values : [username, user.customer_id];
                db.run(sql, params, function (updateError) {
                    if (updateError || this.changes === 0) return sendJSON(res, updateError ? 500 : 404, { success: false, message: "Unable to update account settings." });
                    user.username = username;
                    // A new password signs out the customer's other devices; this one stays signed in.
                    let signedOut = 0;
                    if (newPassword) {
                        const current = getSessionId(req);
                        for (const [sessionId, session] of sessions) {
                            if (sessionId !== current && session.role === "customer" && Number(session.customer_id) === Number(user.customer_id)) {
                                sessions.delete(sessionId);
                                sessionExpiry.delete(sessionId);
                                sessionTimestamps.delete(sessionId);
                                signedOut++;
                            }
                        }
                    }
                    sendJSON(res, 200, { success: true, message: `Account settings updated successfully.${signedOut ? " Your other devices were signed out." : ""}` });
                });
            });
        });
        return;
    }

    // Pickups are confirmed by station staff when the customer collects the order
    // (Orders page → Mark picked up). Customers used to confirm it themselves, which
    // let an order be completed, stock deducted, and a receipt issued from home
    // without anyone at the station seeing the customer.
    if (req.method === "PUT" && url === "/api/customer/orders/complete") {
        const user = requireCustomer(sessions, req, res);
        if (!user) return;
        sendJSON(res, 403, { success: false, message: "The station staff mark your order as picked up when you collect it at the station." });
        return;
    }

    if (["GET", "POST"].includes(req.method) && url === "/api/customer/delivery/photo") {
        const user = requireLogin(sessions, req, res);
        if (!user) return;
        if (req.method === "POST" && user.role !== "customer") return sendJSON(res, 403, { success: false, message: "Only the customer can attach a receipt photo." });
        const handlePhoto = (data) => {
            const deliveryId = Number(data.delivery_id);
            if (!Number.isSafeInteger(deliveryId) || deliveryId < 1) return sendJSON(res, 400, { success: false, message: "Invalid delivery." });
            db.get(`SELECT ds.status, o.customer_id FROM delivery_schedules ds JOIN orders o ON o.order_id = ds.order_id WHERE ds.delivery_id = ?`, [deliveryId], (error, delivery) => {
                if (error) return sendJSON(res, 500, { success: false, message: "Unable to load delivery." });
                if (!delivery || (user.role === "customer" && Number(delivery.customer_id) !== Number(user.customer_id))) return sendJSON(res, 404, { success: false, message: "Delivery not found." });
                if (!["customer", "admin", "staff", "driver"].includes(user.role)) return sendJSON(res, 403, { success: false, message: "Access denied." });
                if (req.method === "GET") {
                    db.get("SELECT photo FROM customer_receipt_photos WHERE delivery_id = ?", [deliveryId], (photoError, row) => {
                        if (photoError) return sendJSON(res, 500, { success: false, message: "Unable to load photo." });
                        if (!row) return sendJSON(res, 404, { success: false, message: "No receipt photo attached." });
                        res.writeHead(200, responseHeaders("image/jpeg", { "Cache-Control": "private, no-store" }));
                        res.end(row.photo);
                    });
                    return;
                }
                if (!["awaiting_customer", "delivered"].includes(delivery.status)) return sendJSON(res, 400, { success: false, message: "A photo can be attached after the driver records delivery." });
                const photo = String(data.photo || "");
                if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(photo) || photo.length > 900000) return sendJSON(res, 400, { success: false, message: "Choose a smaller JPEG photo." });
                const bytes = Buffer.from(photo.split(",")[1], "base64");
                if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255 || bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217) return sendJSON(res, 400, { success: false, message: "Invalid JPEG photo." });
                db.run("INSERT INTO customer_receipt_photos (delivery_id, photo) VALUES (?, ?)", [deliveryId, bytes], function (saveError) {
                    if (saveError) return sendJSON(res, saveError.code === "SQLITE_CONSTRAINT" ? 409 : 500, { success: false, message: saveError.code === "SQLITE_CONSTRAINT" ? "A receipt photo is already saved for this delivery." : "Unable to save photo." });
                    sendJSON(res, 200, { success: true, message: "Receipt photo saved." });
                });
            });
        };
        if (req.method === "GET") handlePhoto({ delivery_id: new URL(req.url, "http://localhost").searchParams.get("delivery_id") });
        else getRequestBody(req, (error, data) => {
            if (error || !data) return sendJSON(res, 400, { success: false, message: "Invalid photo upload." });
            handlePhoto(data);
        });
        return;
    }

    // Drop-off photo: admin/staff, the driver the delivery is assigned to, and the customer who ordered it.
    if (req.method === "GET" && url === "/api/deliveries/dropoff-photo") {
        const user = requireLogin(sessions, req, res);
        if (!user) return;
        const deliveryId = Number(new URL(req.url, "http://localhost").searchParams.get("delivery_id"));
        if (!Number.isSafeInteger(deliveryId) || deliveryId < 1) return sendJSON(res, 400, { success: false, message: "Invalid delivery." });
        db.get(`SELECT p.photo, ds.assigned_to, o.customer_id FROM delivery_dropoff_photos p
                JOIN delivery_schedules ds ON ds.delivery_id = p.delivery_id LEFT JOIN orders o ON o.order_id = ds.order_id
                WHERE p.delivery_id = ?`, [deliveryId], (error, row) => {
            if (error) return sendJSON(res, 500, { success: false, message: "Unable to load photo." });
            const allowed = row && (["admin", "staff"].includes(user.role)
                || (user.role === "driver" && Number(row.assigned_to) === Number(user.user_id))
                || (user.role === "customer" && Number(row.customer_id) === Number(user.customer_id)));
            if (!allowed) return sendJSON(res, 404, { success: false, message: "No drop-off photo for this delivery." });
            res.writeHead(200, responseHeaders("image/jpeg", { "Cache-Control": "private, no-store" }));
            res.end(row.photo);
        });
        return;
    }

    if (req.method === "PUT" && url === "/api/customer/delivery/received") {
        const user = requireCustomer(sessions, req, res);
        if (!user) return;
        getRequestBody(req, (error, data) => {
            const deliveryId = Number(data && data.delivery_id);
            if (error || !deliveryId) return sendJSON(res, 400, { success: false, message: "Delivery ID is required." });
                db.run(`
                UPDATE delivery_schedules
                SET status = 'delivered', customer_received_at = COALESCE(customer_received_at, CURRENT_TIMESTAMP)
                WHERE delivery_id = ?
                AND status IN ('awaiting_customer', 'delivered')
                AND order_id IN (SELECT order_id FROM orders WHERE customer_id = ?)
                `, [deliveryId, user.customer_id], function (updateError) {
                    if (updateError) return sendJSON(res, 500, { success: false, message: "Unable to confirm delivery." });
                    if (this.changes === 0) return sendJSON(res, 400, { success: false, message: "This delivery is not awaiting customer confirmation." });
                    db.get(`SELECT o.order_id, o.status FROM delivery_schedules ds JOIN orders o ON o.order_id = ds.order_id WHERE ds.delivery_id = ? AND o.customer_id = ?`, [deliveryId, user.customer_id], (orderError, order) => {
                        if (orderError || !order) return sendJSON(res, 500, { success: false, message: "Delivery was received, but its order could not be found." });
                        if (order.status === "completed") return sendJSON(res, 200, { success: true, message: "Order received. Delivery and order completed." });
                        completeOrder(order.order_id, user, res);
                    });
            });
        });
        return;
    }

    // DASHBOARD PAGE

    if (
        req.method === "GET" &&
        url === "/dashboard"
    ) {

        const user =
            requireLogin(
                sessions,
                req,
                res
            );

        if (!user) {
            return;
        }

        servePage(
            "dashboard.html",
            res
        );

        return;
    }

    // CURRENT USER

    if (
        req.method === "GET" &&
        url === "/api/current-user"
    ) {

        const user =
            requireLogin(
                sessions,
                req,
                res
            );

        if (!user) {
            return;
        }

        sendJSON(res, 200, {
            success: true,
            user: user
        });

        return;
    }

    // DASHBOARD DATA

    if (
        req.method === "GET" &&
        url === "/api/dashboard"
    ) {

        const user =
            requireLogin(
                sessions,
                req,
                res
            );

        if (!user) {
            return;
        }

        loadDashboardData(res);

        return;
    }

    // INVENTORY PAGE

    if (
        req.method === "GET" &&
        url === "/inventory"
    ) {

        const user =
            requireLogin(
                sessions,
                req,
                res
            );

        if (!user) {
            return;
        }

        servePage(
            "inventory.html",
            res
        );

        return;
    }

    // CUSTOMER PAGE

    if (
        req.method === "GET" &&
        url === "/customers"
    ) {

        const user =
            requireLogin(
                sessions,
                req,
                res
            );

        if (!user) {
            return;
        }

        servePage(
            "Customers.html",
            res
        );

        return;
    }

    // GET CUSTOMERS

    if (
        req.method === "GET" &&
        url === "/api/customers"
    ) {

        const user =
            requireLogin(
                sessions,
                req,
                res
            );

        if (!user) {
            return;
        }

        db.all(
            `
            SELECT
                customer_id,
                customer_name,
                contact_number,
                address,
                city,
                barangay,
                zone,
                street,
                house_number,
                landmark,
                latitude,
                longitude,
                customer_type,
                status,
                created_at,
                EXISTS(SELECT 1 FROM customer_accounts a WHERE a.customer_id = customers.customer_id) AS has_login

            FROM customers

            ORDER BY customer_name ASC
            `,
            [],
            (error, rows) => {

                if (error) {

                    console.error(
                        "Customer loading error:",
                        error
                    );

                    sendJSON(res, 500, {
                        success: false,
                        message:
                            "Unable to load customers."
                    });

                    return;
                }

                sendJSON(
                    res,
                    200,
                    rows
                );

            }
        );

        return;
    }


    // ADD CUSTOMER

    if (
        req.method === "POST" &&
        url === "/api/customers/add"
    ) {

        const user =
            requireLogin(
                sessions,
                req,
                res
            );

        if (!user) {
            return;
        }

        getRequestBody(req, (error, data) => {

            if (error) {

                sendJSON(res, 400, {
                    success: false,
                    message: "Invalid request."
                });

                return;
            }

            const customerName =
                String(
                    data.customer_name || ""
                ).trim();

            const contactNumber =
                String(
                    data.contact_number || ""
                ).trim();

            const city = String(data.city ?? "Legazpi City").trim();
            if (!["Legazpi City", "Daraga"].includes(city)) return sendJSON(res, 400, { success: false, message: "Choose Legazpi City or Daraga as your city / municipality." });
            const barangay = String(data.barangay || "").trim();
            const zone = String(data.zone || "").trim();
            const street = String(data.street || "").trim();
            const houseNumber = String(data.house_number || "").trim();
            const landmark = String(data.landmark || "").trim();
            const address = buildCustomerAddress(data);

            const customerType =
                String(
                    data.customer_type || "Regular"
                ).trim();

            const contactDigits =
                contactNumber;

            if (!customerName || !/^09\d{9}$/.test(contactDigits) || !barangay || !street || !houseNumber) {

                const validationMessage = customerName
                    ? "Enter the mobile number as +63 followed by 10 digits, starting with 9 (for example +63 9171234567)."
                    : "Customer name is required.";

                sendJSON(res, 400, {
                    success: false,
                    message: validationMessage
                });

                return;
            }

            const detailsProblem = customerDetailsProblem(customerName, data);
            if (detailsProblem) return sendJSON(res, 400, { success: false, message: detailsProblem });

            db.run(
                `
                INSERT INTO customers
                (
                    customer_name,
                    contact_number,
                    address,
                    city,
                    barangay,
                    zone,
                    street,
                    house_number,
                    landmark,
                    customer_type,
                    status
                )

                VALUES
                (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
                `,
                [
                    customerName,
                    contactNumber,
                    address,
                    city,
                    barangay,
                    zone,
                    street,
                    houseNumber,
                    landmark,
                    customerType
                ],
                function (error) {

                    if (error) {

                        console.error(
                            "Add customer error:",
                            error
                        );

                        sendJSON(res, 500, {
                            success: false,
                            message:
                                "Unable to add customer."
                        });

                        return;
                    }

                    sendJSON(res, 200, {
                        success: true,
                        message:
                            "Customer added successfully.",
                        customer_id:
                            this.lastID
                    });

                }
            );

        });

        return;
    }

    // UPDATE CUSTOMER

    if (
        req.method === "PUT" &&
        url === "/api/customers/update"
    ) {

        const user =
            requireLogin(
                sessions,
                req,
                res
            );

        if (!user) {
            return;
        }

        getRequestBody(req, (error, data) => {

            if (error) {

                sendJSON(res, 400, {
                    success: false,
                    message: "Invalid request."
                });

                return;
            }

            const customerId =
                Number(data.customer_id);

            const customerName =
                String(
                    data.customer_name || ""
                ).trim();

            const contactNumber =
                String(
                    data.contact_number || ""
                ).trim();

            const city = String(data.city ?? "Legazpi City").trim();
            if (!["Legazpi City", "Daraga"].includes(city)) return sendJSON(res, 400, { success: false, message: "Choose Legazpi City or Daraga as your city / municipality." });
            const barangay = String(data.barangay || "").trim();
            const zone = String(data.zone || "").trim();
            const street = String(data.street || "").trim();
            const houseNumber = String(data.house_number || "").trim();
            const landmark = String(data.landmark || "").trim();
            const address = buildCustomerAddress(data);

            const customerType =
                String(
                    data.customer_type || "Regular"
                ).trim();

            const contactDigits =
                contactNumber;

            if (
                !customerId ||
                !customerName ||
                !/^09\d{9}$/.test(contactDigits) ||
                !barangay ||
                !street ||
                !houseNumber
            ) {

                sendJSON(res, 400, {
                    success: false,
                    message:
                        "Customer ID, name, valid contact number, barangay, street, and house/lot number are required."
                });

                return;
            }

            const detailsProblem = customerDetailsProblem(customerName, data);
            if (detailsProblem) return sendJSON(res, 400, { success: false, message: detailsProblem });

            db.run(
                `
                UPDATE customers

                SET
                    customer_name = ?,
                    contact_number = ?,
                    address = ?,
                    city = ?,
                    barangay = ?,
                    zone = ?,
                    street = ?,
                    house_number = ?,
                    landmark = ?,
                    customer_type = ?,
                    updated_at = CURRENT_TIMESTAMP

                WHERE customer_id = ?
                `,
                [
                    customerName,
                    contactNumber,
                    address,
                    city,
                    barangay,
                    zone,
                    street,
                    houseNumber,
                    landmark,
                    customerType,
                    customerId
                ],
                function (error) {

                    if (error) {

                        console.error(
                            "Update customer error:",
                            error
                        );

                        sendJSON(res, 500, {
                            success: false,
                            message:
                                "Unable to update customer."
                        });

                        return;
                    }

                    if (this.changes === 0) {

                        sendJSON(res, 404, {
                            success: false,
                            message:
                                "Customer not found."
                        });

                        return;
                    }

                    // Their deliveries show the new name, number and address too.
                    syncCustomerDeliveries(customerId).then(() => sendJSON(res, 200, {
                        success: true,
                        message:
                            "Customer updated successfully."
                    }));

                }
            );

        });

        return;
    }

    // ARCHIVE CUSTOMER

    if (
        req.method === "PUT" &&
        url === "/api/customers/archive"
    ) {

        const user =
            requireLogin(
                sessions,
                req,
                res
            );

        if (!user) {
            return;
        }

        getRequestBody(req, (error, data) => {

            if (error) {

                sendJSON(res, 400, {
                    success: false,
                    message: "Invalid request."
                });

                return;
            }

            const customerId =
                Number(data.customer_id);

            if (!customerId) {

                sendJSON(res, 400, {
                    success: false,
                    message:
                        "Customer ID is required."
                });

                return;
            }

            db.run(
                `
                UPDATE customers

                SET
                    status = 'archived',
                    updated_at = CURRENT_TIMESTAMP

                WHERE customer_id = ?
                `,
                [customerId],
                function (error) {

                    if (error) {

                        console.error(
                            "Archive customer error:",
                            error
                        );

                        sendJSON(res, 500, {
                            success: false,
                            message:
                                "Unable to archive customer."
                        });

                        return;
                    }

                    if (this.changes === 0) {

                        sendJSON(res, 404, {
                            success: false,
                            message:
                                "Customer not found."
                        });

                        return;
                    }

                    // An archived customer who is still signed in is signed out at once.
                    revokeCustomerSessions(customerId);

                    sendJSON(res, 200, {
                        success: true,
                        message:
                            "Customer archived successfully."
                    });

                }
            );

        });

        return;
    }


    // ==========================================
    // INVENTORY MOVEMENTS PAGE
    // ==========================================

    if (req.method === "PUT" && url === "/api/customers/restore") {
        const user = requireLogin(sessions, req, res);
        if (!user) return;
        getRequestBody(req, (error, data) => {
            const customerId = Number(data && data.customer_id);
            if (error || !customerId) return sendJSON(res, 400, { success: false, message: "Customer ID is required." });
            db.run(`UPDATE customers SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE customer_id = ?`, [customerId], function (restoreError) {
                if (restoreError) return sendJSON(res, 500, { success: false, message: "Unable to restore customer." });
                if (!this.changes) return sendJSON(res, 404, { success: false, message: "Customer not found." });
                sendJSON(res, 200, { success: true, message: "Customer restored successfully." });
            });
        });
        return;
    }

    if (req.method === "GET" && url === "/api/dashboard/metrics") {
        const user = requireLogin(sessions, req, res);
        if (!user) return;
        db.get(`SELECT COALESCE(SUM(i.quantity * p.price), 0) AS stock_value FROM inventory i JOIN products p ON p.product_id = i.product_id WHERE p.status = 'active'`, [], (valueError, value) => {
            if (valueError) return sendJSON(res, 500, { success: false, message: "Unable to calculate stock value." });
            db.get(`SELECT COUNT(*) AS sales_velocity FROM orders WHERE status = 'completed' AND order_date >= datetime('now', '-30 days')`, [], (salesError, sales) => {
                if (salesError) return sendJSON(res, 500, { success: false, message: "Unable to calculate sales velocity." });
                db.all(`SELECT m.movement_type, m.quantity, m.reason, m.created_at, p.product_name FROM inventory_movements m JOIN products p ON p.product_id = m.product_id ORDER BY m.created_at DESC, m.movement_id DESC`, [], (movementError, movements) => {
                    if (movementError) return sendJSON(res, 500, { success: false, message: "Unable to load recent transactions." });
                    db.run(`INSERT INTO stock_value_snapshots (snapshot_date, stock_value) VALUES (date('now', '+8 hours'), ?)
                        ON CONFLICT(snapshot_date) DO UPDATE SET stock_value = excluded.stock_value`, [Number(value.stock_value || 0)], snapshotError => {
                        if (snapshotError) return sendJSON(res, 500, { success: false, message: "Unable to record stock value." });
                        // Chart period: a month picked on the dashboard calendar (?month=2026-09),
                        // otherwise the last 30 days. Days use Philippine time.
                        const month = new URLSearchParams(req.url.split("?")[1] || "").get("month") || "";
                        const byMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
                        const first = byMonth ? `date(?)` : `date('now', '+8 hours', '-29 days')`;
                        const last = byMonth ? `date(?, '+1 month', '-1 day')` : `date('now', '+8 hours')`;
                        db.all(`WITH RECURSIVE days(day) AS (
                            SELECT ${first}
                            UNION ALL SELECT date(day, '+1 day') FROM days WHERE day < ${last}
                        ), sales_by_day AS (
                            SELECT date(order_date, '+8 hours') AS day, SUM(total_amount) AS sales, COUNT(*) AS orders
                            FROM orders WHERE status = 'completed' GROUP BY date(order_date, '+8 hours')
                        ) SELECT days.day, s.stock_value, COALESCE(o.sales, 0) AS sales, COALESCE(o.orders, 0) AS orders
                        FROM days LEFT JOIN stock_value_snapshots s ON s.snapshot_date = days.day
                        LEFT JOIN sales_by_day o ON o.day = days.day ORDER BY days.day`, byMonth ? [month + "-01", month + "-01"] : [], (trendError, trend) => {
                            if (trendError) return sendJSON(res, 500, { success: false, message: "Unable to load value trends." });
                            // The "Sales (30 days)" card always covers the last 30 days, whatever month the chart shows.
                            db.get(`SELECT COALESCE(SUM(total_amount), 0) AS total FROM orders WHERE status = 'completed'
                                AND date(order_date, '+8 hours') >= date('now', '+8 hours', '-29 days')`, [], (totalError, recent) => {
                                if (totalError) return sendJSON(res, 500, { success: false, message: "Unable to calculate sales." });
                                sendJSON(res, 200, { success: true, stock_value: Number(value.stock_value || 0), sales_velocity: Number(sales.sales_velocity || 0),
                                    sales_30_days: Number(recent.total || 0), period: byMonth ? month : "last30", recent_transactions: movements, trend });
                            });
                        });
                    });
                });
            });
        });
        return;
    }

    if (req.method === "POST" && url === "/api/reports/email") {
        const user = requireAdmin(sessions, req, res);
        if (!user) return;
        if (!emailReports.isConfigured()) return sendJSON(res, 503, { success: false, message: "Gmail reporting is not configured. Set GMAIL_USER, GMAIL_APP_PASSWORD, and REPORT_RECIPIENT." });
        db.get(`SELECT
                (SELECT COALESCE(SUM(i.quantity * p.price), 0) FROM inventory i JOIN products p ON p.product_id = i.product_id WHERE p.status = 'active') AS stock_value,
                (SELECT COUNT(*) FROM products WHERE status = 'active') AS active_products,
                (SELECT COALESCE(SUM(total_amount), 0) FROM orders WHERE status = 'completed' AND date(order_date, '+8 hours') >= date('now', '+8 hours', '-29 days')) AS sales_30_days,
                (SELECT COUNT(*) FROM orders WHERE status = 'completed' AND date(order_date, '+8 hours') >= date('now', '+8 hours', '-29 days')) AS completed_30_days,
                (SELECT COUNT(*) FROM orders WHERE status = 'pending') AS pending_orders,
                (SELECT COUNT(*) FROM delivery_schedules WHERE status IN ('scheduled', 'out_for_delivery', 'awaiting_customer')) AS deliveries_in_progress,
                (SELECT COALESCE(SUM(cash_collected), 0) FROM delivery_schedules WHERE cash_collected > 0 AND remitted_at IS NULL) AS cash_not_remitted`, [], (valueError, summary) => {
            if (valueError) return sendJSON(res, 500, { success: false, message: "Unable to build the report." });
            db.all(`SELECT p.product_name, COALESCE(i.quantity, 0) AS quantity, COALESCE(i.minimum_stock, 0) AS minimum_stock
                FROM products p LEFT JOIN inventory i ON i.product_id = p.product_id
                WHERE p.status = 'active' AND COALESCE(i.quantity, 0) <= COALESCE(i.minimum_stock, 0) ORDER BY p.product_name`, [], async (lowError, lowStock) => {
            if (lowError) return sendJSON(res, 500, { success: false, message: "Unable to build the report." });
            try {
                await emailReports.sendStationSummary({ ...summary, low_stock: lowStock }, user.full_name || user.username);
                sendJSON(res, 200, { success: true, message: `Station summary sent by email to ${process.env.REPORT_RECIPIENT}.` });
            } catch (error) {
                console.error("Gmail report error:", error.message);
                sendJSON(res, 502, { success: false, message: "Gmail could not send the report. Check the App Password and recipient settings." });
            }
            });
        });
        return;
    }

    if (req.method === "GET" && url === "/customer-accounts") {
        if (!requireAdmin(sessions, req, res)) return;
        servePage("customer-accounts.html", res);
        return;
    }

    if (req.method === "GET" && url === "/api/customer-accounts") {
        if (!requireAdmin(sessions, req, res)) return;
        db.all(`SELECT a.customer_id, a.username, a.status, c.customer_name, c.contact_number, COALESCE(v.destination, e.destination, '') AS email, CASE WHEN v.destination IS NOT NULL THEN 1 ELSE 0 END AS email_verified
            FROM customer_accounts a JOIN customers c ON c.customer_id = a.customer_id LEFT JOIN verified_contacts v ON v.account_type = 'customer' AND v.account_id = a.account_id AND v.channel = 'email'
            LEFT JOIN verified_contacts e ON e.account_type = 'customer' AND e.account_id = a.account_id AND e.channel = 'unverified_email' 
            ORDER BY c.customer_name`, [], (error, accounts) => {
            if (error) return sendJSON(res, 500, { success: false, message: "Unable to load customer accounts." });
            sendJSON(res, 200, { success: true, accounts });
        });
        return;
    }

    if (req.method === "POST" && url === "/api/customers/email/request") {
        customerEmail(req, res);
        return;
    }

    // Customer login administration is separate from editing delivery details.
    if (req.method === "GET" && url === "/api/customers/account") {
        if (!requireAdmin(sessions, req, res)) return;
        const customerId = Number(new URL(req.url, "http://localhost").searchParams.get("customer_id"));
        if (!Number.isSafeInteger(customerId) || customerId < 1) return sendJSON(res, 400, { success: false, message: "Invalid customer." });
        db.get(`SELECT a.customer_id, a.username, a.status, c.contact_number, COALESCE(v.destination, e.destination, '') AS email, CASE WHEN v.destination IS NOT NULL THEN 1 ELSE 0 END AS email_verified FROM customer_accounts a JOIN customers c ON c.customer_id = a.customer_id LEFT JOIN verified_contacts v ON v.account_type = 'customer' AND v.account_id = a.account_id AND v.channel = 'email'
            LEFT JOIN verified_contacts e ON e.account_type = 'customer' AND e.account_id = a.account_id AND e.channel = 'unverified_email'  WHERE a.customer_id = ?`, [customerId], (error, account) => {
            if (error) return sendJSON(res, 500, { success: false, message: "Unable to load customer account." });
            if (!account) return sendJSON(res, 404, { success: false, message: "This customer has no registered portal account." });
            sendJSON(res, 200, { success: true, account });
        });
        return;
    }

    if (req.method === "PUT" && url === "/api/customers/account") {
        if (!requireAdmin(sessions, req, res)) return;
        getRequestBody(req, async (error, data) => {
            if (error || !data) return sendJSON(res, 400, { success: false, message: "Invalid request." });
            const customerId = Number(data.customer_id);
            const username = String(data.username || "").trim();
            const password = String(data.password || "");
            const status = String(data.status || "");
            if (!Number.isSafeInteger(customerId) || customerId < 1 || !/^[A-Za-z0-9_.-]{3,32}$/.test(username) || !["active", "inactive", "pending"].includes(status)) {
                return sendJSON(res, 400, { success: false, message: "Enter a valid customer, account status, and username (3–32 letters, numbers, dots, underscores, or hyphens)." });
            }
            if (password && !validateStrongPassword(password)) return sendJSON(res, 400, { success: false, message: "Use 8+ characters with uppercase, lowercase, a number, and a special character." });
            // The contact number is optional here; when sent it must be a PH mobile number.
            const contactNumber = data.contact_number === undefined ? null : String(data.contact_number).replace(/[\s-]/g, "").replace(/^\+?63(?=9\d{9}$)/, "0");
            if (contactNumber !== null && !/^09\d{9}$/.test(contactNumber)) return sendJSON(res, 400, { success: false, message: "Enter the mobile number as +63 followed by 10 digits, starting with 9." });
            try {
                const account = await dbGet("SELECT a.customer_id, a.username, a.status FROM customer_accounts a WHERE a.customer_id = ?", [customerId]);
                if (!account) return sendJSON(res, 404, { success: false, message: "This customer has no registered portal account." });
                const duplicate = await dbGet("SELECT username FROM users WHERE username = ? UNION SELECT username FROM customer_accounts WHERE username = ? AND customer_id <> ?", [username, username, customerId]);
                if (duplicate) return sendJSON(res, 409, { success: false, message: "That username is already in use." });
                const hash = password ? await bcrypt.hash(password, 12) : null;
                const result = await dbRun("UPDATE customer_accounts SET username = ?, password = COALESCE(?, password), status = ? WHERE customer_id = ?", [username, hash, status, customerId]);
                if (!result.changes) return sendJSON(res, 404, { success: false, message: "Customer account not found." });
                if (contactNumber !== null) {
                    await dbRun("UPDATE customers SET contact_number = ?, updated_at = CURRENT_TIMESTAMP WHERE customer_id = ?", [contactNumber, customerId]);
                    await syncCustomerDeliveries(customerId);
                }
                // Only a change to the login itself signs the customer out.
                const loginChanged = hash || username !== account.username || status !== account.status;
                if (loginChanged) {
                    for (const [sessionId, session] of sessions) {
                        if (session.role === "customer" && Number(session.customer_id) === customerId) {
                            sessions.delete(sessionId);
                            sessionExpiry.delete(sessionId);
                            sessionTimestamps.delete(sessionId);
                        }
                    }
                }
                sendJSON(res, 200, { success: true, message: loginChanged ? "Customer account updated. The customer must sign in again." : "Customer account updated." });
            } catch (updateError) {
                sendJSON(res, updateError.code === "SQLITE_CONSTRAINT" ? 409 : 500, { success: false, message: updateError.code === "SQLITE_CONSTRAINT" ? "That username is already in use." : "Unable to update customer account." });
            }
        });
        return;
    }

    // A portal login made by staff for a customer without email (e.g. at the counter).
    // The customer signs in with it and should change the password in Account settings.
    if (req.method === "POST" && url === "/api/customers/account/create") {
        const user = requireStaff(sessions, req, res);
        if (!user) return;
        getRequestBody(req, async (error, data) => {
            const customerId = Number(data && data.customer_id);
            const username = String(data && data.username || "").trim();
            const password = String(data && data.password || "");
            if (error || !Number.isSafeInteger(customerId) || customerId < 1) return sendJSON(res, 400, { success: false, message: "Choose a customer." });
            if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) return sendJSON(res, 400, { success: false, message: "Username must be 3–32 letters, numbers, dots, underscores, or hyphens." });
            if (!validateStrongPassword(password)) return sendJSON(res, 400, { success: false, message: PASSWORD_RULE });
            try {
                const customer = await dbGet("SELECT status FROM customers WHERE customer_id = ?", [customerId]);
                if (!customer) return sendJSON(res, 404, { success: false, message: "Customer not found." });
                if (customer.status !== "active") return sendJSON(res, 400, { success: false, message: "Restore the customer first; archived customers cannot sign in." });
                if (await dbGet("SELECT 1 FROM customer_accounts WHERE customer_id = ?", [customerId])) return sendJSON(res, 409, { success: false, message: "This customer already has a portal login. The admin can change it in Customer Accounts." });
                if (await dbGet("SELECT username FROM users WHERE username = ? UNION SELECT username FROM customer_accounts WHERE username = ?", [username, username])) return sendJSON(res, 409, { success: false, message: "That username is already in use." });
                await dbRun("INSERT INTO customer_accounts (customer_id, username, password, status) VALUES (?, ?, ?, 'active')", [customerId, username, await bcrypt.hash(password, 12)]);
                sendJSON(res, 200, { success: true, message: `Login created. Give the customer the username "${username}" and the password you set, and ask them to change the password after signing in.` });
            } catch (createError) {
                sendJSON(res, createError.code === "SQLITE_CONSTRAINT" ? 409 : 500, { success: false, message: createError.code === "SQLITE_CONSTRAINT" ? "That username is already in use." : "Unable to create the login." });
            }
        });
        return;
    }
    // Customers may deactivate their own account. This archives the linked
    // customer record instead of deleting orders and reports.
    if (req.method === "POST" && url === "/api/customer/account/deactivate") {
        const user = requireCustomer(sessions, req, res);
        if (!user) return;
        getRequestBody(req, (error, data) => {
            if (error || String(data.confirmation || "").toUpperCase() !== "DEACTIVATE") {
                return sendJSON(res, 400, { success: false, message: "Type DEACTIVATE to confirm account removal." });
            }
            db.run("UPDATE customer_accounts SET status = 'inactive' WHERE customer_id = ?", [user.customer_id], accountError => {
                if (accountError) return sendJSON(res, 500, { success: false, message: "Unable to deactivate account." });
                db.run("UPDATE customers SET status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE customer_id = ?", [user.customer_id], customerError => {
                    if (customerError) return sendJSON(res, 500, { success: false, message: "Unable to archive customer record." });
                    const sessionId = getSessionId(req);
                    if (sessionId) {
                        sessions.delete(sessionId);
                        sessionTimestamps.delete(sessionId);
                        sessionExpiry.delete(sessionId);
                    }
                    res.writeHead(200, responseHeaders("application/json; charset=utf-8", { "Set-Cookie": "sessionId=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax" }));
                    res.end(JSON.stringify({ success: true, message: "Your account was deactivated." }));
                });
            });
        });
        return;
    }

    if (
        req.method === "GET" &&
        url === "/inventory-movements"
    ) {

        const user =
            requireLogin(
                sessions,
                req,
                res
            );

        if (!user) {
            return;
        }

        servePage(
            "inventory-movements.html",
            res
        );

        return;
    }


    // ==========================================
    // GET INVENTORY
    // ==========================================

    if (
        req.method === "GET" &&
        url === "/api/inventory"
    ) {

        const user =
            requireLogin(
                sessions,
                req,
                res
            );

        if (!user) {
            return;
        }

        db.all(
            `
            SELECT
                products.product_id,
                products.product_name,
                products.category,
                products.description,
                products.unit,
                products.price,
                COALESCE(products.new_container_price, 0) AS new_container_price,
                products.supplier_name,
                products.status,

                COALESCE(
                    inventory.quantity,
                    0
                ) AS quantity,

                COALESCE(
                    inventory.minimum_stock,
                    0
                ) AS minimum_stock,

                CASE
                    WHEN COALESCE(inventory.quantity, 0)
                         <= COALESCE(inventory.minimum_stock, 0)
                    THEN 'low-stock'
                    ELSE 'available'
                END AS stock_status

            FROM products

            LEFT JOIN inventory
                ON products.product_id =
                   inventory.product_id

            -- Products in Recently deleted (or deleted for good) are not listed.
            WHERE products.status NOT IN ('removed', 'deleted')

            ORDER BY
                products.product_name ASC
            `,
            [],
            (error, rows) => {

                if (error) {

                    console.error(
                        "Inventory loading error:",
                        error
                    );

                    sendJSON(res, 500, {
                        success: false,
                        message:
                            "Unable to load inventory."
                    });

                    return;
                }

                sendJSON(
                    res,
                    200,
                    rows
                );

            }
        );

        return;
    }


    // ==========================================
    // INVENTORY REPORT
    // ==========================================

    if (req.method === "GET" && url === "/api/reports/sales") {
        const user = requireLogin(sessions, req, res);
        if (!user) return;
        db.all(`SELECT o.order_id, c.customer_name, o.order_date, o.total_amount FROM orders o INNER JOIN customers c ON c.customer_id = o.customer_id WHERE o.status = 'completed' ORDER BY o.order_date DESC`, [], (error, rows) => {
            if (error) return sendJSON(res, 500, { success: false, message: "Unable to generate sales report." });
            sendJSON(res, 200, { success: true, report: rows, summary: { completed_orders: rows.length, total_sales: rows.reduce((total, row) => total + Number(row.total_amount || 0), 0).toFixed(2) } });
        });
        return;
    }

    if (req.method === "GET" && url === "/api/reports/delivery") {
        const user = requireLogin(sessions, req, res);
        if (!user) return;
        db.all(`SELECT d.delivery_id, d.order_id, COALESCE(NULLIF(d.customer_name, ''), c.customer_name) AS customer_name, COALESCE(NULLIF(d.contact_number, ''), c.contact_number) AS contact_number, d.delivery_reason, d.delivery_items, d.delivery_date, d.delivery_time, d.delivery_address, d.status, COALESCE(u.full_name, 'Unassigned') AS assigned_staff FROM delivery_schedules d LEFT JOIN orders o ON o.order_id = d.order_id LEFT JOIN customers c ON c.customer_id = o.customer_id LEFT JOIN users u ON u.user_id = d.assigned_to ORDER BY d.delivery_date DESC, d.delivery_time DESC`, [], (error, rows) => {
            if (error) return sendJSON(res, 500, { success: false, message: "Unable to generate delivery report." });
            sendJSON(res, 200, { success: true, report: rows });
        });
        return;
    }

    if (req.method === "GET" && url === "/api/reports/customers") {
        const user = requireLogin(sessions, req, res);
        if (!user) return;
        db.all(`SELECT c.customer_id, c.customer_name, c.contact_number, c.address, c.customer_type, c.status, COUNT(o.order_id) AS total_orders, COALESCE(SUM(o.total_amount), 0) AS total_spent FROM customers c LEFT JOIN orders o ON o.customer_id = c.customer_id GROUP BY c.customer_id ORDER BY c.customer_name`, [], (error, rows) => {
            if (error) return sendJSON(res, 500, { success: false, message: "Unable to generate customer report." });
            sendJSON(res, 200, { success: true, report: rows });
        });
        return;
    }

    // Setup the admin still has to finish (shown on the dashboard until done).
    if (req.method === "GET" && url === "/api/setup-status") {
        if (!requireAdmin(sessions, req, res)) return;
        db.get("SELECT station_latitude, station_longitude FROM delivery_settings WHERE id = 1", [], (error, settings) => {
            db.all("SELECT username, password FROM users WHERE status = 'active'", [], async (usersError, users) => {
                sendJSON(res, 200, {
                    success: true,
                    email: require("./utils/mailer").configured(),
                    station_location: Boolean(!error && settings && settings.station_latitude != null && settings.station_longitude != null),
                    default_passwords: usersError ? [] : await accountsWithDefaultPasswords(users)
                });
            });
        });
        return;
    }

    // Cash collected by drivers on delivery (cash only; there are no other payment methods).
    if (req.method === "GET" && url === "/api/reports/remittance") {
        const user = requireLogin(sessions, req, res);
        if (!user) return;
        if (!["admin", "staff"].includes(user.role)) return sendJSON(res, 403, { success: false, message: "Only admin or staff can view the remittance report." });
        db.all(`SELECT d.delivery_id, d.order_id, d.driver_delivered_at AS dropped_off_at, COALESCE(NULLIF(d.customer_name, ''), c.customer_name) AS customer_name,
                       COALESCE(u.full_name, 'Unknown driver') AS driver, d.cash_collected, d.remitted_at, r.full_name AS received_by,
                       CASE WHEN d.remitted_at IS NULL THEN 'not_yet_remitted' ELSE 'remitted' END AS remittance_status
                FROM delivery_schedules d
                LEFT JOIN orders o ON o.order_id = d.order_id
                LEFT JOIN customers c ON c.customer_id = o.customer_id
                LEFT JOIN users u ON u.user_id = d.cash_collected_by
                LEFT JOIN users r ON r.user_id = d.remitted_to
                WHERE d.cash_collected > 0
                ORDER BY d.driver_delivered_at DESC`, [], (error, rows) => {
            if (error) return sendJSON(res, 500, { success: false, message: "Unable to generate the remittance report." });
            sendJSON(res, 200, { success: true, report: rows });
        });
        return;
    }

    if (req.method === "GET" && url === "/api/reports/transactions") {
        const user = requireLogin(sessions, req, res);
        if (!user) return;
        db.all(`SELECT o.order_id, c.customer_name, o.order_date, o.total_amount, o.status, COUNT(oi.order_item_id) AS item_count FROM orders o INNER JOIN customers c ON c.customer_id = o.customer_id LEFT JOIN order_items oi ON oi.order_id = o.order_id WHERE o.status = 'completed' GROUP BY o.order_id ORDER BY o.order_date DESC`, [], (error, rows) => {
            if (error) return sendJSON(res, 500, { success: false, message: "Unable to generate transaction report." });
            sendJSON(res, 200, { success: true, report: rows });
        });
        return;
    }

    if (
        req.method === "GET" &&
        url === "/api/reports/inventory"
    ) {

        const user =
            requireLogin(
                sessions,
                req,
                res
            );

        if (!user) {
            return;
        }

        db.all(
            `
            SELECT
                products.product_id,
                products.product_name,
                products.category,
                products.unit,
                products.price,
                products.status,

                COALESCE(
                    inventory.quantity,
                    0
                ) AS quantity,

                COALESCE(
                    inventory.minimum_stock,
                    0
                ) AS minimum_stock,

                CASE
                    WHEN COALESCE(inventory.quantity, 0)
                         <= COALESCE(inventory.minimum_stock, 0)
                    THEN 'Low Stock'
                    ELSE 'Available'
                END AS stock_status

            FROM products

            LEFT JOIN inventory
                ON products.product_id =
                   inventory.product_id

            WHERE products.status NOT IN ('removed', 'deleted')

            ORDER BY
                products.product_name ASC
            `,
            [],
            (error, rows) => {

                if (error) {

                    console.error(
                        "Inventory report error:",
                        error
                    );

                    sendJSON(res, 500, {
                        success: false,
                        message:
                            "Unable to generate inventory report."
                    });

                    return;
                }

                sendJSON(res, 200, {
                    success: true,
                    report: rows
                });

            }
        );

        return;
    }


    // ==========================================
    // MONITOR STOCK LEVEL (DFD 2.4)
    // ==========================================

    if (
        req.method === "GET" &&
        url === "/api/inventory/low-stock"
    ) {

        const user =
            requireLogin(
                sessions,
                req,
                res
            );

        if (!user) {
            return;
        }

        db.all(
            `
            SELECT
                products.product_id,
                products.product_name,
                products.category,
                products.unit,
                COALESCE(inventory.quantity, 0) AS quantity,
                COALESCE(inventory.minimum_stock, 0) AS minimum_stock,
                (COALESCE(inventory.minimum_stock, 0) - COALESCE(inventory.quantity, 0)) AS shortage

            FROM products
            LEFT JOIN inventory ON products.product_id = inventory.product_id
            WHERE products.status = 'active'
            AND COALESCE(inventory.quantity, 0) <= COALESCE(inventory.minimum_stock, 0)
            ORDER BY shortage DESC
            `,
            [],
            (error, rows) => {

                if (error) {

                    console.error("Low stock check error:", error);

                    sendJSON(res, 500, {
                        success: false,
                        message: "Unable to check low stock items."
                    });

                    return;
                }

                sendJSON(res, 200, {
                    success: true,
                    low_stock_items: rows,
                    count: rows.length
                });

            }
        );

        return;
    }


    // ==========================================
    // MONITOR INVENTORY HEALTH (Summary)
    // ==========================================

    if (
        req.method === "GET" &&
        url === "/api/inventory/health"
    ) {

        const user =
            requireLogin(
                sessions,
                req,
                res
            );

        if (!user) {
            return;
        }

        db.all(
            `
            SELECT
                COUNT(*) as total_products,
                SUM(CASE WHEN COALESCE(i.quantity, 0) > i.minimum_stock THEN 1 ELSE 0 END) as in_stock,
                SUM(CASE WHEN COALESCE(i.quantity, 0) <= i.minimum_stock THEN 1 ELSE 0 END) as low_stock,
                ROUND(SUM(COALESCE(i.quantity, 0) * p.price), 2) as total_inventory_value

            FROM products p
            LEFT JOIN inventory i ON p.product_id = i.product_id
            WHERE p.status = 'active'
            `,
            [],
            (error, rows) => {

                if (error) {

                    console.error("Inventory health check error:", error);

                    sendJSON(res, 500, {
                        success: false,
                        message: "Unable to check inventory health."
                    });

                    return;
                }

                const health = rows[0] || {
                    total_products: 0,
                    in_stock: 0,
                    low_stock: 0,
                    total_inventory_value: 0
                };

                sendJSON(res, 200, {
                    success: true,
                    inventory_health: health
                });

            }
        );

        return;
    }


    // ==========================================
    // ADD PRODUCT
    // ==========================================

    if (
        req.method === "POST" &&
        url === "/api/inventory/add"
    ) {

        const user =
            requireLogin(
                sessions,
                req,
                res
            );

        if (!user) {
            return;
        }

        getRequestBody(req, (error, data) => {

            if (error) {

                sendJSON(res, 400, {
                    success: false,
                    message: "Invalid request."
                });

                return;
            }

            const productName =
                String(
                    data.product_name || ""
                ).trim();

            const category =
                String(
                    data.category || ""
                ).trim();

            const description =
                String(
                    data.description || ""
                ).trim();

            const unit =
                String(
                    data.unit || ""
                ).trim();

            const supplierName = String(data.supplier_name || "").trim();

            const price =
                Number(data.price);

            const quantity =
                Number(data.quantity);

            const minimumStock =
                Number(data.minimum_stock);

            const finalPrice =
                Number.isFinite(price) &&
                price >= 0
                    ? price
                    : 0;

            const finalQuantity =
                Number.isFinite(quantity) &&
                quantity >= 0
                    ? quantity
                    : 0;

            const finalMinimumStock =
                Number.isFinite(minimumStock) &&
                minimumStock >= 0
                    ? minimumStock
                    : 0;

            // Category and description are no longer entered on the
            // Inventory page, so they are optional (stored as blank).
            if (
                !productName ||
                !unit
            ) {

                sendJSON(res, 400, {
                    success: false,
                    message:
                        "Product name and unit are required."
                });

                return;
            }

            if (
                price < 0 ||
                quantity < 0 ||
                minimumStock < 0
            ) {

                sendJSON(res, 400, {
                    success: false,
                    message:
                        "Price and stock values cannot be negative."
                });

                return;
            }

            // A typo like "abc" used to be saved as ₱0.00 without a warning.
            const productProblem = productFieldsProblem({ productName, unit, price: data.price, quantity: data.quantity, minimumStock: data.minimum_stock, containerPrice: data.new_container_price });
            if (productProblem) return sendJSON(res, 400, { success: false, message: productProblem });
            const containerPrice = Number(data.new_container_price) || 0;

            const stockStatus =
                finalQuantity <= finalMinimumStock
                    ? "low-stock"
                    : "available";

            // A product deleted for good (kept only for old receipts) does not block its name.
            db.get("SELECT product_name, status FROM products WHERE LOWER(TRIM(product_name)) = LOWER(?) AND status <> 'deleted'", [productName], (duplicateError, existing) => {
            if (duplicateError) return sendJSON(res, 500, { success: false, message: "Unable to check the product name." });
            if (existing) return sendJSON(res, 409, { success: false, message: existing.status === "active"
                ? `A product named "${existing.product_name}" already exists. Edit that product instead.`
                : existing.status === "removed"
                    ? `A product named "${existing.product_name}" is in Recently deleted. Restore it there, or delete it permanently first.`
                    : `A product named "${existing.product_name}" is archived. Restore it from the archived products instead of adding it again.` });
            db.run(
                `
                INSERT INTO products
                (
                    product_name,
                    category,
                    description,
                    unit,
                    price,
                    supplier_name,
                    new_container_price,
                    status
                )

                VALUES
                (?, ?, ?, ?, ?, ?, ?, 'active')
                `,
                [
                    productName,
                    category,
                    description,
                    unit,
                    finalPrice,
                    supplierName,
                    containerPrice
                ],
                function (error) {

                    if (error) {

                        console.error(
                            "Add product error:",
                            error
                        );

                        sendJSON(res, 500, {
                            success: false,
                            message:
                                "Unable to add product."
                        });

                        return;
                    }

                    const productId =
                        this.lastID;

                    db.run(
                        `
                        INSERT INTO inventory
                        (
                            product_id,
                            quantity,
                            minimum_stock,
                            stock_status
                        )

                        VALUES
                        (?, ?, ?, ?)
                        `,
                        [
                            productId,
                            finalQuantity,
                            finalMinimumStock,
                            stockStatus
                        ],
                        function (error) {

                            if (error) {

                                console.error(
                                    "Create inventory error:",
                                    error
                                );

                                sendJSON(res, 500, {
                                    success: false,
                                    message:
                                        "Product added, but inventory could not be created."
                                });

                                return;
                            }

                            if (finalQuantity > 0) {

                                db.run(
                                    `
                                    INSERT INTO inventory_movements
                                    (
                                        product_id,
                                        movement_type,
                                        quantity,
                                        reason,
                                        user_id
                                    )

                                    VALUES
                                    (?, 'stock_in', ?, ?, ?)
                                    `,
                                    [
                                        productId,
                                        finalQuantity,
                                        "Initial stock",
                                        user.user_id
                                    ],
                                    movementError => {

                                        if (movementError) {

                                            console.error(
                                                "Initial movement error:",
                                                movementError
                                            );

                                        }

                                    }
                                );

                            }

                            sendJSON(res, 200, {
                                success: true,
                                message:
                                    "Product added successfully.",
                                product_id:
                                    productId
                            });

                        }
                    );

                }
            );
            });

        });

        return;
    }


    // ==========================================
    // UPDATE PRODUCT
    // ==========================================

    if (
        req.method === "PUT" &&
        url === "/api/inventory/update"
    ) {

        const user =
            requireLogin(
                sessions,
                req,
                res
            );

        if (!user) {
            return;
        }

        getRequestBody(req, (error, data) => {

            if (error) {

                sendJSON(res, 400, {
                    success: false,
                    message: "Invalid request."
                });

                return;
            }

            const productId =
                Number(data.product_id);

            const productName =
                String(
                    data.product_name || ""
                ).trim();

            const category =
                String(
                    data.category || ""
                ).trim();

            const description =
                String(
                    data.description || ""
                ).trim();

            const unit =
                String(
                    data.unit || ""
                ).trim();

            const supplierName = String(data.supplier_name || "").trim();

            const price =
                Number(data.price);

            const quantity =
                Number(data.quantity);

            const minimumStock =
                Number(data.minimum_stock);

            if (!productId) {

                sendJSON(res, 400, {
                    success: false,
                    message:
                        "Product ID is required."
                });

                return;
            }

            // Category and description are no longer on the Inventory form.
            if (
                !productName ||
                !unit
            ) {

                sendJSON(res, 400, {
                    success: false,
                    message:
                        "Product name and unit are required."
                });

                return;
            }

            if (
                !Number.isFinite(price) ||
                !Number.isFinite(quantity) ||
                !Number.isFinite(minimumStock)
            ) {

                sendJSON(res, 400, {
                    success: false,
                    message:
                        "Price and stock values must be valid numbers."
                });

                return;
            }

            const productProblem = price >= 0 && quantity >= 0 && minimumStock >= 0
                ? productFieldsProblem({ productName, unit, price: data.price, quantity: data.quantity, minimumStock: data.minimum_stock, containerPrice: data.new_container_price }) : "";
            if (productProblem) return sendJSON(res, 400, { success: false, message: productProblem });
            // Not sent (older forms): keep the saved new gallon price.
            const containerPrice = data.new_container_price === undefined ? null : (Number(data.new_container_price) || 0);

            if (
                price < 0 ||
                quantity < 0 ||
                minimumStock < 0
            ) {

                sendJSON(res, 400, {
                    success: false,
                    message:
                        "Price and stock values cannot be negative."
                });

                return;
            }

            db.get(
                `
                SELECT
                    quantity,
                    minimum_stock,
                    (SELECT product_name FROM products WHERE LOWER(TRIM(product_name)) = LOWER(?) AND product_id <> ? AND status <> 'deleted') AS name_taken_by

                FROM inventory

                WHERE product_id = ?
                `,
                [productName, productId, productId],
                (inventoryError, oldInventory) => {

                    if (!inventoryError && oldInventory && oldInventory.name_taken_by) {
                        return sendJSON(res, 409, { success: false, message: `Another product is already named "${oldInventory.name_taken_by}". Choose a different name.` });
                    }

                    if (inventoryError) {

                        console.error(
                            "Inventory lookup error:",
                            inventoryError
                        );

                        sendJSON(res, 500, {
                            success: false,
                            message:
                                "Unable to check inventory."
                        });

                        return;
                    }

                    const oldQuantity =
                        oldInventory
                            ? Number(oldInventory.quantity)
                            : 0;

                    db.run(
                        `
                        UPDATE products

                        SET
                            product_name = ?,
                            category = COALESCE(?, category),
                            description = COALESCE(?, description),
                            unit = ?,
                            price = ?,
                            supplier_name = ?,
                            new_container_price = COALESCE(?, new_container_price)

                        WHERE product_id = ? AND status NOT IN ('removed', 'deleted')
                        `,
                        [
                            productName,
                            // Not sent by the form: keep the saved values.
                            data.category === undefined ? null : category,
                            data.description === undefined ? null : description,
                            unit,
                            price,
                            supplierName,
                            containerPrice,
                            productId
                        ],
                        function (error) {

                            if (error) {

                                console.error(
                                    "Update product error:",
                                    error
                                );

                                sendJSON(res, 500, {
                                    success: false,
                                    message:
                                        "Unable to update product."
                                });

                                return;
                            }

                            if (this.changes === 0) {

                                sendJSON(res, 404, {
                                    success: false,
                                    message:
                                        "Product not found."
                                });

                                return;
                            }

                            const stockStatus =
                                quantity <= minimumStock
                                    ? "low-stock"
                                    : "available";

                            if (oldInventory) {

                                db.run(
                                    `
                                    UPDATE inventory

                                    SET
                                        quantity = ?,
                                        minimum_stock = ?,
                                        stock_status = ?,
                                        updated_at =
                                            CURRENT_TIMESTAMP

                                    WHERE product_id = ?
                                    `,
                                    [
                                        quantity,
                                        minimumStock,
                                        stockStatus,
                                        productId
                                    ],
                                    function (inventoryUpdateError) {

                                        if (inventoryUpdateError) {

                                            console.error(
                                                inventoryUpdateError
                                            );

                                            sendJSON(res, 500, {
                                                success: false,
                                                message:
                                                    "Product updated, but inventory could not be updated."
                                            });

                                            return;
                                        }

                                        recordManualInventoryChange(
                                            productId,
                                            oldQuantity,
                                            quantity,
                                            user.user_id,
                                            res
                                        );

                                    }
                                );

                                return;
                            }

                            db.run(
                                `
                                INSERT INTO inventory
                                (
                                    product_id,
                                    quantity,
                                    minimum_stock,
                                    stock_status
                                )

                                VALUES
                                (?, ?, ?, ?)
                                `,
                                [
                                    productId,
                                    quantity,
                                    minimumStock,
                                    stockStatus
                                ],
                                function (inventoryInsertError) {

                                    if (inventoryInsertError) {

                                        console.error(
                                            inventoryInsertError
                                        );

                                        sendJSON(res, 500, {
                                            success: false,
                                            message:
                                                "Product updated, but inventory could not be created."
                                        });

                                        return;
                                    }

                                    if (quantity > 0) {

                                        db.run(
                                            `
                                            INSERT INTO inventory_movements
                                            (
                                                product_id,
                                                movement_type,
                                                quantity,
                                                reason,
                                                user_id
                                            )

                                            VALUES
                                            (?, 'stock_in', ?, ?, ?)
                                            `,
                                            [
                                                productId,
                                                quantity,
                                                "Inventory created during product update",
                                                user.user_id
                                            ]
                                        );

                                    }

                                    sendJSON(res, 200, {
                                        success: true,
                                        message:
                                            "Product updated successfully."
                                    });

                                }
                            );

                        }
                    );

                }
            );

        });

        return;
    }


    // ==========================================
    // PRODUCT STATUS
    // ==========================================

    if (
        req.method === "PUT" &&
        url === "/api/inventory/status"
    ) {

        const user =
            requireLogin(
                sessions,
                req,
                res
            );

        if (!user) {
            return;
        }

        getRequestBody(req, (error, data) => {

            if (error) {

                sendJSON(res, 400, {
                    success: false,
                    message: "Invalid request."
                });

                return;
            }

            const productId =
                Number(data.product_id);

            const status =
                String(data.status || "");

            if (!productId) {

                sendJSON(res, 400, {
                    success: false,
                    message:
                        "Product ID is required."
                });

                return;
            }

            if (
                status !== "active" &&
                status !== "archived"
            ) {

                sendJSON(res, 400, {
                    success: false,
                    message:
                        "Invalid product status."
                });

                return;
            }

            db.run(
                `
                UPDATE products

                SET
                    status = ?

                -- A product in Recently deleted is brought back with Restore, not here.
                WHERE product_id = ? AND status NOT IN ('removed', 'deleted')
                `,
                [
                    status,
                    productId
                ],
                function (error) {

                    if (error) {

                        console.error(
                            "Product status error:",
                            error
                        );

                        sendJSON(res, 500, {
                            success: false,
                            message:
                                "Unable to change product status."
                        });

                        return;
                    }

                    if (this.changes === 0) {

                        sendJSON(res, 404, {
                            success: false,
                            message:
                                "Product not found."
                        });

                        return;
                    }

                    sendJSON(res, 200, {
                        success: true,
                        message:
                            status === "archived"
                                ? "Product archived successfully."
                                : "Product activated successfully."
                    });

                }
            );

        });

        return;
    }


    // ==========================================
    // Stock adjustments use one atomic database operation, including their history.
    // Remove a product, list/restore Recently deleted, and delete permanently from there.
    if (recentlyRemoved.ROUTES.includes(url)) {
        recentlyRemoved.handle(req, res, url);
        return;
    }

    if (req.method === "POST" && ["/api/inventory/stock-in", "/api/inventory/stock-out"].includes(url)) {
        stockMovements(req, res);
        return;
    }

    // INVENTORY MOVEMENTS API
    // ==========================================

    if (
        req.method === "GET" &&
        url === "/api/inventory/movements"
    ) {

        const user =
            requireLogin(
                sessions,
                req,
                res
            );

        if (!user) {
            return;
        }

        db.all(
            `
            SELECT
                inventory_movements.movement_id,
                inventory_movements.product_id,
                products.product_name,
                inventory_movements.movement_type,
                inventory_movements.quantity,
                inventory_movements.reason,
                inventory_movements.created_at

            FROM inventory_movements

            LEFT JOIN products
                ON inventory_movements.product_id =
                   products.product_id

            ORDER BY
                inventory_movements.created_at DESC,
                inventory_movements.movement_id DESC
            `,
            [],
            (error, rows) => {

                if (error) {

                    console.error(error);

                    sendJSON(res, 500, {
                        success: false,
                        message:
                            "Unable to load inventory movements."
                    });

                    return;
                }

                sendJSON(
                    res,
                    200,
                    rows
                );

            }
        );

        return;
    }

// ==========================================
// DELIVERY TRACKING PAGE
// ==========================================

if (
    req.method === "GET" &&
    (url === "/delivery-tracking" || url === "/scheduling")
) {
    const user = requireLogin(sessions, req, res);
    if (!user) return;
    res.writeHead(302, { Location: "/delivery" });
    res.end();
    return;
}

    // ==========================================
    // DELIVERY PAGE
    // ==========================================

    if (
        req.method === "GET" &&
        url === "/delivery"
    ) {

        const user =
            requireLogin(
                sessions,
                req,
                res
            );

        if (!user) {
            return;
        }

        servePage(
            "delivery.html",
            res
        );

        return;
    }


    // ==========================================
    // GET DELIVERIES
    // ==========================================

    if (
        req.method === "GET" &&
        url === "/api/deliveries"
    ) {

        const user =
            requireLogin(
                sessions,
                req,
                res
            );

        if (!user) {
            return;
        }

        db.all(
            `
            SELECT
                        d.delivery_id,
                        d.order_id,
                        d.delivery_date,
                        d.delivery_time,
                        d.delivery_address,
                        d.status,
                        d.assigned_to,
                        d.driver_delivered_at,
                        d.customer_received_at,
                        d.delivery_proof,
                        o.total_amount,
                        d.cash_collected,
                        d.remitted_at,
                        EXISTS(SELECT 1 FROM customer_receipt_photos rp WHERE rp.delivery_id = d.delivery_id) AS has_receipt_photo,
                        EXISTS(SELECT 1 FROM delivery_dropoff_photos dp WHERE dp.delivery_id = d.delivery_id) AS has_dropoff_photo,

                        COALESCE(NULLIF(d.customer_name, ''), c.customer_name) AS customer_name,
                        COALESCE(NULLIF(d.contact_number, ''), c.contact_number) AS contact_number,
                        d.delivery_reason,
                        d.delivery_items,
                        c.city,
                        c.barangay,
                        c.zone,
                        c.street,
                        c.house_number,
                        c.landmark,
                        c.latitude,
                        c.longitude,

                        u.full_name AS assigned_staff

                    FROM delivery_schedules d

                    LEFT JOIN orders o
                        ON o.order_id = d.order_id

                    LEFT JOIN customers c
                        ON c.customer_id = o.customer_id

                    LEFT JOIN users u
                        ON u.user_id = d.assigned_to

                    -- Drivers see their own deliveries plus new ones nobody has been
                    -- assigned to yet (e.g. customer portal orders), so they can take them.
                    WHERE (? <> 'driver' OR d.assigned_to = ? OR (d.assigned_to IS NULL AND d.status = 'scheduled'))
                    -- Newest first, the same order as the Orders page, so a new
                    -- customer order appears at the top of both lists.
                    ORDER BY
                        d.delivery_id DESC
                    `,
                    [user.role, user.user_id],
                    (error, rows) => {

                if (error) {

                    console.error(error);

                    sendJSON(res, 500, {
                        success: false,
                        message:
                            "Unable to load deliveries."
                    });

                    return;
                }

                sendJSON(
                    res,
                    200,
                    rows
                );

            }
        );

        return;
    }


    // ==========================================
    // ADD DELIVERY
    // ==========================================

    // Data for the scheduling form. Staff choose a pending order and an
    // active staff member instead of having to guess database IDs.
    if (req.method === "GET" && url === "/api/deliveries/options") {
        const user = requireLogin(sessions, req, res);
        if (!user) return;

        db.all(`
            SELECT
                o.order_id,
                o.order_date,
                c.customer_name,
                c.contact_number,
                c.address,
                c.city,
                c.barangay,
                c.zone,
                c.street,
                c.house_number,
                c.landmark,
                c.latitude,
                c.longitude,
                GROUP_CONCAT(p.product_name || ' × ' || oi.quantity || CASE WHEN oi.with_new_container = 1 THEN ' (with new gallon)' ELSE '' END, ', ') AS order_items
            FROM orders o
            INNER JOIN customers c ON c.customer_id = o.customer_id
            LEFT JOIN delivery_schedules d ON d.order_id = o.order_id AND d.status != 'cancelled'
            LEFT JOIN order_items oi ON oi.order_id = o.order_id
            LEFT JOIN products p ON p.product_id = oi.product_id
            WHERE o.status = 'pending' AND o.fulfillment_method = 'delivery' AND d.delivery_id IS NULL
            GROUP BY o.order_id
            ORDER BY o.order_date DESC
        `, [], (orderError, orders) => {
            if (orderError) return sendJSON(res, 500, { success: false, message: "Unable to load available orders." });
            db.all(`SELECT user_id, full_name FROM users WHERE status = 'active' AND role IN ('admin', 'staff', 'driver') ORDER BY full_name`, [], (staffError, staff) => {
                if (staffError) return sendJSON(res, 500, { success: false, message: "Unable to load staff members." });
                sendJSON(res, 200, { success: true, orders: orders, staff: staff });
            });
        });
        return;
    }

    // ==========================================
    // DELETE CUSTOMER (ADMIN ONLY)
    // ==========================================

    if (req.method === "DELETE" && url === "/api/customers/delete") {
        const user = requireAdmin(sessions, req, res);
        if (!user) return;

        getRequestBody(req, (error, data) => {
            const customerId = Number(data && data.customer_id);
            if (error || !customerId) {
                sendJSON(res, 400, { success: false, message: "Customer ID is required." });
                return;
            }

            // Orders are business records. Preserve them and use Archive for
            // any customer with transaction history.
            db.get(`SELECT (SELECT COUNT(*) FROM orders WHERE customer_id = ?) + (SELECT COUNT(*) FROM container_events WHERE customer_id = ?)
                           + (SELECT COUNT(*) FROM gallon_ledger WHERE customer_id = ?) AS order_count`, [customerId, customerId, customerId], (countError, result) => {
                if (countError) {
                    sendJSON(res, 500, { success: false, message: "Unable to check customer history." });
                    return;
                }
                if (result.order_count > 0) {
                    sendJSON(res, 409, {
                        success: false,
                        code: "CUSTOMER_HAS_HISTORY",
                        order_count: result.order_count,
                        message: "This customer has order or container history. Archive it instead to preserve transaction history."
                    });
                    return;
                }
                db.run(`DELETE FROM customer_accounts WHERE customer_id = ?`, [customerId], accountError => {
                    if (accountError) {
                        sendJSON(res, 500, { success: false, message: "Unable to remove the customer account." });
                        return;
                    }
                    db.run(`DELETE FROM customers WHERE customer_id = ?`, [customerId], function (deleteError) {
                        if (deleteError) {
                            sendJSON(res, 500, { success: false, message: "Unable to delete customer." });
                            return;
                        }
                        if (this.changes === 0) {
                            sendJSON(res, 404, { success: false, message: "Customer not found." });
                            return;
                        }
                        for (const [id, session] of sessions) {
                            if (session.role === 'customer' && Number(session.customer_id) === customerId) {
                                sessions.delete(id); sessionExpiry.delete(id); sessionTimestamps.delete(id);
                            }
                        }
                        sendJSON(res, 200, { success: true, message: "Customer deleted permanently." });
                    });
                });
            });
        });
        return;
    }

    if (req.method === "GET" && url === "/api/deliveries/tracking") {
        deliveryTracking.handle(req, res);
        return;
    }

    if (req.method === "GET" && calendarPage.ROUTES.includes(url)) {
        calendarPage.handle(req, res, url);
        return;
    }

    // Delivery batches, route order, delivery settings, and driver cash remittance.
    if (deliveryPlan.ROUTES.includes(url)) {
        deliveryPlan.handle(req, res, url);
        return;
    }

    // Activity log (admin only): who changed what, and when.
    if (req.method === "GET" && url === "/activity-log") {
        if (!requireAdmin(sessions, req, res)) return;
        return servePage("activity-log.html", res);
    }
    if (req.method === "GET" && url === "/api/activity-logs") {
        if (!requireAdmin(sessions, req, res)) return;
        const params = new URL(req.url, "http://localhost").searchParams;
        const page = Math.max(1, Math.min(10000, Number(params.get("page")) || 1));
        const pageSize = 50;
        const q = String(params.get("q") || "").trim().slice(0, 60);
        const role = String(params.get("role") || "");
        const period = String(params.get("period") || "all");
        const where = [], values = [];
        // Days in Philippine time (logs are saved in UTC).
        const day = "date(l.created_at, '+8 hours')", today = "date('now', '+8 hours')";
        if (period === "today") where.push(`${day} = ${today}`);
        if (period === "week") where.push(`${day} >= date(${today}, '-6 days')`);
        if (period === "month") where.push(`${day} >= date(${today}, 'start of month')`);
        if (["admin", "staff", "driver", "customer"].includes(role)) {
            where.push("COALESCE(l.actor_role, u.role, CASE WHEN l.description LIKE 'Customer #%' THEN 'customer' END) = ?");
            values.push(role);
        }
        if (q) {
            where.push("(l.action LIKE ? OR l.description LIKE ? OR COALESCE(l.actor_name, u.full_name, c.customer_name, '') LIKE ?)");
            values.push(`%${q}%`, `%${q}%`, `%${q}%`);
        }
        const from = `FROM activity_logs l LEFT JOIN users u ON u.user_id = l.user_id
            LEFT JOIN customers c ON c.customer_id = COALESCE(l.customer_id, CASE WHEN l.description LIKE 'Customer #%' THEN CAST(SUBSTR(l.description, 11) AS INTEGER) END)
            ${where.length ? "WHERE " + where.join(" AND ") : ""}`;
        db.get(`SELECT COUNT(*) AS total ${from}`, values, (countError, count) => {
            if (countError) return sendJSON(res, 500, { success: false, message: "Unable to load the activity log." });
            db.all(`SELECT l.log_id, l.created_at, l.action, l.details, l.route,
                           COALESCE(NULLIF(l.actor_name, ''), u.full_name, c.customer_name, 'Unknown') AS actor_name,
                           COALESCE(l.actor_role, u.role, CASE WHEN l.description LIKE 'Customer #%' THEN 'customer' END, '') AS actor_role
                    ${from} ORDER BY l.log_id DESC LIMIT ? OFFSET ?`, [...values, pageSize, (page - 1) * pageSize], (error, rows) => {
                if (error) return sendJSON(res, 500, { success: false, message: "Unable to load the activity log." });
                // Older entries saved the raw route ("PUT /api/orders/cancel"): show words instead.
                const actions = require("./utils/activityLog").ACTIONS;
                rows.forEach(row => { if (actions[row.action]) row.action = actions[row.action]; });
                sendJSON(res, 200, { success: true, page, page_size: pageSize, total: count.total, entries: rows });
            });
        });
        return;
    }

    // Database backups (admin only): status, back up now, download a copy.
    if (url === "/api/backups" || url === "/api/backups/now" || url === "/api/backups/download") {
        if (!requireAdmin(sessions, req, res)) return;
        if (req.method === "GET" && url === "/api/backups") return sendJSON(res, 200, { success: true, ...backups.status(), backups: backups.list().slice(0, 10) });
        if (req.method === "POST" && url === "/api/backups/now") {
            backups.make({ manual: true })
                .then(made => sendJSON(res, 200, { success: true, message: `Backup saved: ${made.name}`, ...backups.status() }))
                .catch(error => sendJSON(res, 500, { success: false, message: "The backup could not be made: " + error.message }));
            return;
        }
        if (req.method === "GET" && url === "/api/backups/download") {
            const name = new URL(req.url, "http://localhost").searchParams.get("name") || backups.status().latest?.name;
            const file = name && backups.file(name);
            if (!file) return sendJSON(res, 404, { success: false, message: "Backup not found." });
            res.writeHead(200, responseHeaders("application/octet-stream", { "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" }));
            fs.createReadStream(file).pipe(res);
            return;
        }
        return sendJSON(res, 405, { success: false, message: "Not allowed." });
    }

    // Station gallons lent / returned, and new gallons bought.
    if (gallons.ROUTES.includes(url)) {
        gallons.handle(req, res, url);
        return;
    }

    if ((req.method === "POST" && url === "/api/deliveries/add") || (req.method === "PUT" && url === "/api/deliveries/update")) {
        deliverySchedule(req, res);
        return;
    }

    // DELIVERY STATUS / DRIVER CONFIRMATION
    // ==========================================
    if (req.method === "PUT" && url === "/api/deliveries/status") {
        const user = requireLogin(sessions, req, res);
        if (!user) return;
        getRequestBody(req, (error, data) => {
            if (error) return sendJSON(res, 400, { success: false, message: "Invalid request." });
            const deliveryId = Number(data.delivery_id);
            const status = String(data.status || "").trim();
            const driverLatitude = Number(data.driver_latitude);
            const driverLongitude = Number(data.driver_longitude);
            if (!deliveryId) return sendJSON(res, 400, { success: false, message: "Delivery ID is required." });

            if (status === "out_for_delivery") {
                if (!['admin', 'staff', 'driver'].includes(user.role)) return sendJSON(res, 403, { success: false, message: "Only delivery staff can update delivery status." });
                // A driver can start an unassigned delivery; starting it assigns it to them.
                // One UPDATE does both, so two drivers cannot take the same delivery.
                db.run(`UPDATE delivery_schedules SET status = 'out_for_delivery', assigned_to = COALESCE(assigned_to, ?) WHERE delivery_id = ? AND status = 'scheduled' AND (? <> 'driver' OR assigned_to = ? OR assigned_to IS NULL)`, [user.user_id, deliveryId, user.role, user.user_id], function (updateError) {
                    if (updateError) return sendJSON(res, 500, { success: false, message: "Unable to update delivery status." });
                    if (this.changes === 0) return sendJSON(res, 409, { success: false, message: "This delivery was already started or taken by someone else. Refresh the list." });
                    orderEmails.send("out_for_delivery", { deliveryId });
                    sendJSON(res, 200, { success: true, message: "Delivery is now out for delivery." });
                });
                return;
            }

            if (status === "delivered") {
                if (!['admin', 'staff', 'driver'].includes(user.role)) return sendJSON(res, 403, { success: false, message: "Only delivery staff can record drop-off." });
                db.get(`
                    SELECT ds.delivery_id, ds.order_id, ds.status, ds.assigned_to, c.latitude, c.longitude, o.customer_id
                    FROM delivery_schedules ds
                    LEFT JOIN orders o ON o.order_id = ds.order_id
                    LEFT JOIN customers c ON c.customer_id = o.customer_id
                    WHERE ds.delivery_id = ?
                `, [deliveryId], (lookupError, delivery) => {
                    if (lookupError) return sendJSON(res, 500, { success: false, message: "Unable to verify delivery location." });
                    if (!delivery) return sendJSON(res, 404, { success: false, message: "Delivery not found." });
                    if (user.role === "driver" && Number(delivery.assigned_to) !== user.user_id) return sendJSON(res, 403, { success: false, message: "This delivery is assigned to another person." });
                    if (delivery.status !== "out_for_delivery") return sendJSON(res, 400, { success: false, message: "The delivery must be out for delivery first." });
                    // Optional drop-off photo, checked before anything is saved.
                    const photoBytes = data.photo ? jpegFromDataURL(data.photo) : null;
                    if (data.photo && !photoBytes) return sendJSON(res, 400, { success: false, message: "The drop-off photo could not be used. Choose a smaller JPEG, PNG, or WebP photo, or record the drop-off without one." });
                    // Optional: station gallons lent to / collected from the customer at the door.
                    const gallonCount = value => value === undefined || value === null || value === "" ? 0 : Number(value);
                    const lentAtDoor = gallonCount(data.gallons_lent), returnedAtDoor = gallonCount(data.gallons_returned);
                    if (![lentAtDoor, returnedAtDoor].every(n => Number.isInteger(n) && n >= 0 && n <= 100)) return sendJSON(res, 400, { success: false, message: "Enter the gallons lent or returned as whole numbers from 0 to 100." });
                    if ((lentAtDoor || returnedAtDoor) && !delivery.customer_id) return sendJSON(res, 400, { success: false, message: "Gallons can only be recorded for a customer's order delivery." });
                    // Records the drop-off. The note is shown in the delivery tracking history,
                    // so everyone can see whether the location was checked.
                    // Cash on delivery: the order total is recorded as collected by the driver
                    // carrying the delivery, to be remitted to the station later.
                    const cashCollected = data.cash_collected === true;
                    const recordDropOff = (note, latitude = null, longitude = null) => {
                        if (photoBytes) note += " · photo attached";
                        if (cashCollected) note += " · cash collected";
                        if (returnedAtDoor) note += ` · ${returnedAtDoor} station gallon(s) collected`;
                        if (lentAtDoor) note += ` · ${lentAtDoor} station gallon(s) lent`;
                        // A delivery without a customer order has no customer account to press
                        // "Order Received", so the drop-off finishes it.
                        db.run(`UPDATE delivery_schedules SET status = CASE WHEN order_id IS NULL THEN 'delivered' ELSE 'awaiting_customer' END, driver_delivered_at = CURRENT_TIMESTAMP, driver_latitude = COALESCE(?, driver_latitude), driver_longitude = COALESCE(?, driver_longitude), delivery_proof = ?,
                                cash_collected = CASE WHEN ? THEN (SELECT total_amount FROM orders WHERE orders.order_id = delivery_schedules.order_id) ELSE cash_collected END,
                                cash_collected_by = CASE WHEN ? THEN COALESCE(assigned_to, ?) ELSE cash_collected_by END
                                WHERE delivery_id = ? AND status = 'out_for_delivery'`, [latitude, longitude, note, cashCollected ? 1 : 0, cashCollected ? 1 : 0, user.user_id, deliveryId], function (updateError) {
                            if (updateError) return sendJSON(res, 500, { success: false, message: "Unable to record the drop-off." });
                            if (!this.changes) return sendJSON(res, 409, { success: false, message: "Delivery status changed. Refresh the list." });
                            orderEmails.send("dropped_off", { deliveryId });
                            const respond = gallonNote => sendJSON(res, 200, { success: true, message: `Drop-off recorded${photoBytes ? " with photo" : ""}.${gallonNote}${delivery.order_id ? " Waiting for the customer to mark the order as received." : " Delivery completed."}` });
                            // Returns first (they free gallons), then lending. A problem with the gallon
                            // count is reported but does not undo the drop-off.
                            const done = async () => {
                                const notes = [];
                                for (const [kind, quantity] of [["returned", returnedAtDoor], ["lent", lentAtDoor]]) {
                                    if (!quantity) continue;
                                    const problem = await gallons.record({ customerId: delivery.customer_id, kind, quantity, note: `At the drop-off (delivery #${deliveryId})`, deliveryId, userId: user.user_id }).catch(() => "Unable to save the gallon count.");
                                    notes.push(problem ? ` Gallons ${kind} were NOT recorded: ${problem}` : ` ${quantity} ${quantity === 1 ? "gallon" : "gallons"} ${kind} recorded.`);
                                }
                                respond(notes.join(""));
                            };
                            if (!photoBytes) return done();
                            db.run("INSERT OR REPLACE INTO delivery_dropoff_photos (delivery_id, photo, taken_by) VALUES (?, ?, ?)", [deliveryId, photoBytes, user.user_id], photoError => {
                                if (photoError) return sendJSON(res, 200, { success: true, message: "Drop-off recorded, but the photo could not be saved." });
                                done();
                            });
                        });
                    };
                    const who = user.full_name || user.username || "staff";
                    // Admin and staff record drop-offs on the driver's behalf from the station,
                    // so their own location is not compared with the customer's.
                    if (user.role !== "driver") return recordDropOff(`Drop-off recorded by ${who} (staff)`);
                    const customerLat = Number(delivery.latitude), customerLng = Number(delivery.longitude);
                    const hasCustomerLocation = delivery.latitude != null && delivery.longitude != null && Number.isFinite(customerLat) && Number.isFinite(customerLng);
                    const hasDriverLocation = data.driver_latitude != null && data.driver_longitude != null && Number.isFinite(driverLatitude) && Number.isFinite(driverLongitude) && Math.abs(driverLatitude) <= 90 && Math.abs(driverLongitude) <= 180;
                    const driverAt = [hasDriverLocation ? driverLatitude : null, hasDriverLocation ? driverLongitude : null];
                    if (!hasCustomerLocation) return recordDropOff(`Dropped off by ${who}`, ...driverAt);
                    // A saved customer location outside Legazpi City/Daraga is a bad reading, so it is not used.
                    if (!inServiceArea(customerLat, customerLng)) return recordDropOff(`Dropped off by ${who} (location not checked: the customer's saved location is outside Legazpi City and Daraga)`, ...driverAt);
                    // The phone could not share its location (permission denied, or the page is not
                    // on https). The drop-off is still recorded, marked as not location-checked.
                    if (!hasDriverLocation) return recordDropOff(`Dropped off by ${who} (location not checked: the phone did not share its location)`);
                    const accuracy = Number(data.driver_accuracy);
                    if (Number.isFinite(accuracy) && accuracy > LOCATION_ACCURACY_METERS) return recordDropOff(`Dropped off by ${who} (location not checked: the phone's location was only accurate to about ${Math.round(accuracy)} meters)`, ...driverAt);
                    const distance = distanceInMeters(driverLatitude, driverLongitude, customerLat, customerLng);
                    if (distance > DELIVERY_RADIUS_METERS) {
                        const away = distance >= 1000 ? `${(distance / 1000).toFixed(1)} km` : `${Math.round(distance)} meters`;
                        // The driver may still record it; it is then flagged for staff in the tracking history.
                        if (data.accept_location_mismatch === true) return recordDropOff(`Dropped off by ${who} (LOCATION DID NOT MATCH: about ${away} from the customer's saved location)`, ...driverAt);
                        return sendJSON(res, 409, { success: false, code: "LOCATION_MISMATCH", distance: Math.round(distance), message: `You are about ${away} from the customer's saved location. Move closer (within ${DELIVERY_RADIUS_METERS} meters) before confirming the drop-off.` });
                    }
                    recordDropOff(`Dropped off by ${who} (location checked: within ${Math.round(distance)} meters)`, ...driverAt);
                });
                return;
            }

            if (status === "cancelled") {
                if (!['admin', 'staff'].includes(user.role)) return sendJSON(res, 403, { success: false, message: "Only staff can cancel a delivery." });
                db.run(`UPDATE delivery_schedules SET status = 'cancelled' WHERE delivery_id = ? AND status IN ('scheduled', 'out_for_delivery')`, [deliveryId], function (updateError) {
                    if (updateError) return sendJSON(res, 500, { success: false, message: "Unable to cancel delivery." });
                    if (this.changes === 0) return sendJSON(res, 404, { success: false, message: "Delivery not found." });
                    sendJSON(res, 200, { success: true, message: "Delivery cancelled." });
                });
                return;
            }

            sendJSON(res, 400, { success: false, message: "Invalid delivery status transition." });
        });
        return;
    }

    // ==========================================
    // ORDERS PAGE
    // ==========================================

    if (
        req.method === "GET" &&
        url === "/orders"
    ) {

        const user =
            requireLogin(
                sessions,
                req,
                res
            );

        if (!user) {
            return;
        }

        servePage(
            "orders.html",
            res
        );

        return;
    }


    // ==========================================
    // GET ORDERS
    // ==========================================

    if (
        req.method === "GET" &&
        url === "/api/orders"
    ) {

        const user =
            requireLogin(
                sessions,
                req,
                res
            );

        if (!user) {
            return;
        }

        db.all(
            `
            SELECT
                orders.order_id,
                orders.customer_id,
                customers.customer_name,
                orders.order_date,
                orders.total_amount,
                orders.status,
                COALESCE(orders.fulfillment_method, 'delivery') AS fulfillment_method,

                orders.preferred_date,
                orders.approved_at,
                (SELECT full_name FROM users WHERE user_id = orders.approved_by) AS approved_by_name,

                -- The order's delivery (an active one is preferred over a cancelled one),
                -- so the Orders page shows the same state as Delivery Management.
                d.status AS delivery_status,
                d.delivery_id,
                d.delivery_date,
                d.delivery_time,
                COALESCE(NULLIF(d.delivery_address, ''), customers.address) AS delivery_address,
                u.full_name AS assigned_staff,

                -- What was ordered, e.g. "Round Gallon × 3 (with new gallon)".
                (SELECT GROUP_CONCAT(COALESCE(p.product_name, 'Product #' || oi.product_id) || ' × ' || oi.quantity
                        || CASE WHEN oi.with_new_container = 1 THEN ' (with new gallon)' ELSE '' END, ', ')
                    FROM order_items oi LEFT JOIN products p ON p.product_id = oi.product_id
                    WHERE oi.order_id = orders.order_id) AS items

            FROM orders

            LEFT JOIN customers
                ON orders.customer_id =
                   customers.customer_id

            LEFT JOIN delivery_schedules d
                ON d.delivery_id = (SELECT d2.delivery_id FROM delivery_schedules d2 WHERE d2.order_id = orders.order_id
                    ORDER BY (d2.status = 'cancelled'), d2.delivery_id DESC LIMIT 1)

            LEFT JOIN users u
                ON u.user_id = d.assigned_to

            ORDER BY
                orders.order_date DESC,
                orders.order_id DESC
            `,
            [],
            (error, rows) => {

                if (error) {

                    console.error(error);

                    sendJSON(res, 500, {
                        success: false,
                        message:
                            "Unable to load orders."
                    });

                    return;
                }

                sendJSON(
                    res,
                    200,
                    rows
                );

            }
        );

        return;
    }


    // ==========================================
    // GET ORDER ITEMS
    // ==========================================

    if (
        req.method === "GET" &&
        url.startsWith("/api/orders/items/")
    ) {

        const user =
            requireLogin(
                sessions,
                req,
                res
            );

        if (!user) {
            return;
        }

        const orderId =
            Number(
                url.split("/").pop()
            );

        if (!orderId) {

            sendJSON(res, 400, {
                success: false,
                message:
                    "Order ID is required."
            });

            return;
        }

        db.all(
            `
            SELECT
                order_items.order_item_id,
                order_items.order_id,
                order_items.product_id,
                order_items.quantity,
                order_items.unit_price,
                order_items.subtotal,
                products.product_name

            FROM order_items

            INNER JOIN products
                ON order_items.product_id =
                   products.product_id

            WHERE order_items.order_id = ?

            ORDER BY
                order_items.order_item_id ASC
            `,
            [orderId],
            (error, rows) => {

                if (error) {

                    console.error(error);

                    sendJSON(res, 500, {
                        success: false,
                        message:
                            "Unable to load order items."
                    });

                    return;
                }

                sendJSON(
                    res,
                    200,
                    rows
                );

            }
        );

        return;
    }


    // ==========================================
    // CREATE ORDER
    // ==========================================

    if (
        req.method === "POST" &&
        url === "/api/orders/add"
    ) {

        const user =
            requireLogin(
                sessions,
                req,
                res
            );

        if (!user) {
            return;
        }

        getRequestBody(req, (error, data) => {

            if (error) {

                sendJSON(res, 400, {
                    success: false,
                    message: "Invalid request."
                });

                return;
            }

            const {
                customer_id: rawCustomerId,
                items
            } = data;

            const customerId = Number(rawCustomerId);

            if (!customerId) {

                sendJSON(res, 400, {
                    success: false,
                    message:
                        "Customer is required."
                });

                return;
            }

            if (
                !Array.isArray(items) ||
                items.length === 0
            ) {

                sendJSON(res, 400, {
                    success: false,
                    message:
                        "At least one product is required."
                });

                return;
            }

            for (const item of items) {

                const productId =
                    Number(item.product_id);

                const quantity =
                    Number(item.quantity);

                if (
                    !productId ||
                    !Number.isInteger(quantity) ||
                    quantity < 1 ||
                    quantity > 100
                ) {

                    sendJSON(res, 400, {
                        success: false,
                        message:
                            "Choose a product and a whole-number quantity from 1 to 100."
                    });

                    return;
                }

            }

            db.get(
                `
                SELECT
                    customer_id,
                    customer_name

                FROM customers

                WHERE customer_id = ?

                AND status = 'active'
                `,
                [customerId],
                (error, customer) => {

                    if (error) {

                        console.error(error);

                        sendJSON(res, 500, {
                            success: false,
                            message:
                                "Unable to check customer."
                        });

                        return;
                    }

                    if (!customer) {

                        sendJSON(res, 404, {
                            success: false,
                            message:
                                "Customer not found or is archived."
                        });

                        return;
                    }

                    checkProducts(
                        customerId,
                        items,
                        res
                    );

                }
            );

        });

        return;
    }


    // ==========================================
    // CANCEL ORDER (staff/admin, or the customer for their own order)
    // ==========================================

    // Staff approve a pending order: they checked its items, schedule and address.
    if (req.method === "PUT" && url === "/api/orders/approve") {
        const user = requireStaff(sessions, req, res);
        if (!user) return;
        getRequestBody(req, (error, data) => {
            const orderId = Number(data && data.order_id);
            if (error || !Number.isSafeInteger(orderId) || orderId < 1) return sendJSON(res, 400, { success: false, message: "Choose an order to approve." });
            db.get("SELECT status, approved_at FROM orders WHERE order_id = ?", [orderId], (lookupError, order) => {
                if (lookupError) return sendJSON(res, 500, { success: false, message: "Unable to check the order." });
                if (!order) return sendJSON(res, 404, { success: false, message: "Order not found." });
                if (order.status !== "pending") return sendJSON(res, 409, { success: false, message: `This order is already ${order.status}, so it cannot be approved.` });
                if (order.approved_at) return sendJSON(res, 409, { success: false, message: "This order is already approved." });
                db.run("UPDATE orders SET approved_at = CURRENT_TIMESTAMP, approved_by = ? WHERE order_id = ? AND status = 'pending' AND approved_at IS NULL",
                    [user.user_id, orderId], function (updateError) {
                        if (updateError || !this.changes) return sendJSON(res, 409, { success: false, message: "Unable to approve the order. Refresh and try again." });
                        orderEmails.send("approved", { orderId });
                        sendJSON(res, 200, { success: true, message: "Order approved. The customer was notified." });
                    });
            });
        });
        return;
    }

    if (req.method === "PUT" && (url === "/api/orders/cancel" || url === "/api/customer/orders/cancel")) {
        const byCustomer = url === "/api/customer/orders/cancel";
        const user = byCustomer ? requireCustomer(sessions, req, res) : requireStaff(sessions, req, res);
        if (!user) return;
        getRequestBody(req, (error, data) => {
            const orderId = Number(data && data.order_id);
            if (error || !Number.isSafeInteger(orderId) || orderId < 1) return sendJSON(res, 400, { success: false, message: "Choose an order to cancel." });
            const reason = String(data.reason || "").trim().slice(0, 200);
            cancelOrder(orderId, { customerId: byCustomer ? user.customer_id : null, reason, user }, res);
        });
        return;
    }


    // ==========================================
    // COMPLETE ORDER
    // ==========================================

    if (
        req.method === "PUT" &&
        url === "/api/orders/complete"
    ) {

        const user =
            requireStaff(
                sessions,
                req,
                res
            );

        if (!user) {
            return;
        }

        getRequestBody(req, (error, data) => {

            if (error) {

                sendJSON(res, 400, {
                    success: false,
                    message: "Invalid request."
                });

                return;
            }

            const orderId =
                Number(data.order_id);

            if (!orderId) {

                sendJSON(res, 400, {
                    success: false,
                    message:
                        "Order ID is required."
                });

                return;
            }

            // Staff complete a pickup at the counter. A delivery order can only be completed
            // by staff after the driver dropped it off (e.g. the customer confirmed by phone);
            // completing it earlier left its delivery scheduled, so it could still be sent out.
            db.get(`SELECT COALESCE(o.fulfillment_method, 'delivery') AS fulfillment_method,
                           (SELECT d.delivery_id FROM delivery_schedules d WHERE d.order_id = o.order_id AND d.status <> 'cancelled' ORDER BY d.delivery_id DESC LIMIT 1) AS delivery_id,
                           (SELECT d.status FROM delivery_schedules d WHERE d.order_id = o.order_id AND d.status <> 'cancelled' ORDER BY d.delivery_id DESC LIMIT 1) AS delivery_status
                    FROM orders o WHERE o.order_id = ?`, [orderId], (lookupError, order) => {
                if (lookupError) return sendJSON(res, 500, { success: false, message: "Unable to check the order." });
                if (!order || order.fulfillment_method === "pickup") return completeOrder(orderId, user, res);
                if (!["awaiting_customer", "delivered"].includes(order.delivery_status)) {
                    return sendJSON(res, 409, { success: false, message: "This delivery order has not been dropped off yet. It is completed when the customer confirms receipt after the drop-off." });
                }
                db.run(`UPDATE delivery_schedules SET status = 'delivered', customer_received_at = COALESCE(customer_received_at, CURRENT_TIMESTAMP)
                        WHERE delivery_id = ? AND status IN ('awaiting_customer', 'delivered')`, [order.delivery_id], updateError => {
                    if (updateError) return sendJSON(res, 500, { success: false, message: "Unable to confirm the delivery." });
                    completeOrder(orderId, user, res);
                });
            });

        });

        return;
    }


    // ==========================================
    // REPORTS PAGE
    // ==========================================

    if (
        req.method === "GET" &&
        url === "/reports"
    ) {

        const user =
            requireLogin(
                sessions,
                req,
                res
            );

        if (!user) {
            return;
        }

        servePage(
            "reports.html",
            res
        );

        return;
    }


    // ==========================================
    // USERS PAGE
    // ==========================================

    if (
        req.method === "GET" &&
        (url === "/users" || url === "/staff-accounts")
    ) {

        const user =
            requireAdmin(
                sessions,
                req,
                res
            );

        if (!user) {
            return;
        }

        servePage(
            "users.html",
            res
        );

        return;
    }




    // ==========================================
    // REPORT GENERATION - SELECT REPORT TYPE (5.1)
    // ==========================================

    if (
        req.method === "GET" &&
        url === "/api/reports/types"
    ) {

        const user =
            requireLogin(
                sessions,
                req,
                res
            );

        if (!user) {
            return;
        }

        const reportTypes = [
            { id: 1, name: "Inventory Report", description: "Stock levels and availability" },
            { id: 2, name: "Customer Report", description: "Customer information and activity" },
            { id: 3, name: "Delivery Schedule Report", description: "Scheduled deliveries and status" },
            { id: 4, name: "Order Report", description: "All orders and their details" },
            { id: 5, name: "Activity Log Report", description: "System activity and user actions" }
        ];

        sendJSON(res, 200, {
            success: true,
            report_types: reportTypes
        });

        return;
    }


    // ==========================================
    // FETCH REPORT DATA (5.2)
    // ==========================================

    if (
        req.method === "POST" &&
        url === "/api/reports/fetch-data"
    ) {

        const user =
            requireLogin(
                sessions,
                req,
                res
            );

        if (!user) {
            return;
        }

        getRequestBody(req, (error, data) => {

            if (error) {

                sendJSON(res, 400, {
                    success: false,
                    message: "Invalid request."
                });

                return;
            }

            const reportType = String(data.report_type || "").trim();

            if (!reportType) {

                sendJSON(res, 400, {
                    success: false,
                    message: "Report type is required."
                });

                return;
            }

            let reportData = {};

            // Inventory Report
            if (reportType === "1" || reportType === "inventory") {

                db.all(
                    `
                    SELECT
                        products.product_id,
                        products.product_name,
                        products.category,
                        products.unit,
                        products.price,
                        COALESCE(inventory.quantity, 0) AS quantity,
                        COALESCE(inventory.minimum_stock, 0) AS minimum_stock,
                        CASE
                            WHEN COALESCE(inventory.quantity, 0) <= COALESCE(inventory.minimum_stock, 0)
                            THEN 'Low Stock'
                            ELSE 'Available'
                        END AS stock_status

                    FROM products
                    LEFT JOIN inventory ON products.product_id = inventory.product_id
                    WHERE products.status NOT IN ('removed', 'deleted')
                    ORDER BY products.product_name ASC
                    `,
                    [],
                    (error, rows) => {

                        if (error) {

                            sendJSON(res, 500, {
                                success: false,
                                message: "Unable to fetch inventory data."
                            });

                            return;
                        }

                        sendJSON(res, 200, {
                            success: true,
                            report_type: "Inventory Report",
                            data: rows,
                            generated_at: new Date().toISOString()
                        });

                    }
                );

            }

            // Customer Report
            else if (reportType === "2" || reportType === "customer") {

                db.all(
                    `
                    SELECT
                        customer_id,
                        customer_name,
                        contact_number,
                        address,
                        customer_type,
                        status,
                        created_at

                    FROM customers
                    WHERE status = 'active'
                    ORDER BY customer_name ASC
                    `,
                    [],
                    (error, rows) => {

                        if (error) {

                            sendJSON(res, 500, {
                                success: false,
                                message: "Unable to fetch customer data."
                            });

                            return;
                        }

                        sendJSON(res, 200, {
                            success: true,
                            report_type: "Customer Report",
                            data: rows,
                            generated_at: new Date().toISOString()
                        });

                    }
                );

            }

            // Delivery Schedule Report
            else if (reportType === "3" || reportType === "delivery") {

                db.all(
                    `
                    SELECT
                        ds.delivery_id,
                        o.order_id,
                        COALESCE(NULLIF(d.customer_name, ''), c.customer_name) AS customer_name,
                        COALESCE(NULLIF(d.contact_number, ''), c.contact_number) AS contact_number,
                        d.delivery_reason,
                        d.delivery_items,
                        ds.delivery_date,
                        ds.delivery_time,
                        ds.delivery_address,
                        ds.status,
                        u.full_name as assigned_to

                    FROM delivery_schedules ds
                    JOIN orders o ON ds.order_id = o.order_id
                    JOIN customers c ON o.customer_id = c.customer_id
                    LEFT JOIN users u ON ds.assigned_to = u.user_id
                    ORDER BY ds.delivery_date ASC
                    `,
                    [],
                    (error, rows) => {

                        if (error) {

                            sendJSON(res, 500, {
                                success: false,
                                message: "Unable to fetch delivery data."
                            });

                            return;
                        }

                        sendJSON(res, 200, {
                            success: true,
                            report_type: "Delivery Schedule Report",
                            data: rows,
                            generated_at: new Date().toISOString()
                        });

                    }
                );

            }

            // Order Report
            else if (reportType === "4" || reportType === "order") {

                db.all(
                    `
                    SELECT
                        o.order_id,
                        c.customer_name,
                        c.contact_number,
                        o.order_date,
                        o.total_amount,
                        o.status,
                        (SELECT COUNT(*) FROM order_items WHERE order_id = o.order_id) as item_count

                    FROM orders o
                    JOIN customers c ON o.customer_id = c.customer_id
                    ORDER BY o.order_date DESC
                    `,
                    [],
                    (error, rows) => {

                        if (error) {

                            sendJSON(res, 500, {
                                success: false,
                                message: "Unable to fetch order data."
                            });

                            return;
                        }

                        sendJSON(res, 200, {
                            success: true,
                            report_type: "Order Report",
                            data: rows,
                            generated_at: new Date().toISOString()
                        });

                    }
                );

            }

            // Activity Log Report
            else if (reportType === "5" || reportType === "activity") {

                db.all(
                    `
                    SELECT
                        al.log_id,
                        al.action,
                        al.description,
                        u.username,
                        al.created_at

                    FROM activity_logs al
                    LEFT JOIN users u ON al.user_id = u.user_id
                    ORDER BY al.created_at DESC
                    LIMIT 500
                    `,
                    [],
                    (error, rows) => {

                        if (error) {

                            sendJSON(res, 500, {
                                success: false,
                                message: "Unable to fetch activity data."
                            });

                            return;
                        }

                        sendJSON(res, 200, {
                            success: true,
                            report_type: "Activity Log Report",
                            data: rows,
                            generated_at: new Date().toISOString()
                        });

                    }
                );

            }

            else {

                sendJSON(res, 400, {
                    success: false,
                    message: "Unknown report type."
                });

                return;
            }

        });

        return;
    }


    // ==========================================
    // GENERATE & SAVE REPORT (5.3)
    // ==========================================

    if (
        req.method === "POST" &&
        url === "/api/reports/generate"
    ) {

        const user =
            requireLogin(
                sessions,
                req,
                res
            );

        if (!user) {
            return;
        }

        getRequestBody(req, (error, data) => {

            if (error) {

                sendJSON(res, 400, {
                    success: false,
                    message: "Invalid request."
                });

                return;
            }

            const reportType = String(data.report_type || "").trim();
            const reportName = String(data.report_name || `Report_${Date.now()}`).trim();
            const reportData = JSON.stringify(data.report_data || {});

            if (!reportType) {

                sendJSON(res, 400, {
                    success: false,
                    message: "Report type is required."
                });

                return;
            }

            db.run(
                `
                INSERT INTO reports
                (report_type, report_name, report_data, created_by)
                VALUES (?, ?, ?, ?)
                `,
                [reportType, reportName, reportData, user.user_id],
                function (error) {

                    if (error) {

                        console.error("Generate report error:", error);

                        sendJSON(res, 500, {
                            success: false,
                            message: "Unable to generate report."
                        });

                        return;
                    }

                    sendJSON(res, 200, {
                        success: true,
                        message: "Report generated successfully.",
                        report_id: this.lastID
                    });

                }
            );

        });

        return;
    }


    // ==========================================
    // GET SAVED REPORTS & EXPORT (5.4)
    // ==========================================

    if (
        req.method === "GET" &&
        url === "/api/reports/list"
    ) {

        const user =
            requireLogin(
                sessions,
                req,
                res
            );

        if (!user) {
            return;
        }

        db.all(
            `
            SELECT
                r.report_id,
                r.report_type,
                r.report_name,
                u.full_name as created_by,
                r.created_at

            FROM reports r
            LEFT JOIN users u ON r.created_by = u.user_id
            ORDER BY r.created_at DESC
            `,
            [],
            (error, rows) => {

                if (error) {

                    console.error("List reports error:", error);

                    sendJSON(res, 500, {
                        success: false,
                        message: "Unable to fetch reports."
                    });

                    return;
                }

                sendJSON(res, 200, {
                    success: true,
                    reports: rows
                });

            }
        );

        return;
    }


    // ==========================================
    // DOWNLOAD REPORT AS CSV
    // ==========================================

    if (
        req.method === "GET" &&
        url.startsWith("/api/reports/download/")
    ) {

        const user =
            requireLogin(
                sessions,
                req,
                res
            );

        if (!user) {
            return;
        }

        const reportId = parseInt(url.split("/").pop());

        if (!reportId) {

            sendJSON(res, 400, {
                success: false,
                message: "Report ID is required."
            });

            return;
        }

        db.get(
            `SELECT * FROM reports WHERE report_id = ?`,
            [reportId],
            (error, report) => {

                if (error) {

                    sendJSON(res, 500, {
                        success: false,
                        message: "Unable to fetch report."
                    });

                    return;
                }

                if (!report) {

                    sendJSON(res, 404, {
                        success: false,
                        message: "Report not found."
                    });

                    return;
                }

                try {

                    const data = JSON.parse(report.report_data);
                    const filename = `${report.report_name}_${Date.now()}.json`;

                    res.writeHead(200, {
                        "Content-Type": "application/json",
                        "Content-Disposition": `attachment; filename="${filename}"`
                    });

                    res.end(JSON.stringify(data, null, 2));

                } catch (error) {

                    sendJSON(res, 500, {
                        success: false,
                        message: "Error processing report."
                    });

                }

            }
        );

        return;
    }


    // ==========================================
    // USER MANAGEMENT - GET ALL USERS (ADMIN ONLY)
    // ==========================================

    if (
        req.method === "GET" &&
        url === "/api/users"
    ) {

        const user =
            requireAdmin(
                sessions,
                req,
                res
            );

        if (!user) {
            return;
        }

        db.all(
            `
            SELECT
                u.user_id,
                u.username,
                u.full_name,
                u.contact_number,
                COALESCE(v.destination, '') AS email,
                u.role,
                u.status,
                u.created_at

            FROM users u
            LEFT JOIN verified_contacts v ON v.account_type = 'user' AND v.account_id = u.user_id AND v.channel = 'email'
            ORDER BY u.created_at DESC
            `,
            [],
            (error, rows) => {

                if (error) {

                    console.error("Get users error:", error);

                    sendJSON(res, 500, {
                        success: false,
                        message: "Unable to fetch users."
                    });

                    return;
                }

                sendJSON(res, 200, {
                    success: true,
                    users: rows
                });

            }
        );

        return;
    }


    // ==========================================
    // USER MANAGEMENT - CREATE USER (ADMIN ONLY)
    // ==========================================

    if (
        req.method === "POST" &&
        url === "/api/users/create"
    ) {

        const user =
            requireAdmin(
                sessions,
                req,
                res
            );

        if (!user) {
            return;
        }

        getRequestBody(req, (error, data) => {

            if (error) {

                sendJSON(res, 400, {
                    success: false,
                    message: "Invalid request."
                });

                return;
            }

            const username = String(data.username || "").trim();
            const password = String(data.password || "");
            const confirmPassword = String(data.confirm_password || "");
            const fullName = String(data.full_name || "").trim();
            const contactNumber = String(data.contact_number || "").trim();
            const role = String(data.role || "staff").trim();
            const emailProblem = staffEmailProblem(data.email);
            if (emailProblem) return sendJSON(res, 400, { success: false, message: emailProblem });

            if (!username || !password || !fullName || !/^09\d{9}$/.test(contactNumber)) {

                sendJSON(res, 400, {
                    success: false,
                    message: "Username, password, full name, and a mobile number (+63 followed by 10 digits) are required."
                });

                return;
            }

            if (!validateStrongPassword(password)) {
                sendJSON(res, 400, {
                    success: false,
                    message: "Password must be at least 8 characters and include uppercase, lowercase, number, and special character."
                });
                return;
            }

            if (password !== confirmPassword) {
                sendJSON(res, 400, {
                    success: false,
                    message: "Passwords do not match."
                });
                return;
            }

            if (!["admin", "staff", "driver"].includes(role)) {

                sendJSON(res, 400, {
                    success: false,
                    message: "Invalid role. Must be 'admin', 'staff', or 'driver'."
                });

                return;
            }

            const bcrypt = require("bcrypt");

            bcrypt.hash(password, 10, (error, hashedPassword) => {

                if (error) {

                    sendJSON(res, 500, {
                        success: false,
                        message: "Error processing password."
                    });

                    return;
                }

                db.run(
                    `
                    INSERT INTO users
                    (username, password, full_name, contact_number, role, status)
                    SELECT ?, ?, ?, ?, ?, 'active'
                    WHERE NOT EXISTS (SELECT 1 FROM customer_accounts WHERE username = ?)
                    `,
                    [username, hashedPassword, fullName, contactNumber, role, username],
                    function (error) {

                        if (error) {

                            if (error.message.includes("UNIQUE")) {

                                sendJSON(res, 400, {
                                    success: false,
                                    message: "Username already exists."
                                });

                            } else {

                                console.error("Create user error:", error);

                                sendJSON(res, 500, {
                                    success: false,
                                    message: "Unable to create user."
                                });

                            }

                            return;
                        }

                        if (this.changes === 0) return sendJSON(res, 409, { success: false, message: "That username is already used by a customer account." });
                        const newUserId = this.lastID;
                        saveStaffEmail(newUserId, data.email)
                            .then(() => sendJSON(res, 200, { success: true, message: "User created successfully.", user_id: newUserId }))
                            .catch(emailError => sendJSON(res, emailError.status || 500, { success: false, user_id: newUserId,
                                message: emailError.status ? `User created, but the email was not saved: ${emailError.message}` : "User created, but the email could not be saved." }));

                    }
                );

            });

        });

        return;
    }


    // ==========================================
    // USER MANAGEMENT - UPDATE USER (ADMIN ONLY)
    // ==========================================

    if (
        req.method === "PUT" &&
        url === "/api/users/update"
    ) {

        const user =
            requireAdmin(
                sessions,
                req,
                res
            );

        if (!user) {
            return;
        }

        getRequestBody(req, (error, data) => {

            if (error) {

                sendJSON(res, 400, {
                    success: false,
                    message: "Invalid request."
                });

                return;
            }

            const userId = Number(data.user_id);
            const requestedUsername = String(data.username || "").trim();
            const newPassword = String(data.password || "");
            const fullName = String(data.full_name || "").trim();
            const contactNumber = String(data.contact_number || "").trim();
            const role = String(data.role || "staff").trim();
            const status = String(data.status || "active").trim() === "inactive" ? "not active" : String(data.status || "active").trim();
            const editingSelf = userId === Number(user.user_id);

            if (!/^09\d{9}$/.test(contactNumber)) {
                return sendJSON(res, 400, { success: false, message: "Enter the mobile number as +63 followed by 10 digits, starting with 9 (for example +63 9171234567)." });
            }
            const emailProblem = staffEmailProblem(data.email);
            if (emailProblem) return sendJSON(res, 400, { success: false, message: emailProblem });
            // A blank username keeps the current one.
            if (requestedUsername && !/^[A-Za-z0-9_.-]{3,32}$/.test(requestedUsername)) {
                return sendJSON(res, 400, { success: false, message: "Username must be 3–32 letters, numbers, dots, underscores, or hyphens (no spaces)." });
            }
            if (newPassword && !validateStrongPassword(newPassword)) {
                return sendJSON(res, 400, { success: false, message: "New password must be at least 8 characters and include uppercase, lowercase, number, and special character." });
            }
            if (!userId || !fullName || !["admin", "staff", "driver"].includes(role) || !["active", "not active"].includes(status)) {
                return sendJSON(res, 400, { success: false, message: "User, full name, role, and account status are required and must be valid." });
            }
            // An admin cannot lock themselves out by demoting or deactivating their own account.
            if (editingSelf && (role !== "admin" || status !== "active")) {
                return sendJSON(res, 400, { success: false, message: "You cannot remove your own admin role or deactivate your own account. Ask another admin to do it." });
            }

            (async () => {
                try {
                    const existing = await dbGet("SELECT user_id, username, role, status FROM users WHERE user_id = ?", [userId]);
                    if (!existing) return sendJSON(res, 404, { success: false, message: "User not found." });
                    const username = requestedUsername || existing.username;
                    // Keep at least one active admin so the system is never left without one.
                    if (existing.role === "admin" && existing.status === "active" && (role !== "admin" || status !== "active")) {
                        const admins = await dbGet("SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND status = 'active' AND user_id <> ?", [userId]);
                        if (!admins.total) return sendJSON(res, 400, { success: false, message: "This is the only active admin. Create or activate another admin first." });
                    }
                    // Usernames must be unique across staff and customer logins.
                    const duplicate = await dbGet("SELECT 1 FROM users WHERE username = ? AND user_id <> ? UNION SELECT 1 FROM customer_accounts WHERE username = ?", [username, userId, username]);
                    if (duplicate) return sendJSON(res, 409, { success: false, message: "That username is already in use. Choose another one." });

                    const hash = newPassword ? await bcrypt.hash(newPassword, 12) : null;
                    // Email first: a taken email stops the update before anything changes.
                    if (data.email !== undefined) await saveStaffEmail(userId, data.email);
                    await dbRun(`UPDATE users SET username = ?, full_name = ?, contact_number = ?, role = ?, status = ?, password = COALESCE(?, password) WHERE user_id = ?`,
                        [username, fullName, contactNumber, role, status, hash, userId]);

                    if (editingSelf) {
                        // Keep the admin signed in; just refresh the saved name and username.
                        for (const session of sessions.values()) {
                            if (session.role !== "customer" && Number(session.user_id) === userId) Object.assign(session, { username, full_name: fullName });
                        }
                    } else {
                        for (const [sessionId, session] of sessions) {
                            if (session.role !== "customer" && Number(session.user_id) === userId) {
                                sessions.delete(sessionId);
                                sessionExpiry.delete(sessionId);
                                sessionTimestamps.delete(sessionId);
                            }
                        }
                    }
                    sendJSON(res, 200, {
                        success: true,
                        message: editingSelf
                            ? "Your account was updated." + (username !== existing.username ? ` Sign in next time as "${username}".` : "")
                            : "User updated successfully. The user must sign in again" + (username !== existing.username ? ` as "${username}".` : ".")
                    });
                } catch (updateError) {
                    if (updateError.status) return sendJSON(res, updateError.status, { success: false, message: updateError.message });
                    console.error("Update user error:", updateError);
                    const taken = updateError.code === "SQLITE_CONSTRAINT";
                    sendJSON(res, taken ? 409 : 500, { success: false, message: taken ? "That username is already in use. Choose another one." : "Unable to update user." });
                }
            })();

        });

        return;
    }


    // ==========================================
    // USER MANAGEMENT - CHANGE PASSWORD (USER CAN CHANGE OWN)
    // ==========================================

    if (
        req.method === "POST" &&
        url === "/api/users/change-password"
    ) {

        const user =
            requireLogin(
                sessions,
                req,
                res
            );

        if (!user) {
            return;
        }

        getRequestBody(req, (error, data) => {

            if (error) {

                sendJSON(res, 400, {
                    success: false,
                    message: "Invalid request."
                });

                return;
            }

            const currentPassword = String(data.current_password || "");
            const newPassword = String(data.new_password || "").trim();

            if (!currentPassword || !newPassword) {

                sendJSON(res, 400, {
                    success: false,
                    message: "Current and new passwords are required."
                });

                return;
            }

            if (!validateStrongPassword(newPassword)) {
                sendJSON(res, 400, { success: false, message: PASSWORD_RULE });
                return;
            }

            const bcrypt = require("bcrypt");

            db.get(
                `SELECT * FROM users WHERE user_id = ?`,
                [user.user_id],
                (error, dbUser) => {

                    if (error || !dbUser) {

                        sendJSON(res, 500, {
                            success: false,
                            message: "Error verifying user."
                        });

                        return;
                    }

                    bcrypt.compare(
                        currentPassword,
                        dbUser.password,
                        (error, isMatch) => {

                            if (error || !isMatch) {

                                sendJSON(res, 401, {
                                    success: false,
                                    message: "Current password is incorrect."
                                });

                                return;
                            }

                            bcrypt.hash(newPassword, 10, (error, hashedPassword) => {

                                if (error) {

                                    sendJSON(res, 500, {
                                        success: false,
                                        message: "Error processing password."
                                    });

                                    return;
                                }

                                db.run(
                                    `UPDATE users SET password = ? WHERE user_id = ?`,
                                    [hashedPassword, user.user_id],
                                    (error) => {

                                        if (error) {

                                            sendJSON(res, 500, {
                                                success: false,
                                                message: "Unable to change password."
                                            });

                                            return;
                                        }

                                        sendJSON(res, 200, {
                                            success: true,
                                            message: "Password changed successfully."
                                        });

                                    }
                                );

                            });

                        }
                    );

                }
            );

        });

        return;
    }


    // ==========================================
    // LOGOUT
    // ==========================================

    if (
        req.method === "POST" &&
        url === "/logout"
    ) {

        const sessionId =
            getSessionId(req);

        if (sessionId) {

            sessions.delete(
                sessionId
            );

        }

        res.writeHead(
            200,
            {
                "Content-Type":
                    "application/json",

                "Cache-Control":
                    "no-cache",

                "Set-Cookie":
                    "sessionId=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0"
            }
        );

        res.end(
            JSON.stringify({
                success: true,
                message:
                    "Logged out successfully."
            })
        );

        return;
    }


    // ==========================================
    // STATIC FILES
    // ==========================================

    if (req.method === "GET" && url === "/service-worker.js") {
        servePublicFile(url, "text/javascript", res);
        return;
    }

    if (req.method === "GET" && url === "/manifest.webmanifest") {
        servePublicFile(url, "application/manifest+json", res);
        return;
    }

    if (req.method === "GET" && url === "/offline.html") {
        servePublicFile(url, "text/html", res);
        return;
    }

    if (
        req.method === "GET" &&
        url.startsWith("/css/")
    ) {

        servePublicFile(
            url,
            "text/css",
            res
        );

        return;
    }


    if (
        req.method === "GET" &&
        url.startsWith("/js/")
    ) {

        servePublicFile(
            url,
            "text/javascript",
            res
        );

        return;
    }


    if (
        req.method === "GET" &&
        url.startsWith("/images/")
    ) {

        const extension =
            path.extname(url)
                .toLowerCase();

        const imageTypes = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".webp": "image/webp",
            ".svg": "image/svg+xml",
            ".ico": "image/x-icon"
        };

        servePublicFile(
            url,
            imageTypes[extension] ||
                "application/octet-stream",
            res
        );

        return;
    }

    // Browsers ask for /favicon.ico on their own; answer with the OLV icon.
    if (req.method === "GET" && url === "/favicon.ico") {
        servePublicFile("/images/icon-32.png", "image/png", res);
        return;
    }

    // Bootstrap and its icons, kept in the project (public/vendor) so pages work even
    // when the station's internet is slow or down; they used to come from a CDN.
    if (req.method === "GET" && url.startsWith("/vendor/")) {
        const vendorTypes = { ".css": "text/css", ".js": "text/javascript", ".woff2": "font/woff2", ".woff": "font/woff", ".map": "application/json" };
        const type = vendorTypes[path.extname(url).toLowerCase()];
        if (!type) return sendText(res, 404, "404 - Page Not Found");
        servePublicFile(url, type, res);
        return;
    }

    // ==========================================
    // 404
    // ==========================================

    sendText(
        res,
        404,
        "404 - Page Not Found"
    );

};

// HTTPS is opt-in for local development and deployment. Set HTTPS_KEY and
// HTTPS_CERT to PEM file paths; otherwise the familiar local HTTP server is
// used. This keeps the capstone easy to run while supporting TLS when a
// certificate is available.
const httpsKeyPath = process.env.HTTPS_KEY;
const httpsCertPath = process.env.HTTPS_CERT;
const server = httpsKeyPath && httpsCertPath && fs.existsSync(httpsKeyPath) && fs.existsSync(httpsCertPath)
    ? https.createServer({ key: fs.readFileSync(httpsKeyPath), cert: fs.readFileSync(httpsCertPath) }, requestHandler)
    : http.createServer(requestHandler);


// ==========================================
// DELIVERY DISTANCE HELPER
// ==========================================
function distanceInMeters(lat1, lon1, lat2, lon2) {
    const earthRadius = 6371000;
    const toRadians = value => value * Math.PI / 180;
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
        Math.sin(dLon / 2) ** 2;
    return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ==========================================
// DASHBOARD DATA
// ==========================================

function loadDashboardData(res) {

    const totalInventorySQL = `
        SELECT
            COALESCE(SUM(quantity), 0)
            AS total_inventory
        FROM inventory
    `;

    // Active products only, the same ones shown in Current Inventory Levels.
    const lowStockSQL = `
        SELECT
            COUNT(*) AS low_stock_count
        FROM inventory i
        JOIN products p ON p.product_id = i.product_id
        WHERE p.status = 'active' AND i.quantity <= i.minimum_stock
    `;

    const activeProductsSQL = `
        SELECT
            COUNT(*) AS active_products
        FROM products
        WHERE status = 'active'
    `;

    const totalCustomersSQL = `
        SELECT
            COUNT(*) AS total_customers
        FROM customers
        WHERE status = 'active'
    `;

    const pendingOrdersSQL = `
        SELECT
            COUNT(*) AS pending_orders
        FROM orders
    `;

    const scheduledDeliveriesSQL = `
        SELECT
            COUNT(*) AS scheduled_deliveries
        FROM delivery_schedules
        WHERE status = 'scheduled'
    `;

    const inventoryLevelsSQL = `
        SELECT
            products.product_id,
            products.product_name,
            products.unit,
            inventory.quantity,
            inventory.minimum_stock,

            CASE
                WHEN inventory.quantity <=
                     inventory.minimum_stock
                THEN 'low-stock'
                ELSE 'available'
            END AS stock_status

        FROM products

        INNER JOIN inventory
            ON products.product_id =
               inventory.product_id

        WHERE products.status = 'active'

        ORDER BY inventory.quantity DESC

        LIMIT 10
    `;

    const lowStockProductsSQL = `
        SELECT
            products.product_id,
            products.product_name,
            products.unit,
            inventory.quantity,
            inventory.minimum_stock

        FROM products

        INNER JOIN inventory
            ON products.product_id =
               inventory.product_id

        WHERE products.status = 'active'

        AND inventory.quantity <=
            inventory.minimum_stock

        ORDER BY inventory.quantity ASC
    `;

    db.get(
        totalInventorySQL,
        [],
        (error, totalInventory) => {

            if (error) {
                dashboardError(
                    res,
                    error,
                    "Unable to load total inventory."
                );
                return;
            }

            db.get(
                lowStockSQL,
                [],
                (error, lowStock) => {

                    if (error) {
                        dashboardError(
                            res,
                            error,
                            "Unable to load low stock data."
                        );
                        return;
                    }

                    db.get(
                        activeProductsSQL,
                        [],
                        (error, activeProducts) => {

                            if (error) {
                                dashboardError(
                                    res,
                                    error,
                                    "Unable to load product count."
                                );
                                return;
                            }

                            db.get(
                                totalCustomersSQL,
                                [],
                                (error, totalCustomers) => {

                                    if (error) {
                                        dashboardError(
                                            res,
                                            error,
                                            "Unable to load customers."
                                        );
                                        return;
                                    }

                                    db.get(
                                        pendingOrdersSQL,
                                        [],
                                        (error, pendingOrders) => {

                                            if (error) {
                                                dashboardError(
                                                    res,
                                                    error,
                                                    "Unable to load orders."
                                                );
                                                return;
                                            }

                                            db.get(
                                                scheduledDeliveriesSQL,
                                                [],
                                                (
                                                    error,
                                                    scheduledDeliveries
                                                ) => {

                                                    if (error) {
                                                        dashboardError(
                                                            res,
                                                            error,
                                                            "Unable to load delivery schedules."
                                                        );
                                                        return;
                                                    }

                                                    db.all(
                                                        inventoryLevelsSQL,
                                                        [],
                                                        (
                                                            error,
                                                            inventoryLevels
                                                        ) => {

                                                            if (error) {
                                                                dashboardError(
                                                                    res,
                                                                    error,
                                                                    "Unable to load inventory levels."
                                                                );
                                                                return;
                                                            }

                                                            db.all(
                                                                lowStockProductsSQL,
                                                                [],
                                                                (
                                                                    error,
                                                                    lowStockProducts
                                                                ) => {

                                                                    if (error) {
                                                                        dashboardError(
                                                                            res,
                                                                            error,
                                                                            "Unable to load low stock products."
                                                                        );
                                                                        return;
                                                                    }

                                                                    sendJSON(
                                                                        res,
                                                                        200,
                                                                        {
                                                                            success: true,

                                                                            summary: {
                                                                                total_inventory:
                                                                                    totalInventory.total_inventory,

                                                                                low_stock_count:
                                                                                    lowStock.low_stock_count,

                                                                                active_products:
                                                                                    activeProducts.active_products,

                                                                                total_customers:
                                                                                    totalCustomers.total_customers,

                                                                                pending_orders:
                                                                                    pendingOrders.pending_orders,

                                                                                scheduled_deliveries:
                                                                                    scheduledDeliveries.scheduled_deliveries
                                                                            },

                                                                            inventory_levels:
                                                                                inventoryLevels,

                                                                            low_stock_products:
                                                                                lowStockProducts
                                                                        }
                                                                    );

                                                                }
                                                            );

                                                        }
                                                    );

                                                }
                                            );

                                        }
                                    );

                                }
                            );

                        }
                    );

                }
            );

        }
    );

}


// ==========================================
// DASHBOARD ERROR
// ==========================================

function dashboardError(
    res,
    error,
    message
) {

    console.error(
        "Dashboard error:",
        error
    );

    sendJSON(res, 500, {
        success: false,
        message: message
    });

}


// ==========================================
// CHECK PRODUCTS FOR NEW ORDER
// ==========================================
function checkProducts(customerId, items, res, fulfillmentMethod = "delivery", preferredDate = null) {
    let completed = 0;
    let hasError = false;
    let productTotal = 0;
    const orderItems = [];

    items.forEach(item => {
        const productId = Number(item.product_id);
        const quantity = Number(item.quantity);
        const withNewContainer = item.with_new_container === true;
        db.get(`
            SELECT p.product_id, p.product_name, p.price, COALESCE(p.new_container_price, 0) AS new_container_price,
                   COALESCE(i.quantity, 0) AS stock_quantity
            FROM products p
            LEFT JOIN inventory i ON i.product_id = p.product_id
            WHERE p.product_id = ? AND p.status = 'active'
        `, [productId], (error, product) => {
            if (hasError) return;
            if (error) {
                hasError = true;
                return sendJSON(res, 500, { success: false, message: "Unable to check product stock." });
            }
            if (!product) {
                hasError = true;
                return sendJSON(res, 404, { success: false, message: "One of the selected products was not found or is archived." });
            }
            const availableStock = Number(product.stock_quantity) || 0;
            if (availableStock < quantity) {
                hasError = true;
                return sendJSON(res, 400, { success: false, message: `Insufficient stock for ${product.product_name}. Available: ${availableStock}, Requested: ${quantity}.` });
            }
            // Refill price, plus the gallon's price when the customer needs a new gallon.
            // The price always comes from the product, never from the request.
            const containerPrice = Number(product.new_container_price) || 0;
            if (withNewContainer && containerPrice <= 0) {
                hasError = true;
                return sendJSON(res, 400, { success: false, message: `${product.product_name} is sold as a refill only. Choose "Refill" instead.` });
            }
            const unitPrice = Number(product.price) + (withNewContainer ? containerPrice : 0);
            const subtotal = unitPrice * quantity;
            productTotal += subtotal;
            orderItems.push({
                product_id: product.product_id,
                product_name: product.product_name,
                quantity,
                unit_price: unitPrice,
                subtotal,
                with_new_container: withNewContainer
            });
            completed++;
            if (completed === items.length && !hasError) {
                const serviceFee = fulfillmentMethod === "delivery" ? DELIVERY_SERVICE_FEE : 0;
                const totalAmount = productTotal + serviceFee;
                createOrder(customerId, totalAmount, orderItems, res, serviceFee, fulfillmentMethod, preferredDate);
            }
        });
    });
}

// ==========================================
// CREATE ORDER
// WITH TRANSACTION
// ==========================================

function createOrder(
    customerId,
    totalAmount,
    orderItems,
    res,
    serviceFee = DELIVERY_SERVICE_FEE,
    fulfillmentMethod = "delivery",
    preferredDate = null
) {

    txDb.run(
        "BEGIN TRANSACTION",
        [],
        error => {

            if (error) {

                console.error(error);

                sendJSON(res, 500, {
                    success: false,
                    message:
                        "Unable to begin order creation."
                });

                return;
            }

            // Stock still free = on hand minus what pending orders were already promised.
            // Checked here, inside the transaction, so two orders placed at the same moment
            // cannot both be promised the last gallons.
            const wanted = new Map();
            orderItems.forEach(item => wanted.set(item.product_id, (wanted.get(item.product_id) || 0) + item.quantity));
            const ids = [...wanted.keys()];
            txDb.all(`
                SELECT p.product_id, p.product_name,
                       COALESCE(i.quantity, 0) - COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.order_id = oi.order_id
                                                          WHERE oi.product_id = p.product_id AND o.status = 'pending'), 0) AS free_stock
                FROM products p LEFT JOIN inventory i ON i.product_id = p.product_id
                WHERE p.product_id IN (${ids.map(() => "?").join(",")})
            `, ids, (stockError, rows) => {
                if (stockError) return rollbackOrder(res, "Unable to check product stock.");
                const short = (rows || []).find(row => Number(row.free_stock) < wanted.get(row.product_id));
                if (short) {
                    const free = Math.max(0, Number(short.free_stock));
                    return rollbackOrder(res, free
                        ? `Only ${free} of ${short.product_name} can still be ordered right now (the rest is reserved for other orders). Lower the quantity, or call the station.`
                        : `${short.product_name} is sold out for now: all stock is reserved for other orders. Please try again later or call the station.`, 409);
                }
                insertOrder();
            });
        }
    );

    function insertOrder() {
            txDb.run(
                `
                INSERT INTO orders
                (
                    customer_id,
                    total_amount,
                    service_fee,
                    fulfillment_method,
                    preferred_date,
                    status
                )

                VALUES
                (?, ?, ?, ?, ?, 'pending')
                `,
                [
                    customerId,
                    totalAmount,
                    serviceFee,
                    fulfillmentMethod,
                    preferredDate
                ],
                function (error) {

                    if (error) {

                        rollbackOrder(
                            res,
                            "Unable to create order."
                        );

                        return;
                    }

                    const orderId =
                        this.lastID;

                    insertOrderItems(
                        orderId,
                        orderItems,
                        0,
                        res,
                        serviceFee,
                        totalAmount,
                        fulfillmentMethod
                    );

                }
            );
    }

}


// ==========================================
// INSERT ORDER ITEMS
// ==========================================

function insertOrderItems(
    orderId,
    orderItems,
    index,
    res,
    serviceFee = DELIVERY_SERVICE_FEE,
    totalAmount = 0,
    fulfillmentMethod = "delivery"
) {

    if (
        index >=
        orderItems.length
    ) {

        txDb.run(
            "COMMIT",
            [],
            error => {

                if (error) {

                    console.error(
                        "Order commit error:",
                        error
                    );

                    rollbackOrder(
                        res,
                        "Unable to save order."
                    );

                    return;
                }

                const finish = deliveryError => {
                    console.log(`Order ${orderId} created successfully.`);
                    orderEmails.send("placed", { orderId });
                    sendJSON(res, 200, {
                        success: true,
                        message: deliveryError
                            ? "Order created, but the delivery queue could not be updated. Please refresh Delivery Management."
                            : "Order created successfully.",
                        order_id: orderId,
                        total_amount: totalAmount,
                        service_fee: serviceFee,
                        fulfillment_method: fulfillmentMethod,
                        delivery_created: !deliveryError && fulfillmentMethod === "delivery"
                    });
                };

                if (fulfillmentMethod === "delivery") {
                    createDeliveryForOrder(orderId, orderItems, finish);
                } else {
                    finish(null);
                }

            }
        );

        return;
    }

    const item =
        orderItems[index];

    txDb.run(
        `
        INSERT INTO order_items
        (
            order_id,
            product_id,
            quantity,
            unit_price,
            subtotal,
            with_new_container
        )

        VALUES
        (?, ?, ?, ?, ?, ?)
        `,
        [
            orderId,
            item.product_id,
            item.quantity,
            item.unit_price,
            item.subtotal,
            item.with_new_container ? 1 : 0
        ],
        error => {

            if (error) {

                console.error(
                    "Order item error:",
                    error
                );

                rollbackOrder(
                    res,
                    "Unable to save order items."
                );

                return;
            }

            insertOrderItems(
                orderId,
                orderItems,
                index + 1,
                res,
                serviceFee,
                totalAmount,
                fulfillmentMethod
            );

        }
    );

}


// ==========================================
// COMPLETE ORDER
// AUTOMATIC STOCK-OUT
// ==========================================

function completeOrder(
    orderId,
    user,
    res
) {

    txDb.get(
        `
        SELECT
            order_id,
            status

        FROM orders

        WHERE order_id = ?
        `,
        [orderId],
        (error, order) => {

            if (error) {

                console.error(error);

                sendJSON(res, 500, {
                    success: false,
                    message:
                        "Unable to check order."
                });

                return;
            }

            if (!order) {

                sendJSON(res, 404, {
                    success: false,
                    message:
                        "Order not found."
                });

                return;
            }

            if (
                order.status ===
                "completed"
            ) {

                sendJSON(res, 400, {
                    success: false,
                    message:
                        "This order has already been completed."
                });

                return;
            }

            if (
                order.status !==
                "pending"
            ) {

                sendJSON(res, 400, {
                    success: false,
                    message:
                        "Only pending orders can be completed."
                });

                return;
            }

            txDb.all(
                `
                SELECT
                    order_items.product_id,
                    order_items.quantity,
                    products.product_name,
                    inventory.quantity AS stock_quantity,
                    inventory.minimum_stock

                FROM order_items

                INNER JOIN products
                    ON order_items.product_id =
                       products.product_id

                LEFT JOIN inventory
                    ON order_items.product_id =
                       inventory.product_id

                WHERE order_items.order_id = ?
                `,
                [orderId],
                (error, items) => {

                    if (error) {

                        console.error(error);

                        sendJSON(res, 500, {
                            success: false,
                            message:
                                "Unable to load order items."
                        });

                        return;
                    }

                    if (
                        !items ||
                        items.length === 0
                    ) {

                        sendJSON(res, 400, {
                            success: false,
                            message:
                                "This order has no items."
                        });

                        return;
                    }

                    for (const item of items) {

                        const stock =
                            Number(
                                item.stock_quantity
                            ) || 0;

                        const ordered =
                            Number(
                                item.quantity
                            ) || 0;

                        if (
                            stock <
                            ordered
                        ) {

                            sendJSON(res, 400, {
                                success: false,
                                message:
                                    `Insufficient stock for ${item.product_name}. Available: ${stock}, Required: ${ordered}.`
                            });

                            return;
                        }

                    }

                    txDb.run(
                        "BEGIN TRANSACTION",
                        [],
                        error => {

                            if (error) {

                                console.error(error);

                                sendJSON(res, 500, {
                                    success: false,
                                    message:
                                        "Unable to begin order completion."
                                });

                                return;
                            }

                            performStockOut(
                                items,
                                0,
                                orderId,
                                user,
                                res
                            );

                        }
                    );

                }
            );

        }
    );

}


// ==========================================
// PERFORM STOCK-OUT
// ==========================================

function performStockOut(
    items,
    index,
    orderId,
    user,
    res
) {

    if (
        index >=
        items.length
    ) {

        finishCompletedOrder(
            orderId,
            res
        );

        return;
    }

    const item =
        items[index];

    const productId =
        Number(
            item.product_id
        );

    const quantity =
        Number(
            item.quantity
        );

    txDb.get(
        `
        SELECT
            quantity,
            minimum_stock

        FROM inventory

        WHERE product_id = ?
        `,
        [productId],
        (error, inventory) => {

            if (error) {

                rollbackOrder(
                    res,
                    "Unable to read inventory."
                );

                return;
            }

            if (!inventory) {

                rollbackOrder(
                    res,
                    `Inventory record not found for ${item.product_name}.`
                );

                return;
            }

            const currentQuantity =
                Number(
                    inventory.quantity
                ) || 0;

            const minimumStock =
                Number(
                    inventory.minimum_stock
                ) || 0;

            if (
                currentQuantity <
                quantity
            ) {

                rollbackOrder(
                    res,
                    `Insufficient stock for ${item.product_name}.`
                );

                return;
            }

            const newQuantity =
                currentQuantity -
                quantity;

            const stockStatus =
                newQuantity <=
                minimumStock
                    ? "low-stock"
                    : "available";

            txDb.run(
                `
                UPDATE inventory

                SET
                    quantity = ?,
                    stock_status = ?,
                    updated_at =
                        CURRENT_TIMESTAMP

                WHERE product_id = ?
                `,
                [
                    newQuantity,
                    stockStatus,
                    productId
                ],
                function (error) {

                    if (error) {

                        rollbackOrder(
                            res,
                            "Unable to update inventory."
                        );

                        return;
                    }

                    txDb.run(
                        `
                        INSERT INTO inventory_movements
                        (
                            product_id,
                            movement_type,
                            quantity,
                            reason,
                            user_id
                        )

                        VALUES
                        (?, 'stock_out', ?, ?, ?)
                        `,
                        [
                            productId,
                            quantity,
                            `Completed Order #${orderId}`,
                            user.user_id
                        ],
                        function (error) {

                            if (error) {

                                rollbackOrder(
                                    res,
                                    "Unable to record stock movement."
                                );

                                return;
                            }

                            performStockOut(
                                items,
                                index + 1,
                                orderId,
                                user,
                                res
                            );

                        }
                    );

                }
            );

        }
    );

}


// ==========================================
// FINISH COMPLETED ORDER
// ==========================================

function finishCompletedOrder(
    orderId,
    res
) {

    txDb.run(
        `
        UPDATE orders

        SET
            status = 'completed'

        WHERE order_id = ?

        AND status = 'pending'
        `,
        [orderId],
        function (error) {

            if (error) {

                rollbackOrder(
                    res,
                    "Unable to complete order."
                );

                return;
            }

            if (
                this.changes === 0
            ) {

                rollbackOrder(
                    res,
                    "Order could not be completed."
                );

                return;
            }

            txDb.run(
                "COMMIT",
                [],
                error => {

                    if (error) {

                        console.error(
                            "Order commit error:",
                            error
                        );

                        rollbackOrder(
                            res,
                            "Unable to save completed order."
                        );

                        return;
                    }

                    console.log(
                        `Order ${orderId} completed successfully. Stock automatically deducted.`
                    );
                    orderEmails.send("completed", { orderId });

                    sendJSON(
                        res,
                        200,
                        {
                            success: true,

                            message:
                                "Order completed successfully. Stock has been deducted.",

                            order_id:
                                orderId,

                            status:
                                "completed"
                        }
                    );

                }
            );

        }
    );

}


// ==========================================
// RECORD MANUAL INVENTORY CHANGE
// ==========================================

function recordManualInventoryChange(
    productId,
    oldQuantity,
    newQuantity,
    userId,
    res
) {

    const difference =
        newQuantity -
        oldQuantity;

    if (difference === 0) {

        sendJSON(res, 200, {
            success: true,
            message:
                "Product updated successfully."
        });

        return;
    }

    const movementType =
        difference > 0
            ? "stock_in"
            : "stock_out";

    const movementQuantity =
        Math.abs(difference);

    const reason =
        "Inventory quantity updated";

    db.run(
        `
        INSERT INTO inventory_movements
        (
            product_id,
            movement_type,
            quantity,
            reason,
            user_id
        )

        VALUES
        (?, ?, ?, ?, ?)
        `,
        [
            productId,
            movementType,
            movementQuantity,
            reason,
            userId
        ],
        error => {

            if (error) {

                console.error(
                    "Inventory movement error:",
                    error
                );

                sendJSON(res, 500, {
                    success: false,
                    message:
                        "Product updated, but inventory movement could not be recorded."
                });

                return;
            }

            sendJSON(res, 200, {
                success: true,
                message:
                    "Product updated successfully."
            });

        }
    );

}




// ==========================================
// AUTHENTICATION HELPERS
// ==========================================

function requireLogin(
    sessions,
    req,
    res
) {

    const user = authMiddleware.requireLogin(
        sessions,
        req,
        res,
        sessionExpiry
    );

    return user && keepSessionAlive(req, res) ? user : null;

}


function requireAdmin(
    sessions,
    req,
    res
) {

    const user = authMiddleware.requireAdmin(
        sessions,
        req,
        res,
        sessionExpiry
    );

    return user && keepSessionAlive(req, res) ? user : null;

}

// Signing out happens after 30 minutes WITHOUT activity; every request made while
// signed in moves that time forward. (It used to be 30 minutes after signing in,
// which signed drivers out in the middle of a trip.) A sign-in lasts at most
// 12 hours, about one working day, so a page left open does not stay signed in forever.
const SESSION_MAX_AGE = 12 * 60 * 60 * 1000;
function keepSessionAlive(req, res) {
    const sessionId = getSessionId(req);
    if (!sessionId) return true;
    const started = sessionTimestamps.get(sessionId) || Date.now();
    if (Date.now() - started > SESSION_MAX_AGE) {
        sessions.delete(sessionId); sessionExpiry.delete(sessionId); sessionTimestamps.delete(sessionId);
        sendJSON(res, 401, { success: false, message: "Session expired. Please login again." });
        return false;
    }
    sessionExpiry.set(sessionId, Date.now() + SESSION_TIMEOUT);
    return true;
}

// Delivery orders enter the delivery queue automatically. Pickup orders do
// not create a delivery record because the customer collects them at the
// station.
// The delivery is scheduled on the day the customer picked, or today.
// The address a driver sees, from a customer record.
function deliveryAddressOf(customer) {
    return customer.address || [customer.house_number, customer.street, customer.zone ? `Zone ${customer.zone}` : "", customer.barangay, customer.city, customer.landmark ? `Landmark: ${customer.landmark}` : ""].filter(Boolean).join(", ");
}

// Each delivery keeps a copy of the customer's name, number and address. When the
// customer (or the admin) changes them, the copies follow:
//  - name and number on all of the customer's deliveries, so every list, report and
//    receipt shows the current ones;
//  - the address only on deliveries not yet dropped off (scheduled or on the way),
//    so the driver goes to the new address while finished deliveries keep the
//    address they were actually delivered to.
function syncCustomerDeliveries(customerId) {
    return new Promise(resolve => {
        db.get(`SELECT customer_name, contact_number, address, city, barangay, zone, street, house_number, landmark FROM customers WHERE customer_id = ?`, [customerId], (error, customer) => {
            if (error || !customer) return resolve();
            // A customer who is signed in sees the new name right away.
            for (const session of sessions.values()) {
                if (session.role === "customer" && Number(session.customer_id) === Number(customerId)) session.full_name = customer.customer_name;
            }
            db.run(`UPDATE delivery_schedules
                    SET customer_name = ?, contact_number = ?,
                        delivery_address = CASE WHEN status IN ('scheduled', 'out_for_delivery') THEN ? ELSE delivery_address END
                    WHERE order_id IN (SELECT order_id FROM orders WHERE customer_id = ?)`,
                [customer.customer_name, customer.contact_number, deliveryAddressOf(customer), customerId], updateError => {
                    if (updateError) console.error("Customer delivery sync error:", updateError.message);
                    resolve();
                });
        });
    });
}

function createDeliveryForOrder(orderId, orderItems, callback) {
    txDb.get(`SELECT c.customer_name, c.contact_number, c.address, c.city, c.barangay, c.zone, c.street, c.house_number, c.landmark, o.preferred_date
              FROM orders o JOIN customers c ON c.customer_id = o.customer_id WHERE o.order_id = ?`, [orderId], (lookupError, customer) => {
        if (lookupError || !customer) return callback(lookupError || new Error("Customer not found"));
        const address = deliveryAddressOf(customer);
        const items =orderItems.map(item => `${item.product_name || `Product #${item.product_id}`} × ${item.quantity}${item.with_new_container ? " (with new gallon)" : ""}`).join(", ");
        txDb.run(`INSERT INTO delivery_schedules (order_id, customer_name, contact_number, delivery_reason, delivery_items, delivery_date, delivery_time, delivery_address, status) VALUES (?, ?, ?, 'Customer order delivery', ?, COALESCE(?, date('now', '+8 hours')), '', ?, 'scheduled')`, [orderId, customer.customer_name, customer.contact_number, items, customer.preferred_date || null, address], error => callback(error || null));
    });
}

function requireStaff(sessions, req, res) {
    const user = requireLogin(sessions, req, res);
    if (!user) return null;
    if (!['admin', 'staff'].includes(user.role)) {
        sendJSON(res, 403, { success: false, message: "Only staff or administrators can do this." });
        return null;
    }
    return user;
}

function requireCustomer(sessions, req, res) {
    const user = requireLogin(sessions, req, res);
    if (!user) return null;

    if (user.role !== "customer" || !user.customer_id) {
        sendJSON(res, 403, { success: false, message: "Customer account access is required." });
        return null;
    }

    return user;
}

function dbGet(sql, params) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
    });
}

function dbRun(sql, params) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (error) {
            if (error) reject(error);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}


// ==========================================
// GET SESSION ID
// ==========================================

function getSessionId(req) {

    const cookies =
        req.headers.cookie || "";

    const sessionCookie =
        cookies
            .split(";")
            .find(cookie =>
                cookie
                    .trim()
                    .startsWith("sessionId=")
            );

    if (!sessionCookie) {
        return null;
    }

    return sessionCookie
        .trim()
        .split("=")
        .slice(1)
        .join("=");
}


// ==========================================
// SEND JSON
// ==========================================

function sendJSON(
    res,
    statusCode,
    data
) {

    if (res.headersSent) {
        return;
    }

    res.writeHead(
        statusCode,
        responseHeaders("application/json; charset=utf-8", {
            "Cache-Control": "no-cache"
        })
    );

    res.end(
        JSON.stringify(data)
    );

}


// ==========================================
// SEND TEXT
// ==========================================

function sendText(
    res,
    statusCode,
    message
) {

    if (res.headersSent) {
        return;
    }

    res.writeHead(
        statusCode,
        responseHeaders("text/plain; charset=utf-8")
    );

    res.end(
        message
    );

}

// Shared response headers keep browser behavior safer and consistent across
// API errors, pages, and static assets. This is appropriate for local HTTP;
// production deployment should also use HTTPS.
function responseHeaders(contentType, extra = {}) {
    return {
        "Content-Type": contentType,
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "same-origin",
        "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'",
        ...extra
    };
}


// ==========================================
// READ REQUEST BODY
// ==========================================

function getRequestBody(
    req,
    callback
) {

    let body = "";

    let finished = false;

    const MAX_BODY_SIZE =
        1000000;

    req.on(
        "data",
        chunk => {

            if (finished) {
                return;
            }

            body +=
                chunk.toString();

            if (
                body.length >
                MAX_BODY_SIZE
            ) {

                finished = true;

                callback(
                    new Error(
                        "Request body too large"
                    ),
                    null
                );

                req.destroy();

            }

        }
    );

    req.on(
        "end",
        () => {

            if (finished) {
                return;
            }

            finished = true;

            try {

                if (!body.trim()) {

                    callback(
                        null,
                        {}
                    );

                    return;
                }

                const data =
                    JSON.parse(
                        body
                    );

                // Kept for the activity log, which saves only record numbers from it.
                req.olvBody = data;

                callback(
                    null,
                    data
                );

            }
            catch (error) {

                callback(
                    error,
                    null
                );

            }

        }
    );

    req.on(
        "error",
        error => {

            if (finished) {
                return;
            }

            finished = true;

            callback(
                error,
                null
            );

        }
    );

}


// ==========================================
// SERVE HTML PAGE
// ==========================================

function servePage(
    fileName,
    res
) {

    const filePath =
        path.join(
            __dirname,
            "views",
            fileName
        );

    serveFile(
        filePath,
        "text/html; charset=utf-8",
        res
    );

}


// ==========================================
// SERVE PUBLIC FILE
// ==========================================

function servePublicFile(
    requestUrl,
    contentType,
    res
) {

    const relativePath =
        requestUrl
            .replace(/^\/+/, "");

    const publicDirectory =
        path.resolve(
            __dirname,
            "public"
        );

    const filePath =
        path.resolve(
            publicDirectory,
            relativePath
        );

    // Prevent directory traversal
    if (
        filePath !== publicDirectory &&
        !filePath.startsWith(
            publicDirectory +
            path.sep
        )
    ) {

        sendText(
            res,
            403,
            "403 - Forbidden"
        );

        return;
    }

    serveFile(
        filePath,
        contentType,
        res
    );

}


// ==========================================
// SERVE FILE
// ==========================================

function serveFile(
    filePath,
    contentType,
    res
) {

    fs.readFile(
        filePath,
        (error, data) => {

            if (error) {

                console.error(
                    "File error:",
                    error
                );

                if (
                    error.code ===
                    "ENOENT"
                ) {

                    sendText(
                        res,
                        404,
                        "404 - File Not Found"
                    );

                    return;
                }

                sendText(
                    res,
                    500,
                    "Server Error"
                );

                return;
            }

            if (res.headersSent) {
                return;
            }

             res.writeHead(
                 200,
                 responseHeaders(contentType)
             );

            res.end(
                data
            );

        }
    );

}


// ==========================================
// CANCEL ORDER
// ==========================================
// A pending order and its delivery are cancelled together, which also frees the stock
// it had reserved. Customers can cancel until the driver leaves with the order; staff
// can also cancel an order that is out for delivery (e.g. the customer refused it at
// the door). Nobody can cancel once it has been dropped off or completed.
function cancelOrder(orderId, { customerId, reason, user }, res) {
    txDb.run("BEGIN TRANSACTION", [], beginError => {
        if (beginError) return sendJSON(res, 500, { success: false, message: "Unable to cancel the order. Try again." });
        txDb.get(`SELECT o.order_id, o.customer_id, o.status,
                         (SELECT d.status FROM delivery_schedules d WHERE d.order_id = o.order_id AND d.status <> 'cancelled' ORDER BY d.delivery_id DESC LIMIT 1) AS delivery_status
                  FROM orders o WHERE o.order_id = ?`, [orderId], (lookupError, order) => {
            if (lookupError) return rollbackOrder(res, "Unable to check the order.", 500);
            // A customer asking about someone else's order is told it does not exist.
            if (!order || (customerId != null && Number(order.customer_id) !== Number(customerId))) return rollbackOrder(res, "Order not found.", 404);
            if (order.status === "cancelled") return rollbackOrder(res, "This order is already cancelled.", 409);
            if (order.status !== "pending") return rollbackOrder(res, "A completed order cannot be cancelled.", 409);
            if (order.delivery_status === "awaiting_customer" || order.delivery_status === "delivered") return rollbackOrder(res, "This order was already dropped off, so it can no longer be cancelled.", 409);
            if (customerId != null && order.delivery_status === "out_for_delivery") return rollbackOrder(res, "Your order is already on the way, so it can no longer be cancelled here. Please call or message the station.", 409);
            txDb.run("UPDATE orders SET status = 'cancelled' WHERE order_id = ? AND status = 'pending'", [orderId], function (updateError) {
                if (updateError || !this.changes) return rollbackOrder(res, "Unable to cancel the order. Refresh and try again.", 409);
                txDb.run(`UPDATE delivery_schedules SET status = 'cancelled', delivery_proof = ?
                          WHERE order_id = ? AND status IN ('scheduled', 'out_for_delivery')`,
                    [`Order cancelled by ${customerId != null ? "the customer" : (user.full_name || user.username || "staff")}${reason ? `: ${reason}` : ""}`, orderId], deliveryError => {
                    if (deliveryError) return rollbackOrder(res, "Unable to cancel the delivery.", 500);
                    txDb.run("COMMIT", [], commitError => {
                        if (commitError) return sendJSON(res, 500, { success: false, message: "Unable to cancel the order. Try again." });
                        if (customerId == null) orderEmails.send("cancelled", { orderId, reason });
                        sendJSON(res, 200, { success: true, message: "Order cancelled." });
                    });
                });
            });
        });
    });
}

// ==========================================
// ROLLBACK DATABASE TRANSACTION
// ==========================================

function rollbackOrder(
    res,
    message,
    status = 400
) {

    txDb.run(
        "ROLLBACK",
        [],
        error => {

            if (error) {

                console.error(
                    "Rollback error:",
                    error
                );

            }

            if (
                !res.headersSent
            ) {

                sendJSON(
                    res,
                    status,
                    {
                        success: false,
                        message:
                            message
                    }
                );

            }

        }
    );

}

// ==========================================
// START SERVER
// ==========================================

server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
        console.error(`Port ${PORT} is already in use. Please close other applications using this port.`);
        process.exit(1);
    } else {
        console.error("Server error:", error);
        process.exit(1);
    }
});

server.listen(
    PORT,
    () => {

        console.log(
            `Server running at ${server instanceof https.Server ? "https" : "http"}://localhost:${PORT}`
        );

    }
);
