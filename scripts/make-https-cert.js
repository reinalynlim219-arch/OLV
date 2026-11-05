// Creates a self-signed HTTPS certificate for this computer, so phones on the
// same Wi-Fi can open the system with https:// (browsers only share a phone's
// location with https pages). npm run start:https runs this by itself when the
// computer's Wi-Fi address changes; npm run https:cert runs it by hand.
const fs = require("fs");
const os = require("os");
const path = require("path");
const selfsigned = require("selfsigned");

const folder = path.join(__dirname, "..", "certs");
const addresses = Object.values(os.networkInterfaces()).flat()
    .filter(net => net && net.family === "IPv4" && !net.internal && !net.address.startsWith("169.254."))
    .map(net => net.address);

const altNames = [
    { type: 2, value: "localhost" },
    { type: 7, ip: "127.0.0.1" },
    ...addresses.map(ip => ({ type: 7, ip }))
];
const pems = selfsigned.generate([{ name: "commonName", value: "OLV Water Refilling Station" }], {
    keySize: 2048,
    days: 825,
    algorithm: "sha256",
    extensions: [
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames }
    ]
});

fs.mkdirSync(folder, { recursive: true });
fs.writeFileSync(path.join(folder, "olv-key.pem"), pems.private, { mode: 0o600 });
fs.writeFileSync(path.join(folder, "olv-cert.pem"), pems.cert);
console.log("HTTPS certificate created in the certs folder.");
console.log("It works for: localhost" + (addresses.length ? ", " + addresses.join(", ") : ""));
if (require.main === module) console.log("Start the system with: npm run start:https");
