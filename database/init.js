const db = require("./database");

db.serialize(() => {

    // ==========================================
    // USERS
    // ==========================================

    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            user_id INTEGER PRIMARY KEY AUTOINCREMENT,

            username TEXT NOT NULL UNIQUE,

            password TEXT NOT NULL,

            full_name TEXT NOT NULL,

            contact_number TEXT DEFAULT '',

            role TEXT NOT NULL CHECK(
                role IN ('admin', 'staff', 'driver')
            ),

            status TEXT NOT NULL
                DEFAULT 'active',

            created_at DATETIME
                DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // ==========================================
    // CUSTOMERS
    // ==========================================

    db.run(`
        CREATE TABLE IF NOT EXISTS customers (
            customer_id INTEGER PRIMARY KEY AUTOINCREMENT,

            customer_name TEXT NOT NULL,

            contact_number TEXT,

            address TEXT,

            city TEXT DEFAULT 'Legazpi City',

            barangay TEXT DEFAULT '',

            zone TEXT DEFAULT '',

            street TEXT DEFAULT '',

            house_number TEXT DEFAULT '',

            landmark TEXT DEFAULT '',

            latitude REAL,

            longitude REAL,

            customer_type TEXT NOT NULL
                DEFAULT 'Regular',

            status TEXT NOT NULL
                DEFAULT 'active',

            created_at DATETIME
                DEFAULT CURRENT_TIMESTAMP,

            updated_at DATETIME
                DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Customer accounts remain separate from employee users so that a
    // customer cannot be assigned an admin or staff role by mistake.
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
    `);

    // ==========================================
    // PRODUCTS
    // ==========================================

    db.run(`
        CREATE TABLE IF NOT EXISTS products (
            product_id INTEGER PRIMARY KEY AUTOINCREMENT,

            product_name TEXT NOT NULL,

            category TEXT NOT NULL,

            description TEXT,

            unit TEXT NOT NULL,

            price REAL DEFAULT 0,

            supplier_name TEXT DEFAULT '',

            status TEXT NOT NULL
                DEFAULT 'active',

            created_at DATETIME
                DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // ==========================================
    // INVENTORY
    // ==========================================

    db.run(`
        CREATE TABLE IF NOT EXISTS inventory (
            inventory_id INTEGER PRIMARY KEY AUTOINCREMENT,

            product_id INTEGER NOT NULL,

            quantity INTEGER NOT NULL
                DEFAULT 0,

            minimum_stock INTEGER NOT NULL
                DEFAULT 0,

            stock_status TEXT NOT NULL
                DEFAULT 'available',

            updated_at DATETIME
                DEFAULT CURRENT_TIMESTAMP,

            FOREIGN KEY (product_id)
                REFERENCES products(product_id)
        )
    `);

    // ==========================================
    // INVENTORY MOVEMENTS
    // ==========================================

    db.run(`
        CREATE TABLE IF NOT EXISTS inventory_movements (
            movement_id INTEGER PRIMARY KEY AUTOINCREMENT,

            product_id INTEGER NOT NULL,

            movement_type TEXT NOT NULL CHECK(
                movement_type IN (
                    'stock_in',
                    'stock_out',
                    'adjustment'
                )
            ),

            quantity INTEGER NOT NULL,

            reason TEXT,

            user_id INTEGER,

            created_at DATETIME
                DEFAULT CURRENT_TIMESTAMP,

            FOREIGN KEY (product_id)
                REFERENCES products(product_id),

            FOREIGN KEY (user_id)
                REFERENCES users(user_id)
        )
    `);

    // ==========================================
    // ORDERS
    // ==========================================

    db.run(`
        CREATE TABLE IF NOT EXISTS orders (
            order_id INTEGER PRIMARY KEY AUTOINCREMENT,

            customer_id INTEGER NOT NULL,

            order_date DATETIME
                DEFAULT CURRENT_TIMESTAMP,

            total_amount REAL
                DEFAULT 0,

            service_fee REAL
                DEFAULT 5,

            fulfillment_method TEXT NOT NULL
                DEFAULT 'delivery',

            status TEXT NOT NULL
                DEFAULT 'pending',

            FOREIGN KEY (customer_id)
                REFERENCES customers(customer_id)
        )
    `);

        // ==========================================
        // ORDER ITEMS
        // ==========================================

        db.run(`
            CREATE TABLE IF NOT EXISTS order_items (
                order_item_id INTEGER PRIMARY KEY AUTOINCREMENT,

                order_id INTEGER NOT NULL,

                product_id INTEGER NOT NULL,

                quantity INTEGER NOT NULL,

                unit_price REAL NOT NULL DEFAULT 0,

                subtotal REAL NOT NULL DEFAULT 0,

                FOREIGN KEY (order_id)
                    REFERENCES orders(order_id),

                FOREIGN KEY (product_id)
                    REFERENCES products(product_id)
            )
        `);

    // ==========================================
    // DELIVERY SCHEDULES
    // ==========================================

    db.run(`
        CREATE TABLE IF NOT EXISTS delivery_schedules (
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

            status TEXT NOT NULL
                DEFAULT 'scheduled',

            driver_delivered_at DATETIME,

            customer_received_at DATETIME,

            driver_latitude REAL,

            driver_longitude REAL,

            delivery_proof TEXT DEFAULT '',

            FOREIGN KEY (order_id)
                REFERENCES orders(order_id),

            FOREIGN KEY (pickup_by)
                REFERENCES users(user_id),

            FOREIGN KEY (assigned_to)
                REFERENCES users(user_id)
        );
    `);

    // ==========================================
    // ACTIVITY LOGS
    // ==========================================

    db.run(`
        CREATE TABLE IF NOT EXISTS activity_logs (
            log_id INTEGER PRIMARY KEY AUTOINCREMENT,

            user_id INTEGER,

            action TEXT NOT NULL,

            description TEXT,

            created_at DATETIME
                DEFAULT CURRENT_TIMESTAMP,

            FOREIGN KEY (user_id)
                REFERENCES users(user_id)
        )
    `);

    // ==========================================
    // REPORTS
    // ==========================================

    db.run(`
        CREATE TABLE IF NOT EXISTS reports (
            report_id INTEGER PRIMARY KEY AUTOINCREMENT,

            report_type TEXT NOT NULL,

            report_name TEXT NOT NULL,

            report_data TEXT,

            created_by INTEGER,

            created_at DATETIME
                DEFAULT CURRENT_TIMESTAMP,

            FOREIGN KEY (created_by)
                REFERENCES users(user_id)
        )
    `);

    // ==========================================
    // CHECK CUSTOMER TABLE
    // ==========================================

    db.all(
        `PRAGMA table_info(customers)`,
        [],
        (error, columns) => {

            if (error) {

                console.error(
                    "Unable to check customers table:",
                    error.message
                );

                return;
            }

            const columnNames =
                columns.map(
                    column => column.name
                );

            // ------------------------------------------
            // Check if correct customer_name column exists
            // ------------------------------------------

            const customerTableIsCorrect =
                columnNames.includes(
                    "customer_name"
                ) &&
                columnNames.includes(
                    "contact_number"
                ) &&
                columnNames.includes(
                    "address"
                ) &&
                columnNames.includes(
                    "customer_type"
                ) &&
                columnNames.includes(
                    "status"
                );

            // ------------------------------------------
            // If the old customer table exists,
            // rebuild it
            // ------------------------------------------

            if (!customerTableIsCorrect) {

                console.log(
                    "Old customers table detected."
                );

                console.log(
                    "Repairing customers table..."
                );

                db.run(
                    `PRAGMA foreign_keys = OFF`,
                    (error) => {

                        if (error) {

                            console.error(
                                "Unable to disable foreign keys:",
                                error.message
                            );

                            return;
                        }

                        // ------------------------------------------
                        // Rename old table
                        // ------------------------------------------

                        db.run(
                            `
                            ALTER TABLE customers
                            RENAME TO customers_old
                            `,
                            (error) => {

                                if (error) {

                                    console.error(
                                        "Unable to rename old customers table:",
                                        error.message
                                    );

                                    return;
                                }

                                // ------------------------------------------
                                // Create correct table
                                // ------------------------------------------

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
                                                "Unable to create repaired customers table:",
                                                error.message
                                            );

                                            return;
                                        }

                                        // ------------------------------------------
                                        // Copy old customer data if possible
                                        // ------------------------------------------

                                        let oldNameColumn =
                                            columnNames.includes(
                                                "customer_name"
                                            )
                                                ? "customer_name"
                                                : columnNames.includes(
                                                    "full_name"
                                                )
                                                    ? "full_name"
                                                    : null;

                                        if (oldNameColumn) {

                                            db.run(
                                                `
                                                INSERT INTO customers
                                                (
                                                    customer_id,
                                                    customer_name,
                                                    contact_number,
                                                    address,
                                                    customer_type,
                                                    status,
                                                    created_at
                                                )

                                                SELECT
                                                    customer_id,
                                                    ${oldNameColumn},
                                                    contact_number,
                                                    address,
                                                    'Regular',
                                                    'active',
                                                    created_at

                                                FROM customers_old
                                                `,
                                                (error) => {

                                                    if (error) {

                                                        console.error(
                                                            "Unable to copy old customer data:",
                                                            error.message
                                                        );

                                                    } else {

                                                        console.log(
                                                            "Existing customer data copied."
                                                        );

                                                    }

                                                    finishCustomerRepair();

                                                }
                                            );

                                        } else {

                                            console.log(
                                                "No compatible old customer data found."
                                            );

                                            finishCustomerRepair();

                                        }

                                        function finishCustomerRepair() {

                                            // ------------------------------------------
                                            // Remove old table
                                            // ------------------------------------------

                                            db.run(
                                                `
                                                DROP TABLE customers_old
                                                `,
                                                (error) => {

                                                    if (error) {

                                                        console.error(
                                                            "Unable to remove old customers table:",
                                                            error.message
                                                        );

                                                    } else {

                                                        console.log(
                                                            "Old customers table removed."
                                                        );

                                                    }

                                                    db.run(
                                                        `PRAGMA foreign_keys = ON`,
                                                        () => {

                                                            console.log(
                                                                "Customers table repaired successfully."
                                                            );

                                                        }
                                                    );

                                                }
                                            );

                                        }

                                    }
                                );

                            }
                        );

                    }
                );

            } else {

                console.log(
                    "Customers table structure is correct."
                );

            }

        }
    );

    // Small indexes keep the common dashboard, search, and report queries
    // responsive as the station's records grow.
    db.run(`CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(customer_name)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_orders_status_date ON orders(status, order_date)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_delivery_status_date ON delivery_schedules(status, delivery_date)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_movements_product_date ON inventory_movements(product_id, created_at)`);

    console.log("Database tables created successfully.");

});

db.close((error) => {

    if (error) {

        console.error(
            "Error closing database:",
            error.message
        );

    } else {

        console.log(
            "Database initialization complete."
        );

    }

});
