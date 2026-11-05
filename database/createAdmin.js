const db = require("./database");
const bcrypt = require("bcrypt");

const username = "admin";
const password = "admin123";
const fullName = "System Administrator";
const role = "admin";

bcrypt.hash(password, 10, (error, hashedPassword) => {

    if (error) {
        console.error("Password encryption failed:", error.message);
        return;
    }

    const sql = `
        INSERT INTO users
        (username, password, full_name, role)
        VALUES (?, ?, ?, ?)
    `;

    db.run(
        sql,
        [username, hashedPassword, fullName, role],
        function (error) {

            if (error) {
                console.error("Unable to create admin:", error.message);
                return;
            }

            console.log("Admin account created successfully.");
            console.log("Username: admin");
            console.log("Password: admin123");
        }
    );
});
