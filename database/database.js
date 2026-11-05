const sqlite3 = require("sqlite3").verbose();
const path = require("path");

// Location of the SQLite database
const dbPath = process.env.OLV_DB_PATH ? path.resolve(process.env.OLV_DB_PATH) : path.join(__dirname, "olv_database.db");

// Create or open the database
const db = new sqlite3.Database(dbPath, (error) => {
    if (error) {
        console.error("Database connection failed:", error.message);
    } else {
        console.log("Connected to OLV SQLite database.");
    }
});
// While a multi-step change is being saved, other writes wait (up to 10 s) instead of failing.
db.configure("busyTimeout", 10000);
// WAL mode: reading never blocks saving, and saves from the two connections queue up
// instead of failing with "database is locked". (Kept in the file; adds .db-wal/.db-shm.)
db.run("PRAGMA journal_mode = WAL", error => { if (error) console.error("Unable to switch the database to WAL mode:", error.message); });
// A save that starts at the very moment another connection finishes one can still be
// told "database is locked" straight away (SQLite cannot wait in that case). Such a
// save is simply tried again a moment later, up to about 2 seconds.
const runOnce = db.run.bind(db);
db.run = function (sql, params, callback) {
    if (typeof params === "function") { callback = params; params = []; }
    let tries = 0;
    const attempt = () => runOnce(sql, params ?? [], function (error) {
        if (error && error.code === "SQLITE_BUSY" && tries++ < 40) return setTimeout(attempt, 50);
        if (callback) callback.call(this, error);
        else if (error) console.error("Database error:", error.message);
    });
    attempt();
    return db;
};

// ==========================================
// MULTI-STEP CHANGES (TRANSACTIONS)
// ==========================================
// Creating an order, completing an order, and deleting a product each take several
// steps that must all be saved or none. They use this second connection, one at a
// time: BEGIN waits until the previous change has finished (COMMIT or ROLLBACK).
// With one shared connection, two customers ordering at the same moment made the
// second order fail ("cannot start a transaction within a transaction"), and other
// people's changes could end up inside someone else's half-saved order.
// BEGIN IMMEDIATE takes the write lock at the start, so the main connection's writes
// simply wait for a moment, and the two connections can never block each other.
const transactions = (() => {
    const raw = new sqlite3.Database(dbPath);
    raw.configure("busyTimeout", 10000);
    const waiting = [];
    let held = false;
    let guard = null;
    // A change that never finishes (a bug) must not freeze ordering for everyone.
    const STUCK_MS = 30000;

    function release() {
        clearTimeout(guard);
        held = false;
        const next = waiting.shift();
        if (next) next();
    }
    function acquire(start) {
        const begin = () => {
            held = true;
            guard = setTimeout(() => {
                console.error("A database change took over 30 seconds and was undone.");
                raw.run("ROLLBACK", () => release());
            }, STUCK_MS);
            start();
        };
        held ? waiting.push(begin) : begin();
    }
    const split = (params, callback) => typeof params === "function" ? [[], params] : [params ?? [], callback];

    return {
        run(sql, params, callback) {
            [params, callback] = split(params, callback);
            const statement = String(sql).trim().toUpperCase();
            if (statement.startsWith("BEGIN")) {
                acquire(() => raw.run("BEGIN IMMEDIATE", [], function (error) {
                    if (error) release();
                    if (callback) callback.call(this, error);
                }));
                return this;
            }
            if (statement.startsWith("COMMIT")) {
                raw.run(sql, params, function (error) {
                    const self = this;
                    // A failed COMMIT leaves the change open; undo it so the next one can start.
                    if (error) return raw.run("ROLLBACK", () => { release(); if (callback) callback.call(self, error); });
                    release();
                    if (callback) callback.call(self, null);
                });
                return this;
            }
            if (statement.startsWith("ROLLBACK")) {
                raw.run(sql, params, function (error) { release(); if (callback) callback.call(this, error); });
                return this;
            }
            raw.run(sql, params, callback);
            return this;
        },
        get(sql, params, callback) { raw.get(sql, ...split(params, callback)); return this; },
        all(sql, params, callback) { raw.all(sql, ...split(params, callback)); return this; },
        serialize(fn) { raw.serialize(fn); },
        close(callback) { raw.close(callback); }
    };
})();

module.exports = db;
module.exports.transactions = transactions;
// Where the database file is (backups are kept in a "backups" folder beside it).
module.exports.filePath = dbPath;
