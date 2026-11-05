// npm run online — puts the system on the internet so customers can order from home,
// without buying hosting: this computer runs the system as usual, and a tunnel gives
// it a public https address.
//
// - OWN WEBSITE ADDRESS (e.g. https://olvwater.com): with CLOUDFLARE_TUNNEL_TOKEN and
//   SITE_URL in .env, the station's own domain is used through a Cloudflare tunnel.
//   See docs/own-domain-setup.md. Only the domain costs money; the tunnel is free.
// - PERMANENT address (same every time): with NGROK_AUTHTOKEN and NGROK_URL in .env,
//   a free ngrok account's fixed address is used (e.g. https://olv-water.ngrok-free.app).
// - Otherwise a free Cloudflare address is used (…trycloudflare.com), which changes
//   every time this is started.
// - Either way, this computer must stay on and connected while customers use it.
// - It refuses to start while an account still uses an easy default password.
// - The first run downloads the tunnel program into tools/.
const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const bcrypt = require("bcrypt");

const root = path.join(__dirname, "..");
const port = Number(process.env.PORT) || 3000;
const tools = path.join(root, "tools");
const win = process.platform === "win32";
const PROGRAMS = {
    cloudflare: {
        exe: path.join(tools, win ? "cloudflared.exe" : "cloudflared"),
        url: win ? "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
            : "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
    },
    ngrok: {
        exe: path.join(tools, win ? "ngrok.exe" : "ngrok"),
        url: win ? "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip"
            : "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz",
        archive: true
    }
};
const WEAK = ["admin123", "staff123", "driver123", "password", "password123", "12345678", "admin"];

async function checkPasswords() {
    const db = require("../database/database");
    const users = await new Promise((resolve, reject) => db.all("SELECT username, password FROM users WHERE status = 'active'", [], (error, rows) => error ? reject(error) : resolve(rows)));
    const weak = [];
    for (const user of users) if (await anyMatch(user.password)) weak.push(user.username);
    if (weak.length) {
        console.error(`Not going online: ${weak.join(", ")} still ${weak.length === 1 ? "uses" : "use"} an easy default password (like admin123).`);
        console.error("Anyone on the internet could sign in with it. Change it in Manage Accounts, then run npm run online again.");
        process.exit(1);
    }
}
async function anyMatch(hash) {
    for (const guess of WEAK) if (await bcrypt.compare(guess, hash).catch(() => false)) return true;
    return false;
}

async function ensureProgram(program, label) {
    if (fs.existsSync(program.exe)) return;
    console.log(`Downloading ${label} (first time only)...`);
    fs.mkdirSync(tools, { recursive: true });
    const response = await fetch(program.url);
    if (!response.ok) { console.error(`Download failed (${response.status}). Check the internet connection and try again.`); process.exit(1); }
    const file = program.archive ? path.join(tools, path.basename(program.url)) : program.exe + ".part";
    fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    if (program.archive) { execFileSync("tar", ["-xf", file, "-C", tools]); fs.unlinkSync(file); }
    else fs.renameSync(file, program.exe);
    if (!win) fs.chmodSync(program.exe, 0o755);
}

// "olv-water.ngrok-free.app" or "https://olv-water.ngrok-free.app/" -> "https://olv-water.ngrok-free.app"
function fixedAddress(value) {
    const host = String(value || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host) ? `https://${host.toLowerCase()}` : null;
}

