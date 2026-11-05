// ==========================================
// NOT SIGNED IN
// A browser opening a page (e.g. /dashboard from a bookmark) is sent to the
// sign-in page; data requests (/api/...) get the usual 401 message.
// ==========================================

function notSignedIn(req, res, message) {
    const url = String(req.url || "").split("?")[0];
    const opensPage = req.method === "GET" && !url.startsWith("/api/") && /text\/html/.test(String(req.headers.accept || ""));
    if (opensPage) {
        res.writeHead(302, { Location: "/login", "Cache-Control": "no-store" });
        res.end();
        return null;
    }
    res.writeHead(401, {
        "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
        success: false,
        message
    }));
    return null;
}
// ==========================================
// LOGIN CHECK
// ==========================================

function requireLogin(sessions, req, res, sessionExpiry) {

    const cookies = req.headers.cookie || "";

    const sessionCookie = cookies
        .split(";")
        .find(cookie =>
            cookie.trim().startsWith("sessionId=")
        );

    // No login session
    if (!sessionCookie) {

        return notSignedIn(req, res, "Access denied. Please login first.");
    }

    const sessionId =
        sessionCookie
            .split("=")[1];

    const user = sessions.get(sessionId);

    // Invalid session
    if (!user) {

        return notSignedIn(req, res, "Access denied. Invalid session.");
    }

    // Check session expiration
    if (sessionExpiry && sessionExpiry.has(sessionId)) {
        const expiry = sessionExpiry.get(sessionId);
        if (Date.now() > expiry) {
            sessions.delete(sessionId);
            sessionExpiry.delete(sessionId);

            return notSignedIn(req, res, "Session expired. Please login again.");
        }
    }

    return user;
}

// ==========================================
// ADMIN CHECK
// ==========================================

function requireAdmin(sessions, req, res, sessionExpiry) {

    const user = requireLogin(
        sessions,
        req,
        res,
        sessionExpiry
    );

    if (!user) {
        return null;
    }

    // Staff or other non-admin user
    if (user.role !== "admin") {

        res.writeHead(403, {
            "Content-Type": "application/json"
        });

        res.end(JSON.stringify({
            success: false,
            message: "Access denied. Admins only."
        }));

        return null;
    }

    return user;
}

// ==========================================
// EXPORT FUNCTIONS
// ==========================================

module.exports = {
    requireLogin,
    requireAdmin
};
