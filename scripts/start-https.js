// Starts the system with HTTPS, and prints the address to open on phones connected
// to the same Wi-Fi. The certificate (certs/) is made or renewed automatically.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const folder = path.join(__dirname, "..", "certs");
const key = path.join(folder, "olv-key.pem");
const cert = path.join(folder, "olv-cert.pem");
const wifiAddresses = () => Object.values(os.networkInterfaces()).flat()
    .filter(net => net && net.family === "IPv4" && !net.internal && !net.address.startsWith("169.254."))
    .map(net => net.address);
// The certificate names the Wi-Fi addresses it is for. On another network (or a new
// address from the router) a new one is made, so phones get only the usual one-time warning.
function certificateFits() {
    if (!fs.existsSync(key) || !fs.existsSync(cert)) return false;
    try {
        const certificate = new crypto.X509Certificate(fs.readFileSync(cert));
        const covered = String(certificate.subjectAltName || "");
        return new Date(certificate.validTo) > new Date() && wifiAddresses().every(ip => covered.includes(`IP Address:${ip}`));
    } catch { return false; }
}
if (!certificateFits()) {
    console.log("Making an HTTPS certificate for this Wi-Fi address...");
    require("./make-https-cert.js");
}
// .env is read here too (app.js reads it as well), so an APP_URL set there wins below.
const envFile = path.join(__dirname, "..", ".env");
if (fs.existsSync(envFile)) {
    const settings = require("util").parseEnv(fs.readFileSync(envFile, "utf8").replace(/^﻿/, ""));
    for (const [name, value] of Object.entries(settings)) if (!(name in process.env)) process.env[name] = value;
}

process.env.HTTPS_KEY = key;
process.env.HTTPS_CERT = cert;
const port = process.env.PORT || 3000;
const addresses = wifiAddresses();
// Email links (account confirmation, password reset) should open the https address too.
if (!process.env.APP_URL && addresses.length) process.env.APP_URL = `https://${addresses[0]}:${port}`;

require("../app.js");
console.log("");
console.log("Open on phones (same Wi-Fi): " + (addresses.map(ip => `https://${ip}:${port}`).join("  ") || "(no Wi-Fi address found)"));
console.log("The first time, the browser warns that the connection is not private:");
console.log("tap Advanced, then Proceed / Continue. This is expected for a station-made certificate.");
