const db = require("./database");

db.serialize(() => {

    // ==========================================
    // ADD PRODUCTS
    // ==========================================

    db.run(`
        INSERT INTO products
        (product_name, category, description, unit, price, supplier_name)
        VALUES
        ('Purified Water', 'Water', 'Purified drinking water', 'gallon', 30, 'OLV Water Supplier')
    `);

    db.run(`
        INSERT INTO products
        (product_name, category, description, unit, price, supplier_name)
        VALUES
        ('Mineral Water', 'Water', 'Mineral drinking water', 'gallon', 35, 'OLV Water Supplier')
    `);

    // ==========================================
    // ADD INVENTORY
    // ==========================================

    db.run(`
        INSERT INTO inventory
        (product_id, quantity, minimum_stock, stock_status)
        VALUES
        (1, 20, 5, 'available')
    `);

    db.run(`
        INSERT INTO inventory
        (product_id, quantity, minimum_stock, stock_status)
        VALUES
        (2, 5, 5, 'available')
    `);

    console.log("Sample inventory added successfully.");

});

db.close((error) => {

    if (error) {

        console.error(
            "Error closing database:",
            error.message
        );

    } else {

        console.log(
            "Inventory setup complete."
        );

    }

});
