const db = require("./database/database");

db.all(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
    [],
    (error, rows) => {

        if (error) {
            console.error(error);
            return;
        }

        console.log(rows);

        db.close();
    }
);
