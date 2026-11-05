const db = require("./database");

console.log("Starting customer table repair...");

db.serialize(() => {

    // ==========================================
    // DISABLE FOREIGN KEYS TEMPORARILY
    // ==========================================

    db.run(
        `PRAGMA foreign_keys = OFF`,
        (error) => {

            if (error) {

                console.error(
                    "Unable to disable foreign keys:",
                    error.message
                );

                closeDatabase();
                return;
            }

            console.log(
                "Foreign keys temporarily disabled."
            );

            // ==========================================
            // REMOVE OLD CUSTOMERS TABLE
            // ==========================================

            db.run(
                `DROP TABLE IF EXISTS customers`,
                (error) => {

                    if (error) {

                        console.error(
                            "Unable to remove old customers table:",
                            error.message
                        );

                        closeDatabase();
                        return;
                    }

                    console.log(
                        "Old customers table removed."
                    );

                    // ==========================================
                    // CREATE CORRECT CUSTOMERS TABLE
                    // ==========================================

                    db.run(
                        `
                        CREATE TABLE customers (

                            customer_id
                                INTEGER PRIMARY KEY AUTOINCREMENT,

                            customer_name
                                TEXT NOT NULL,

                            contact_number
                                TEXT,

                            address
                                TEXT,

                            city TEXT DEFAULT 'Legazpi City',
                            barangay TEXT DEFAULT '',
                            zone TEXT DEFAULT '',
                            street TEXT DEFAULT '',
                            house_number TEXT DEFAULT '',
                            landmark TEXT DEFAULT '',
                            latitude REAL,
                            longitude REAL,

                            customer_type
                                TEXT NOT NULL
                                DEFAULT 'Regular',

                            status
                                TEXT NOT NULL
                                DEFAULT 'active',

                            created_at
                                DATETIME
                                DEFAULT CURRENT_TIMESTAMP,

                            updated_at
                                DATETIME
                                DEFAULT CURRENT_TIMESTAMP

                        )
                        `,
                        (error) => {

                            if (error) {

                                console.error(
                                    "Unable to create customers table:",
                                    error.message
                                );

                                closeDatabase();
                                return;
                            }

                            console.log(
                                "Customers table created successfully."
                            );

                            // ==========================================
                            // ENABLE FOREIGN KEYS AGAIN
                            // ==========================================

                            db.run(
                                `PRAGMA foreign_keys = ON`,
                                (error) => {

                                    if (error) {

                                        console.error(
                                            "Unable to enable foreign keys:",
                                            error.message
                                        );

                                    } else {

                                        console.log(
                                            "Foreign keys enabled."
                                        );

                                    }

                                    console.log(
                                        "Customer table repair complete."
                                    );

                                    closeDatabase();

                                }
                            );

                        }
                    );

                }
            );

        }
    );

});

// ==========================================
// CLOSE DATABASE
// ==========================================

function closeDatabase() {

    db.close((error) => {

        if (error) {

            console.error(
                "Error closing database:",
                error.message
            );

        } else {

            console.log(
                "Database connection closed."
            );

        }

    });

}
