// Automatic daily backup of the database.
//  - Once a day (checked at start-up and every hour) a full copy is saved to
//    database/backups/olv-backup-YYYY-MM-DD.db (Philippine date).
//  - The copy is made with SQLite's VACUUM INTO, which is safe while the system is
//    running: it is one consistent snapshot, even in the middle of orders.
//  - The newest 30 daily copies are kept; older ones are deleted.
//  - BACKUP_COPY_DIR in .env (e.g. a flash drive "E:\OLV backups" or a Google Drive
//    folder) gets a second copy, so the data survives if the laptop breaks.
// To restore: stop the system, replace database/olv_database.db with a backup copy
// (rename it to olv_database.db), and start the system again.
const fs = require("fs");
const path = require("path");

// Backups go in a "backups" folder beside the database file in use, so a test
// database never mixes its copies with (or prunes) the station's real backups.
module.exports = function backup(db, { folder = path.join(path.dirname(db.filePath || path.join(__dirname, "..", "database", "x.db")), "backups"), keep = 30 } = {}) {
    const NAME = /^olv-backup-(\d{4}-\d{2}-\d{2})(?:-(\d{6}))?\.db$/;
    const phDate = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const phTime = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(11, 19).replace(/:/g, "");
    let running = null;
    let lastError = "";

    function list() {
        if (!fs.existsSync(folder)) return [];
        return fs.readdirSync(folder).filter(name => NAME.test(name)).map(name => {
            const stat = fs.statSync(path.join(folder, name));
            return { name, size: stat.size, created_at: stat.mtime.toISOString() };
        }).sort((a, b) => b.created_at.localeCompare(a.created_at));
    }

    function prune() {
        // Daily copies past the newest `keep` are removed; manual copies count too.
        for (const old of list().slice(keep)) {
            try { fs.unlinkSync(path.join(folder, old.name)); } catch { /* in use; try next time */ }
        }
    }

    // Makes a copy now. `manual` adds the time to the name so it never replaces the daily copy.
    function make({ manual = false } = {}) {
        if (running) return running;
        running = new Promise((resolve, reject) => {
            fs.mkdirSync(folder, { recursive: true });
            const name = `olv-backup-${phDate()}${manual ? `-${phTime()}` : ""}.db`;
            const target = path.join(folder, name);
            const temp = target + ".part";
            try { fs.unlinkSync(temp); } catch { /* none */ }
            db.run("VACUUM INTO ?", [temp], error => {
                if (error) { lastError = error.message; try { fs.unlinkSync(temp); } catch { } return reject(error); }
                try {
                    fs.renameSync(temp, target);
                    lastError = "";
                    const extra = String(process.env.BACKUP_COPY_DIR || "").trim();
                    if (extra) {
                        try { fs.mkdirSync(extra, { recursive: true }); fs.copyFileSync(target, path.join(extra, name)); }
                        catch (copyError) { lastError = `Saved on this computer, but the second copy to ${extra} failed: ${copyError.message}`; console.error("Backup copy failed:", copyError.message); }
                    }
                    prune();
                    resolve({ name, size: fs.statSync(target).size });
                } catch (moveError) { lastError = moveError.message; reject(moveError); }
            });
        }).finally(() => { running = null; });
        return running;
    }

    // The daily copy, made once per Philippine day.
    async function daily() {
        if (list().some(item => NAME.exec(item.name)?.[1] === phDate())) return null;
        try {
            const made = await make();
            console.log(`Daily backup saved: database/backups/${made.name}`);
            return made;
        } catch (error) {
            console.error("Daily backup failed:", error.message);
            return null;
        }
    }

    function start() {
        setTimeout(daily, 15000);                     // shortly after start-up
        setInterval(daily, 60 * 60 * 1000).unref();   // then check every hour
    }

    function status() {
        const items = list();
        return { latest: items[0] || null, count: items.length, keep, second_copy_folder: String(process.env.BACKUP_COPY_DIR || "").trim() || null, last_error: lastError || null };
    }

    // The path of a listed backup file, or null (only names from the folder are allowed).
    function file(name) {
        return NAME.test(String(name)) && list().some(item => item.name === name) ? path.join(folder, name) : null;
    }

    return { start, make, daily, list, status, file };
};
