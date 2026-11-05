const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { requireAdmin } = require("../middleware/authMiddleware");

// Exercise the actual route code with isolated storage; never modify live accounts.
const source = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
const routes = source.slice(source.indexOf("    // Customer login administration"), source.indexOf("    // A portal login made by staff for a customer without email"));
const passwordValidator = source.slice(source.indexOf("function validateStrongPassword("), source.indexOf("function buildCustomerAddress("));

async function request({ role = "admin", method = "PUT", missing = false, duplicate = false, password = "", status = "active", route = "/api/customers/account" } = {}) {
    const sessions = new Map([
        ["actor", { role }],
        ["customer", { role: "customer", customer_id: 7 }],
        ["other", { role: "customer", customer_id: 8 }]
    ]);
    const writes = [];
    const hashes = [];
    let complete;
    const done = new Promise(resolve => { complete = resolve; });
    const res = { writeHead(code) { this.code = code; }, end(body) { complete({ code: this.code, body: JSON.parse(body) }); } };
    const context = {
        URL, req: { method, url: `${route}?customer_id=7`, headers: { cookie: "sessionId=actor" } }, res,
        url: route, sessions, sessionExpiry: new Map(), sessionTimestamps: new Map(), requireAdmin,
        servePage(page, response) { response.writeHead(200); response.end(JSON.stringify({ page })); },
        sendJSON(response, code, body) { response.writeHead(code); response.end(JSON.stringify(body)); },
        getRequestBody(req, callback) { callback(null, { customer_id: 7, username: "customer7", password, status }); },
        db: {
            all(sql, params, callback) { assert.ok(!sql.includes("password")); callback(null, []); },
            get(sql, params, callback) { callback(null, missing ? undefined : { customer_id: 7, username: "customer7", status: "active" }); }
        },
        dbGet: async sql => sql.includes("UNION") ? (duplicate ? { username: "customer7" } : undefined) : (missing ? undefined : { customer_id: 7 }),
        dbRun: async (sql, params) => { writes.push(params); return { changes: 1 }; },
        bcrypt: { hash: async value => { hashes.push(value); return "hashed-password"; } }
    };
    const pageRoutes = source.slice(source.indexOf('    if (req.method === "GET" && url === "/customer-accounts")'), source.indexOf("    // Customer login administration"));
    vm.runInNewContext(`${passwordValidator}\n(function () { ${pageRoutes}\n${routes} })()`, context);
    const result = await done;
    return { ...result, writes, hashes, sessions };
}

(async () => {
    for (const route of ["/customer-accounts", "/api/customer-accounts"]) {
        assert.equal((await request({ route, method: "GET" })).code, 200);
        for (const role of ["staff", "driver", "customer"]) {
            assert.equal((await request({ route, role, method: "GET" })).code, 403);
        }
    }
    for (const role of ["staff", "driver", "customer"]) {
        for (const method of ["GET", "PUT"]) {
            const result = await request({ role, method });
            assert.equal(result.code, 403);
            assert.equal(result.writes.length, 0);
        }
    }
    const read = await request({ method: "GET" });
    assert.equal(read.code, 200);
    assert.equal("password" in read.body.account, false);
    for (const method of ["GET", "PUT"]) assert.equal((await request({ missing: true, method })).code, 404);
    for (const options of [{ duplicate: true }, { password: "weak" }, { status: "admin" }]) {
        const result = await request(options);
        assert.equal(result.code, options.duplicate ? 409 : 400);
        assert.equal(result.writes.length, 0);
    }
    const unchangedPassword = await request();
    assert.equal(unchangedPassword.code, 200);
    assert.equal(unchangedPassword.writes[0][1], null);
    assert.equal(unchangedPassword.hashes.length, 0);
    const reset = await request({ password: "NewPassword7!", status: "inactive" });
    assert.equal(reset.code, 200);
    assert.equal(reset.writes[0][1], "hashed-password");
    assert.equal(reset.writes[0][2], "inactive");
    assert.equal(reset.sessions.has("customer"), false);
    assert.equal(reset.sessions.has("other"), true);
    assert.equal(reset.sessions.has("actor"), true);
    console.log("Customer account checks passed: admin authorization, account lookup, validation, password updates, and session revocation.");
})().catch(error => { console.error(error); process.exitCode = 1; });
