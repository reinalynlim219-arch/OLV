// Delivery planning, from the panel consultation (Standard.mp3):
//  - Batches: one trip carries at most the vehicle's capacity (e.g. 50 gallons), so
//    75 waiting gallons become batch 1 (50) and batch 2 (25). Each batch gets a
//    departure time, which is the customer's expected delivery time.
//  - Route order: inside a trip the stops are visited nearest-first from the station,
//    not first come, first serve, so the driver does not carry ten gallons three
//    kilometers for one customer while a neighbor waits. "Nearest" uses real road
//    distance (utils/roadDistances.js), or straight-line distance when that is unavailable.
//  - Walking distance: customers very close to the station (default 100 m) are carried
//    or pushed over and do not take space on the vehicle.
//  - Cash remittance: the driver records the cash collected at drop-off; the driver and
//    management both see how much is still to be handed over, and staff mark it remitted.
// Batches are worked out on request from the current queue, so they always follow
// cancellations, edits, and new orders without extra bookkeeping. The flow of an order:
// it comes in (joins the queue in arrival order) -> waits in a batch -> goes out with a
// driver -> is dropped off and leaves the plan (its cash moves to remittance).
module.exports = function deliveryPlan({ db, requireUser, readBody, sendJSON, onOutForDelivery }) {
    const run = (sql, values = []) => new Promise((resolve, reject) => db.run(sql, values, function (error) { error ? reject(error) : resolve(this); }));
    const get = (sql, values = []) => new Promise((resolve, reject) => db.get(sql, values, (error, row) => error ? reject(error) : resolve(row)));
    const all = (sql, values = []) => new Promise((resolve, reject) => db.all(sql, values, (error, rows) => error ? reject(error) : resolve(rows)));
    const roads = require("../utils/roadDistances")();

    const DEFAULTS = { vehicle_capacity: 50, first_trip: "08:00", last_trip: "17:00", trip_minutes: 60, walk_radius_m: 100, station_latitude: null, station_longitude: null };

    async function addColumn(table, column, definition) {
        const columns = await all(`PRAGMA table_info(${table})`);
        if (!columns.some(c => c.name === column)) await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }

    async function setup() {
        await run(`CREATE TABLE IF NOT EXISTS delivery_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            vehicle_capacity INTEGER NOT NULL DEFAULT 50,
            first_trip TEXT NOT NULL DEFAULT '08:00',
            last_trip TEXT NOT NULL DEFAULT '17:00',
            trip_minutes INTEGER NOT NULL DEFAULT 60,
            walk_radius_m INTEGER NOT NULL DEFAULT 100,
            station_latitude REAL,
            station_longitude REAL,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        await run("INSERT OR IGNORE INTO delivery_settings (id) VALUES (1)");
        // Cash collected on delivery and handed over to the station.
        await addColumn("delivery_schedules", "cash_collected", "REAL");
        await addColumn("delivery_schedules", "cash_collected_by", "INTEGER");
        await addColumn("delivery_schedules", "remitted_at", "DATETIME");
        await addColumn("delivery_schedules", "remitted_to", "INTEGER");
    }

    async function getSettings() {
        return { ...DEFAULTS, ...(await get("SELECT * FROM delivery_settings WHERE id = 1")) };
    }

    // ---------- time helpers (Philippine time, minutes since midnight) ----------
    const PH_OFFSET = 8 * 60 * 60 * 1000;
    const phNow = () => new Date(Date.now() + PH_OFFSET); // read with getUTC*()
    const dateKey = date => date.toISOString().slice(0, 10);
    const toMinutes = hhmm => { const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || "")); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
    const addDays = (key, days) => dateKey(new Date(Date.parse(key + "T00:00:00Z") + days * 86400000));
    // UTC "YYYY-MM-DD HH:MM:SS" from SQLite -> { day, minutes } in Philippine time.
    function fromSqlUtc(value) {
        const time = Date.parse(String(value).replace(" ", "T") + "Z");
        if (Number.isNaN(time)) return null;
        const ph = new Date(time + PH_OFFSET);
        return { day: dateKey(ph), minutes: ph.getUTCHours() * 60 + ph.getUTCMinutes() };
    }
    const slot = (day, minutes) => ({ day, minutes, iso: `${day}T${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00+08:00` });

    // ---------- distance and route ----------
    // Straight-line distance, used when road distances are not available.
    function meters(a, b) {
        const toRad = v => v * Math.PI / 180;
        const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
        return 2 * 6371000 * Math.asin(Math.sqrt(h));
    }
    const located = stop => Number.isFinite(stop.lat) && Number.isFinite(stop.lng);

    // Distances for one plan: real roads (meters and driving seconds) when the routing
    // server answers, otherwise straight lines with no driving time.
    async function distanceTable(points) {
        const unique = [...new Map(points.map(p => [roads.keyOf([p]), p])).values()];
        const index = new Map(unique.map((p, i) => [roads.keyOf([p]), i]));
        const table = await roads.matrix(unique);
        const between = (a, b) => {
            const i = index.get(roads.keyOf([a])), j = index.get(roads.keyOf([b]));
            const road = table && i != null && j != null ? table.distances[i]?.[j] : null;
            if (road != null) return { m: road, s: table.durations?.[i]?.[j] ?? null };
            return { m: meters(a, b), s: null };
        };
        return { between, source: table ? "road" : "straight" };
    }

    // Nearest-first from the start point (the station, or the first stop when the
    // station's location is not saved). Stops without a saved location go last.
    function routeOrder(stops, start, between) {
        const withLocation = stops.filter(located), without = stops.filter(s => !located(s));
        const ordered = [];
        let here = start || (withLocation[0] ? { lat: withLocation[0].lat, lng: withLocation[0].lng } : null);
        const remaining = [...withLocation];
        while (remaining.length) {
            let best = 0;
            remaining.forEach((stop, i) => { if (between(here, stop).m < between(here, remaining[best]).m) best = i; });
            const next = remaining.splice(best, 1)[0];
            const leg = between(here, next);
            next.leg_m = Math.round(leg.m);
            next.leg_s = leg.s == null ? null : Math.round(leg.s);
            ordered.push(next);
            here = next;
        }
        return [...ordered, ...without];
    }

    // Length of a trip in route order, back to the station when it is saved.
    function tripTotals(stops, station, between) {
        const route = stops.filter(located);
        if (!route.length) return { route_m: null, drive_minutes: null };
        let total = route.reduce((sum, stop) => sum + (stop.leg_m || 0), 0), seconds = route.every(stop => stop.leg_s != null) ? route.reduce((sum, stop) => sum + stop.leg_s, 0) : null;
        if (station) {
            const back = between(route[route.length - 1], station);
            total += back.m;
            seconds = seconds == null || back.s == null ? null : seconds + back.s;
        }
        return { route_m: Math.round(total), drive_minutes: seconds == null ? null : Math.max(1, Math.round(seconds / 60)) };
    }

    // ---------- the plan ----------
    async function buildPlan() {
        const settings = await getSettings();
        const station = Number.isFinite(settings.station_latitude) && Number.isFinite(settings.station_longitude)
            ? { lat: settings.station_latitude, lng: settings.station_longitude } : null;
        const capacity = Math.max(1, Number(settings.vehicle_capacity) || DEFAULTS.vehicle_capacity);
        const tripMinutes = Math.max(10, Number(settings.trip_minutes) || DEFAULTS.trip_minutes);
        const firstTrip = toMinutes(settings.first_trip) ?? toMinutes(DEFAULTS.first_trip);
        const lastTrip = Math.max(firstTrip, toMinutes(settings.last_trip) ?? toMinutes(DEFAULTS.last_trip));
        const now = phNow();
        const today = dateKey(now);
        const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();

        const rows = await all(`
            SELECT d.delivery_id, d.order_id, d.status, d.delivery_date, d.delivery_time, d.assigned_to,
                   d.delivery_address, d.delivery_items,
                   COALESCE(NULLIF(d.customer_name, ''), c.customer_name) AS customer_name,
                   COALESCE(NULLIF(d.contact_number, ''), c.contact_number) AS contact_number,
                   c.latitude, c.longitude, u.full_name AS assigned_staff, o.order_date, o.approved_at,
                   COALESCE((SELECT SUM(oi.quantity) FROM order_items oi WHERE oi.order_id = d.order_id), 0) AS gallons,
                   (SELECT MAX(t.created_at) FROM delivery_tracking t WHERE t.delivery_id = d.delivery_id AND t.status = 'out_for_delivery') AS left_at
            FROM delivery_schedules d
            LEFT JOIN orders o ON o.order_id = d.order_id
            LEFT JOIN customers c ON c.customer_id = o.customer_id
            LEFT JOIN users u ON u.user_id = d.assigned_to
            WHERE d.status IN ('scheduled', 'out_for_delivery')
            ORDER BY d.delivery_date, (COALESCE(d.delivery_time, '') = ''), d.delivery_time, d.delivery_id`);

        const stops = rows.map(row => {
            const stop = {
                delivery_id: row.delivery_id, order_id: row.order_id, status: row.status,
                delivery_date: row.delivery_date, delivery_time: row.delivery_time || "",
                customer_name: row.customer_name, contact_number: row.contact_number,
                address: row.delivery_address, items: row.delivery_items,
                gallons: Math.max(1, Number(row.gallons) || 1),
                assigned_to: row.assigned_to, assigned_staff: row.assigned_staff, left_at: row.left_at,
                // When the customer's order came in, and whether staff approved it yet
                // (deliveries added by staff without an order count as approved).
                ordered_at: row.order_date ? String(row.order_date).replace(" ", "T") + "Z" : null,
                approved: !row.order_id || Boolean(row.approved_at),
                lat: row.latitude == null ? NaN : Number(row.latitude),
                lng: row.longitude == null ? NaN : Number(row.longitude)
            };
            return stop;
        });
        // One road-distance table for the station and every stop with a saved location.
        const { between, source: distanceSource } = await distanceTable([...(station ? [station] : []), ...stops.filter(located)]);
        stops.forEach(stop => { stop.station_m = station && located(stop) ? Math.round(between(station, stop).m) : null; });

        // Trips already on the road: one per driver, each in route order.
        const tripsOut = new Map();
        stops.filter(s => s.status === "out_for_delivery").forEach(stop => {
            const key = stop.assigned_to || 0;
            if (!tripsOut.has(key)) tripsOut.set(key, { driver_id: stop.assigned_to, driver: stop.assigned_staff || "Unassigned", stops: [] });
            tripsOut.get(key).stops.push(stop);
        });
        let busyUntil = null; // when the vehicle should be back from the trip that is out now
        for (const trip of tripsOut.values()) {
            trip.stops = routeOrder(trip.stops, station, between);
            trip.gallons = trip.stops.reduce((sum, s) => sum + s.gallons, 0);
            Object.assign(trip, tripTotals(trip.stops, station, between));
            const left = trip.stops.map(s => s.left_at && fromSqlUtc(s.left_at)).filter(Boolean).sort((a, b) => a.day.localeCompare(b.day) || a.minutes - b.minutes)[0];
            if (left && left.day === today) busyUntil = Math.max(busyUntil ?? 0, left.minutes + tripMinutes);
        }

        // Waiting deliveries due today (or overdue). Later dates keep their own schedule.
        const waiting = stops.filter(s => s.status === "scheduled" && s.delivery_date <= today);
        const later = stops.filter(s => s.status === "scheduled" && s.delivery_date > today);
        const walkRadius = Math.max(0, Number(settings.walk_radius_m) || 0);
        const nearby = waiting.filter(s => s.station_m != null && s.station_m <= walkRadius);
        const vehicle = waiting.filter(s => !nearby.includes(s));

        // Fill trips in order of waiting time, so nobody is pushed back forever;
        // the route inside each trip is nearest-first.
        const groups = [];
        let current = null;
        for (const stop of vehicle) {
            if (!current || current.gallons + stop.gallons > capacity) {
                current = { gallons: 0, stops: [] };
                groups.push(current);
            }
            current.stops.push(stop);
            current.gallons += stop.gallons;
        }

        // Departure times: the next trip leaves when the vehicle is back (or now), never
        // before the first trip of the day; trips past the last trip move to the next day.
        let day = today;
        let next = Math.max(nowMinutes, firstTrip, busyUntil ?? 0);
        if (next > lastTrip) { day = addDays(today, 1); next = firstTrip; }
        const batches = groups.map((group, index) => {
            const leaves = slot(day, next);
            const back = slot(day, Math.min(next + tripMinutes, 24 * 60 - 1));
            next += tripMinutes;
            if (next > lastTrip) { day = addDays(day, 1); next = firstTrip; }
            const ordered = routeOrder(group.stops, station, between);
            return {
                number: index + 1, gallons: group.gallons, capacity,
                over_capacity: group.gallons > capacity,
                leaves_at: leaves.iso, back_by: back.iso,
                stops: ordered, ...tripTotals(ordered, station, between)
            };
        });
        // Nearby customers are walked over when the next trip leaves.
        const nearbyWindow = { leaves_at: batches[0] ? batches[0].leaves_at : slot(day, next).iso };

        // Orders in and out today (Philippine dates): delivery orders that came in, and
        // deliveries dropped off. The middle of the flow comes from the plan itself.
        const flowToday = await get(`SELECT
            (SELECT COUNT(*) FROM orders WHERE fulfillment_method = 'delivery' AND date(order_date, '+8 hours') = ?) AS came_in,
            (SELECT COUNT(*) FROM delivery_schedules WHERE status IN ('awaiting_customer', 'delivered')
                AND date(COALESCE(driver_delivered_at, customer_received_at), '+8 hours') = ?) AS dropped_off`, [today, today]);
        const queued = [...vehicle, ...nearby];
        const flow = {
            came_in: Number(flowToday?.came_in) || 0,
            waiting: queued.length,
            waiting_gallons: queued.reduce((sum, s) => sum + s.gallons, 0),
            not_approved: queued.filter(s => !s.approved).length,
            on_the_road: stops.filter(s => s.status === "out_for_delivery").length,
            dropped_off: Number(flowToday?.dropped_off) || 0,
            later: later.length
        };

        const clean = stop => { const { lat, lng, left_at, ...rest } = stop; return { ...rest, has_location: located(stop), latitude: located(stop) ? lat : null, longitude: located(stop) ? lng : null }; };
        return {
            settings: { ...settings, station_saved: Boolean(station) },
            flow,
            distance_source: distanceSource, // "road" (OpenStreetMap roads) or "straight" (fallback)
            generated_at: new Date().toISOString(),
            trips_out: [...tripsOut.values()].map(trip => ({ ...trip, stops: trip.stops.map(clean) })),
            batches: batches.map(batch => ({ ...batch, stops: batch.stops.map(clean) })),
            nearby: { ...nearbyWindow, radius_m: walkRadius, stops: routeOrder(nearby, station, between).map(clean) },
            later: later.map(clean)
        };
    }

    // Expected delivery for each waiting or outgoing delivery, for the customer portal.
    async function etaByDelivery() {
        const plan = await buildPlan();
        const map = new Map();
        plan.trips_out.forEach(trip => trip.stops.forEach((stop, index) => map.set(stop.delivery_id, { kind: "on_the_way", stop_number: index + 1, stops: trip.stops.length })));
        plan.batches.forEach(batch => batch.stops.forEach(stop => map.set(stop.delivery_id, stop.delivery_time
            ? { kind: "scheduled_time", date: stop.delivery_date, time: stop.delivery_time }
            : { kind: "batch", batch: batch.number, from: batch.leaves_at, to: batch.back_by })));
        plan.nearby.stops.forEach(stop => map.set(stop.delivery_id, { kind: "nearby", from: plan.nearby.leaves_at }));
        plan.later.forEach(stop => map.set(stop.delivery_id, { kind: "scheduled_time", date: stop.delivery_date, time: stop.delivery_time }));
        return map;
    }

    // ---------- requests ----------
    const ADMIN_STAFF = ["admin", "staff"];
    const DELIVERY_ROLES = ["admin", "staff", "driver"];

    async function handle(req, res, url) {
        const user = requireUser(req, res);
        if (!user) return;
        try {
            if (req.method === "GET" && url === "/api/deliveries/plan") {
                if (!DELIVERY_ROLES.includes(user.role)) return sendJSON(res, 403, { success: false, message: "Only delivery staff can view the delivery sequence." });
                const plan = await buildPlan();
                // Drivers see the open batches and their own trip, not other drivers' trips.
                if (user.role === "driver") plan.trips_out = plan.trips_out.filter(trip => Number(trip.driver_id) === Number(user.user_id));
                return sendJSON(res, 200, { success: true, role: user.role, ...plan });
            }

            if (req.method === "PUT" && url === "/api/deliveries/settings") {
                if (user.role !== "admin") return sendJSON(res, 403, { success: false, message: "Only the admin can change delivery settings." });
                const data = await new Promise((resolve, reject) => readBody(req, (error, body) => error ? reject(error) : resolve(body || {})));
                const capacity = Number(data.vehicle_capacity), trip = Number(data.trip_minutes), walk = Number(data.walk_radius_m);
                const first = String(data.first_trip || ""), last = String(data.last_trip || "");
                if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1000) return sendJSON(res, 400, { success: false, message: "Vehicle capacity must be a whole number from 1 to 1000 gallons." });
                if (!Number.isInteger(trip) || trip < 10 || trip > 600) return sendJSON(res, 400, { success: false, message: "Minutes per trip must be from 10 to 600." });
                if (!Number.isInteger(walk) || walk < 0 || walk > 1000) return sendJSON(res, 400, { success: false, message: "Walking distance must be from 0 to 1000 meters." });
                if (toMinutes(first) == null || toMinutes(last) == null || toMinutes(last) < toMinutes(first)) return sendJSON(res, 400, { success: false, message: "Enter the first and last trip times, with the last trip after the first." });
                let lat = data.station_latitude, lng = data.station_longitude;
                if (lat === "" || lat == null || lng === "" || lng == null) { lat = null; lng = null; }
                else {
                    lat = Number(lat); lng = Number(lng);
                    // Same area check as customer locations: Legazpi City and Daraga.
                    if (!(lat >= 12.95 && lat <= 13.30 && lng >= 123.55 && lng <= 123.90)) return sendJSON(res, 400, { success: false, message: "The station location must be in Legazpi City or Daraga. Copy it from Google Maps (for example 13.1447, 123.7466) or use this phone's location at the station." });
                }
                await run(`UPDATE delivery_settings SET vehicle_capacity = ?, first_trip = ?, last_trip = ?, trip_minutes = ?, walk_radius_m = ?,
                    station_latitude = ?, station_longitude = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`,
                    [capacity, first.slice(0, 5), last.slice(0, 5), trip, walk, lat, lng]);
                return sendJSON(res, 200, { success: true, message: "Delivery settings saved." });
            }

            // Take (driver) or send out (admin/staff, to a chosen driver) a whole batch at once.
            if (req.method === "POST" && url === "/api/deliveries/plan/start-batch") {
                if (!DELIVERY_ROLES.includes(user.role)) return sendJSON(res, 403, { success: false, message: "Only delivery staff can start deliveries." });
                const data = await new Promise((resolve, reject) => readBody(req, (error, body) => error ? reject(error) : resolve(body || {})));
                const ids = Array.isArray(data.delivery_ids) ? [...new Set(data.delivery_ids.map(Number))].filter(id => Number.isSafeInteger(id) && id > 0) : [];
                if (!ids.length || ids.length > 200) return sendJSON(res, 400, { success: false, message: "Choose a batch to start." });
                let driverId = user.user_id;
                if (user.role !== "driver" && data.assigned_to) {
                    const person = await get("SELECT user_id FROM users WHERE user_id = ? AND status = 'active' AND role IN ('admin', 'staff', 'driver')", [Number(data.assigned_to)]);
                    if (!person) return sendJSON(res, 400, { success: false, message: "Choose an active driver or staff member." });
                    driverId = person.user_id;
                }
                const started = [];
                for (const id of ids) {
                    // Same rule as starting one delivery: a driver takes open ones or their own.
                    const result = await run(`UPDATE delivery_schedules SET status = 'out_for_delivery', assigned_to = ?
                        WHERE delivery_id = ? AND status = 'scheduled' AND (? <> 'driver' OR assigned_to = ? OR assigned_to IS NULL)`,
                        [driverId, id, user.role, user.user_id]);
                    if (result.changes) { started.push(id); onOutForDelivery(id); }
                }
                if (!started.length) return sendJSON(res, 409, { success: false, message: "These deliveries were already started or taken by someone else. Refresh the plan." });
                const skipped = ids.length - started.length;
                return sendJSON(res, 200, { success: true, started: started.length, message: `${started.length} ${started.length === 1 ? "delivery is" : "deliveries are"} now out for delivery.${skipped ? ` ${skipped} could not be started because someone else already took them.` : ""}` });
            }

            if (req.method === "GET" && url === "/api/remittance") {
                if (!DELIVERY_ROLES.includes(user.role)) return sendJSON(res, 403, { success: false, message: "Only delivery staff can view cash remittance." });
                const forDriver = user.role === "driver";
                const pending = await all(`
                    SELECT d.delivery_id, d.cash_collected, d.driver_delivered_at, d.cash_collected_by AS driver_id,
                           COALESCE(NULLIF(d.customer_name, ''), c.customer_name) AS customer_name, u.full_name AS driver
                    FROM delivery_schedules d
                    LEFT JOIN orders o ON o.order_id = d.order_id
                    LEFT JOIN customers c ON c.customer_id = o.customer_id
                    LEFT JOIN users u ON u.user_id = d.cash_collected_by
                    WHERE d.cash_collected > 0 AND d.remitted_at IS NULL AND (? = 0 OR d.cash_collected_by = ?)
                    ORDER BY d.driver_delivered_at`, [forDriver ? 1 : 0, user.user_id]);
                const recent = await all(`
                    SELECT u.full_name AS driver, r.full_name AS received_by, d.remitted_at, SUM(d.cash_collected) AS amount, COUNT(*) AS deliveries
                    FROM delivery_schedules d
                    LEFT JOIN users u ON u.user_id = d.cash_collected_by
                    LEFT JOIN users r ON r.user_id = d.remitted_to
                    WHERE d.remitted_at IS NOT NULL AND d.remitted_at >= datetime('now', '-7 days') AND (? = 0 OR d.cash_collected_by = ?)
                    GROUP BY d.cash_collected_by, d.remitted_at ORDER BY d.remitted_at DESC LIMIT 20`, [forDriver ? 1 : 0, user.user_id]);
                const drivers = new Map();
                pending.forEach(row => {
                    const key = row.driver_id || 0;
                    if (!drivers.has(key)) drivers.set(key, { driver_id: row.driver_id, driver: row.driver || "Unknown driver", amount: 0, deliveries: [] });
                    const entry = drivers.get(key);
                    entry.amount += Number(row.cash_collected);
                    entry.deliveries.push({ delivery_id: row.delivery_id, customer_name: row.customer_name, amount: row.cash_collected, dropped_off_at: row.driver_delivered_at });
                });
                return sendJSON(res, 200, { success: true, role: user.role, drivers: [...drivers.values()], recent });
            }

            if (req.method === "PUT" && url === "/api/remittance/remit") {
                if (!ADMIN_STAFF.includes(user.role)) return sendJSON(res, 403, { success: false, message: "Only admin or staff can receive a driver's remittance." });
                const data = await new Promise((resolve, reject) => readBody(req, (error, body) => error ? reject(error) : resolve(body || {})));
                const driverId = Number(data.driver_id);
                if (!Number.isSafeInteger(driverId) || driverId < 1) return sendJSON(res, 400, { success: false, message: "Choose the driver who is remitting." });
                // Only the amount the staff member saw is marked, so cash collected a moment
                // later is not marked remitted by accident.
                const ids = Array.isArray(data.delivery_ids) ? data.delivery_ids.map(Number).filter(id => Number.isSafeInteger(id) && id > 0) : [];
                if (!ids.length) return sendJSON(res, 400, { success: false, message: "There is nothing to remit for this driver." });
                const marks = ids.map(() => "?").join(",");
                const total = await get(`SELECT COALESCE(SUM(cash_collected), 0) AS amount, COUNT(*) AS count FROM delivery_schedules
                    WHERE delivery_id IN (${marks}) AND cash_collected_by = ? AND remitted_at IS NULL AND cash_collected > 0`, [...ids, driverId]);
                if (!total.count) return sendJSON(res, 409, { success: false, message: "There is no cash waiting to be remitted from this driver for these deliveries (it may already be marked as received). Refresh the list." });
                await run(`UPDATE delivery_schedules SET remitted_at = CURRENT_TIMESTAMP, remitted_to = ?
                    WHERE delivery_id IN (${marks}) AND cash_collected_by = ? AND remitted_at IS NULL AND cash_collected > 0`, [user.user_id, ...ids, driverId]);
                return sendJSON(res, 200, { success: true, amount: total.amount, message: `Remittance of ₱${Number(total.amount).toLocaleString("en-PH", { minimumFractionDigits: 2 })} from ${total.count} ${total.count === 1 ? "delivery" : "deliveries"} received.` });
            }

            sendJSON(res, 404, { success: false, message: "Not found." });
        } catch (error) {
            console.error("Delivery plan error:", error);
            sendJSON(res, error instanceof SyntaxError ? 400 : 500, { success: false, message: error instanceof SyntaxError ? "Invalid request." : "Unable to process the delivery sequence. Try again." });
        }
    }

    const ROUTES = ["/api/deliveries/plan", "/api/deliveries/settings", "/api/deliveries/plan/start-batch", "/api/remittance", "/api/remittance/remit"];
    return { setup, handle, etaByDelivery, ROUTES };
};
