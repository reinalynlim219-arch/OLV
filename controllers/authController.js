const db = require("../database/database");
const bcrypt = require("bcrypt");

function login(username, password, callback) {

    const sql = `
        SELECT *
        FROM users
        WHERE username = ?
        AND status = 'active'
    `;

    db.get(sql, [username], async (error, user) => {

        if (error) {
            callback(error, null);
            return;
        }

        if (!user) {
            loginCustomer(username, password, callback);
            return;
        }

        try {

            const passwordMatch = await bcrypt.compare(
                password,
                user.password
            );

            if (!passwordMatch) {
                callback(null, {
                    success: false,
                    message: "Invalid username or password."
                });

                return;
            }

            callback(null, {
                success: true,

                user: {
                    user_id: user.user_id,
                    username: user.username,
                    full_name: user.full_name,
                    role: user.role
                }
            });

        } catch (error) {

            callback(error, null);

        }
    });
}

function loginCustomer(username, password, callback) {
    db.get(`
        SELECT customer_accounts.account_id, customer_accounts.username,
               customer_accounts.password, customers.customer_id,
               customers.customer_name
        FROM customer_accounts
        INNER JOIN customers ON customers.customer_id = customer_accounts.customer_id
        WHERE customer_accounts.username = ?
          AND customer_accounts.status = 'active'
          AND customers.status = 'active'
    `, [username], async (error, account) => {
        if (error) return callback(error, null);
        if (!account) return callback(null, { success: false, message: "Invalid username or password." });

        try {
            if (!await bcrypt.compare(password, account.password)) {
                return callback(null, { success: false, message: "Invalid username or password." });
            }
            callback(null, {
                success: true,
                user: {
                    user_id: `customer-${account.account_id}`,
                    customer_id: account.customer_id,
                    username: account.username,
                    full_name: account.customer_name,
                    role: "customer"
                }
            });
        } catch (compareError) {
            callback(compareError, null);
        }
    });
}

module.exports = {
    login
};
