const db = require("./database");
const bcrypt = require("bcrypt");

const username = "staff";
const password = "staff123";
const fullName = "OLV Staff";
const role = "staff";

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

                console.error(
                    "Unable to create staff:",
                    error.message
                );

                return;
            }

            console.log("Staff account created successfully.");
            console.log("Username: staff");
            console.log("Password: staff123");
            console.log("Role: staff");

        }
    );

});
