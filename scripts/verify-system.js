/*
 * Small, dependency-free pre-flight check for the capstone project.
 * Run with: npm run check
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const requiredFiles = [
    "app.js",
    "database/database.js",
    "database/olv_database.db",
    "views/login.html",
    "views/dashboard.html",
    "views/customers.html",
    "views/inventory.html",
    "views/orders.html",
    "views/delivery.html",
    "views/reports.html",
    "views/customer-history.html",
    "views/customer-portal.html",
    // Kept in the project so pages work without the internet.
    "public/vendor/bootstrap/bootstrap.min.css",
    "public/vendor/bootstrap/bootstrap.bundle.min.js",
    "public/vendor/bootstrap-icons/bootstrap-icons.min.css",
    "public/vendor/bootstrap-icons/fonts/bootstrap-icons.woff2"
];

const javascriptFiles = [
    "app.js",
    ...walk(path.join(root, "public"), ".js"),
    ...walk(path.join(root, "middleware"), ".js"),
    ...walk(path.join(root, "controllers"), ".js"),
    ...walk(path.join(root, "routes"), ".js"),
    ...walk(path.join(root, "utils"), ".js"),
    ...walk(path.join(root, "database"), ".js")
];

const missing = requiredFiles.filter(file => !fs.existsSync(path.join(root, file)));
if (missing.length) {
    console.error("Missing required files:");
    missing.forEach(file => console.error(` - ${file}`));
    process.exit(1);
}

const syntaxErrors = javascriptFiles.filter(file => {
    const result = spawnSync(process.execPath, ["--check", path.join(root, file)], { encoding: "utf8" });
    if (result.error) {
        console.error(`Unable to run syntax check for ${file}: ${result.error.message}`);
        return true;
    }
    if (result.status !== 0) {
        console.error(result.stderr || `Syntax error in ${file}`);
        return true;
    }
    return false;
});

if (syntaxErrors.length) process.exit(1);

console.log(`System check passed: ${javascriptFiles.length} JavaScript files and ${requiredFiles.length} required project files.`);

function walk(directory, extension) {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) return walk(fullPath, extension);
        return path.extname(entry.name) === extension ? [path.relative(root, fullPath)] : [];
    });
}