async function main() {
    await checkPasswords();
    // Behind the tunnel, trust its headers for the visitor's address and https.
    process.env.OLV_BEHIND_PROXY = "1";
    process.env.PORT = String(port);
    require("../app.js"); // also reads .env

    // Own domain through a Cloudflare tunnel made in the Cloudflare dashboard.
    const cloudflareToken = String(process.env.CLOUDFLARE_TUNNEL_TOKEN || "").trim();
    const site = fixedAddress(process.env.SITE_URL);
    const filled = name => String(process.env[name] || "").trim() !== "";
    if (cloudflareToken || filled("SITE_URL")) {
        if (!cloudflareToken || !site) { console.error("For your own website address, fill in BOTH CLOUDFLARE_TUNNEL_TOKEN and SITE_URL (e.g. olvwater.com) in .env. See docs/own-domain-setup.md."); process.exit(1); }
        if (filled("NGROK_AUTHTOKEN") || filled("NGROK_URL")) { console.error("Use either your own domain (CLOUDFLARE_TUNNEL_TOKEN, SITE_URL) or ngrok (NGROK_AUTHTOKEN, NGROK_URL) in .env, not both. Empty the ones you do not use."); process.exit(1); }
    }

    // ngrok settings matter only when the own-domain settings are not used.
    const token = site ? "" : String(process.env.NGROK_AUTHTOKEN || "").trim();
    const permanent = site ? null : fixedAddress(process.env.NGROK_URL);
    if (!site && filled("NGROK_URL") && !permanent) { console.error("NGROK_URL in .env is not an address. Copy your domain from https://dashboard.ngrok.com/domains (e.g. olv-water.ngrok-free.app)."); process.exit(1); }
    if (Boolean(token) !== Boolean(permanent)) { console.error("For the permanent address, fill in BOTH NGROK_AUTHTOKEN and NGROK_URL in .env (or leave both empty for a changing address)."); process.exit(1); }

    let tunnel;
    let announced = false;
    // A new address can take a minute to start working, so it is shown only once it
    // answers (otherwise people would get "site can't be reached").
    async function announceWhenReachable(url) {
        announced = true;
        process.env.APP_URL = url; // links in emails open the public address
        console.log("Connecting to the internet... (this can take a minute)");
        for (let i = 0; i < 60; i++) {
            try { if ((await fetch(url + "/", { headers: { "ngrok-skip-browser-warning": "1" }, signal: AbortSignal.timeout(8000) })).ok) break; } catch { /* not reachable yet */ }
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
        console.log("");
        console.log("The system is ONLINE at:  " + url);
        console.log("Customers can open it from any phone or computer. Keep this window and this computer on.");
        console.log(permanent || site ? "This address stays the same every time. Press Ctrl+C to go offline."
            : "This address changes every time you start online mode. Press Ctrl+C to go offline.");
    }

    if (site) {
        await ensureProgram(PROGRAMS.cloudflare, "Cloudflare's tunnel program, about 60 MB");
        // The token is passed in the environment, so it does not show in the process list.
        tunnel = spawn(PROGRAMS.cloudflare.exe, ["tunnel", "--no-autoupdate", "run"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, TUNNEL_TOKEN: cloudflareToken } });
        let errorShown = false;
        const watch = chunk => {
            const text = String(chunk);
            if (!announced && /Registered tunnel connection|Connection [0-9a-f-]+ registered/i.test(text)) announceWhenReachable(site);
            if (!errorShown && /Failed to get tunnel|Unauthorized|invalid token|Provided Tunnel token is not valid|failed to unmarshal/i.test(text)) {
                errorShown = true;
                console.error("Cloudflare refused the tunnel token. Copy it again from the Cloudflare dashboard (Zero Trust > Networks > Tunnels) into CLOUDFLARE_TUNNEL_TOKEN in .env. See docs/own-domain-setup.md.");
            }
        };
        tunnel.stdout.on("data", watch);
        tunnel.stderr.on("data", watch);
    } else if (permanent) {
        await ensureProgram(PROGRAMS.ngrok, "the ngrok tunnel program, about 10 MB");
        tunnel = spawn(PROGRAMS.ngrok.exe, ["http", String(port), "--url", permanent, "--authtoken", token, "--log", "stdout", "--log-format", "logfmt"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        let errorShown = false;
        const watch = chunk => {
            const text = String(chunk);
            if (!announced && /started tunnel|url=https:/.test(text)) announceWhenReachable(permanent);
            const problem = /ERR_NGROK_\d+|authentication failed|not authorized|is not bound|reserved for another account/i.exec(text);
            if (problem && !errorShown) {
                errorShown = true;
                const reason = (/err="([^"]+)"/.exec(text)?.[1] || problem[0]).split(/\\r|\\n|\r|\n/)[0];
                const code = /ERR_NGROK_\d+/.exec(text)?.[0];
                console.error(`ngrok refused the connection: ${reason}${code ? ` (${code})` : ""}`);
                console.error("Check NGROK_AUTHTOKEN (https://dashboard.ngrok.com/get-started/your-authtoken) and NGROK_URL (https://dashboard.ngrok.com/domains) in .env.");
            }
        };
        tunnel.stdout.on("data", watch);
        tunnel.stderr.on("data", watch);
    } else {
        await ensureProgram(PROGRAMS.cloudflare, "Cloudflare's tunnel program, about 60 MB");
        tunnel = spawn(PROGRAMS.cloudflare.exe, ["tunnel", "--no-autoupdate", "--url", `http://localhost:${port}`], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        const watch = chunk => {
            const match = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
            if (match && !announced) announceWhenReachable(match[0]);
        };
        tunnel.stdout.on("data", watch);
        tunnel.stderr.on("data", watch);
    }
    tunnel.on("exit", code => { console.error(`The tunnel stopped (code ${code}). The system is no longer online. Run npm run online to try again.`); process.exit(1); });
    const stop = () => { tunnel.kill(); process.exit(0); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    setTimeout(() => { if (!announced) console.error("Still waiting for the public address... check the internet connection."); }, 30000);
}

main().catch(error => { console.error("Unable to go online:", error.message); process.exit(1); });
