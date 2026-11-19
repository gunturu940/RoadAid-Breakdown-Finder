require("dotenv").config();
const express = require("express"), cors = require("cors"), http = require("http"), mysql = require("mysql2/promise");
const { Server } = require("socket.io"), bcrypt = require("bcryptjs"), jwt = require("jsonwebtoken");
const SECRET = process.env.JWT_SECRET || "dev-secret";
const cfg = { host: process.env.DB_HOST || "localhost", user: process.env.DB_USER || "root", password: process.env.DB_PASSWORD || "" };
const ISSUES = ["tyre", "battery", "towing", "fuel", "engine", "emergency"], VEHICLES = ["Car", "Bike", "Auto", "Truck"];
const BASE = { tyre: 200, battery: 300, fuel: 150, engine: 400, towing: 600, emergency: 500 };
const estimate = (issue, km) => Math.round(BASE[issue] + km * 10); // base charge + Rs.10 per km
let db;

const app = express(); app.use(cors(), express.json());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const ping = () => io.emit("refresh");                        // reload all open dashboards
const notify = (room, msg) => io.to(room).emit("notify", msg); // popup to one user or one role
io.on("connection", (s) => s.on("join", (token) => {
  try { const u = jwt.verify(token, SECRET); s.join("u" + u.id); s.join(u.role); } catch { /* ignore */ }
}));

const kmBetween = (a, b, c, d) => { const R = Math.PI / 180;
  return 6371 * Math.acos(Math.min(1, Math.cos(a * R) * Math.cos(c * R) * Math.cos((b - d) * R) + Math.sin(a * R) * Math.sin(c * R))); };

async function init() {
  const c = await mysql.createConnection(cfg);
  await c.query("CREATE DATABASE IF NOT EXISTS breakdown"); await c.end();
  db = mysql.createPool({ ...cfg, database: "breakdown" });
  await db.query(`CREATE TABLE IF NOT EXISTS users(
    id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100), phone VARCHAR(20), email VARCHAR(100) UNIQUE,
    password VARCHAR(100), role ENUM('driver','mechanic','admin'), services VARCHAR(200), lng DOUBLE, lat DOUBLE)`);
  await db.query(`CREATE TABLE IF NOT EXISTS requests(
    id INT AUTO_INCREMENT PRIMARY KEY, driver_id INT, mechanic_id INT NULL, vehicle VARCHAR(30), issue VARCHAR(30),
    notes VARCHAR(255), lng DOUBLE, lat DOUBLE, status ENUM('open','accepted','completed') DEFAULT 'open',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await db.query("ALTER TABLE users MODIFY role ENUM('driver','mechanic','admin')");
  for (const q of ["ALTER TABLE requests ADD COLUMN rating TINYINT NULL", "ALTER TABLE requests ADD COLUMN fare INT NULL",
    "ALTER TABLE users ADD COLUMN available TINYINT DEFAULT 1"]) { try { await db.query(q); } catch { /* already exists */ } }
  const email = process.env.ADMIN_EMAIL || "admin@roadaid.com";
  const [[a]] = await db.query("SELECT id FROM users WHERE email=?", [email]);
  if (!a) await db.query("INSERT INTO users(name,phone,email,password,role,services,lng,lat) VALUES('Admin','0000000000',?,?,'admin','',0,0)",
    [email, await bcrypt.hash(process.env.ADMIN_PASSWORD || "admin123", 10)]);
  server.listen(process.env.PORT || 5000, () => console.log("MySQL connected. API + Socket.io on :5000"));
}

const dist = (t) => `(6371*ACOS(LEAST(1,COS(RADIANS(?))*COS(RADIANS(${t}.lat))*COS(RADIANS(${t}.lng)-RADIANS(?))+SIN(RADIANS(?))*SIN(RADIANS(${t}.lat)))))`;
const userShape = (r) => ({ _id: r.id, name: r.name, phone: r.phone, km: r.km, rating: r.rating,
  services: r.services ? r.services.split(",") : [], location: { coordinates: [r.lng, r.lat] } });
const reqShape = (r) => ({ _id: r.id, vehicle: r.vehicle, issue: r.issue, notes: r.notes, status: r.status, km: r.km, rating: r.rating,
  fare: r.fare, at: r.created_at, location: { coordinates: [r.lng, r.lat] },
  mechanic: r.mname ? { name: r.mname, phone: r.mphone } : null, driver: r.dname ? { name: r.dname, phone: r.dphone } : undefined });

const w = (fn) => (req, res) => fn(req, res).catch((e) => res.status(500).json({ error: e.message }));
const auth = (role) => (req, res, next) => {
  try { req.user = jwt.verify((req.headers.authorization || "").replace("Bearer ", ""), SECRET); }
  catch { return res.status(401).json({ error: "Please log in again" }); }
  if (role && req.user.role !== role) return res.status(403).json({ error: "Not allowed for your role" });
  next();
};
const sign = (u) => ({ token: jwt.sign({ id: u.id, role: u.role, name: u.name }, SECRET), user: { name: u.name, role: u.role } });

app.post("/api/register", async (req, res) => {
  try {
    const { name, phone, email, password, role, services = [], lng = 0, lat = 0 } = req.body;
    if (!name || !/^\d{10}$/.test(phone || "") || !/^\S+@\S+\.\S+$/.test(email || "") || (password || "").length < 6 || !["driver", "mechanic"].includes(role))
      return res.status(400).json({ error: "Enter name, 10-digit phone, valid email and a password of at least 6 characters" });
    if (role === "mechanic" && !services.filter(Boolean).length) return res.status(400).json({ error: "Mechanics must list at least one service" });
    const [r] = await db.query("INSERT INTO users(name,phone,email,password,role,services,lng,lat) VALUES(?,?,?,?,?,?,?,?)",
      [name, phone, email, await bcrypt.hash(password, 10), role, services.filter(Boolean).join(","), lng, lat]);
    res.json(sign({ id: r.insertId, role, name }));
  } catch (e) { res.status(400).json({ error: e.code === "ER_DUP_ENTRY" ? "Email already registered" : e.message }); }
});
app.post("/api/login", w(async (req, res) => {
  const [[u]] = await db.query("SELECT * FROM users WHERE email=?", [req.body.email]);
  if (!u || !(await bcrypt.compare(req.body.password, u.password))) return res.status(400).json({ error: "Wrong email or password" });
  res.json(sign(u));
}));

// ---------- Driver ----------
app.get("/api/mechanics", auth("driver"), w(async (req, res) => {
  const { lng, lat, km = 20, service } = req.query;
  const filter = service && service !== "emergency";
  const [rows] = await db.query(
    `SELECT u.*, ${dist("u")} AS km, (SELECT ROUND(AVG(rating),1) FROM requests WHERE mechanic_id=u.id) AS rating
     FROM users u WHERE role='mechanic' AND available=1 ${filter ? "AND FIND_IN_SET(?,services)" : ""} HAVING km<=? ORDER BY km LIMIT 20`,
    [lat, lng, lat, ...(filter ? [service] : []), +km]);
  res.json(rows.map((r) => ({ ...userShape(r), fare: BASE[service] ? estimate(service, r.km) : null })));
}));
app.post("/api/requests", auth("driver"), w(async (req, res) => {
  const { vehicle, issue, notes, lng, lat } = req.body;
  if (!VEHICLES.includes(vehicle) || !ISSUES.includes(issue) || !isFinite(lng) || !isFinite(lat)) return res.status(400).json({ error: "Invalid request details" });
  const [r] = await db.query("INSERT INTO requests(driver_id,vehicle,issue,notes,lng,lat) VALUES(?,?,?,?,?,?)",
    [req.user.id, vehicle, issue, (notes || "").slice(0, 250), lng, lat]);
  notify("mechanic", issue === "emergency" ? `🚨 SOS: ${vehicle} driver needs urgent help` : `New ${issue} request (${vehicle})`);
  ping(); res.json({ _id: r.insertId });
}));
app.get("/api/requests/mine", auth("driver"), w(async (req, res) => {
  const [rows] = await db.query(`SELECT r.*, m.name mname, m.phone mphone FROM requests r
    LEFT JOIN users m ON m.id=r.mechanic_id WHERE r.driver_id=? ORDER BY r.id DESC`, [req.user.id]);
  res.json(rows.map(reqShape));
}));
app.patch("/api/requests/:id/rate", auth("driver"), w(async (req, res) => {
  const n = +req.body.rating;
  if (!(n >= 1 && n <= 5)) return res.status(400).json({ error: "Rating must be 1 to 5" });
  const [r] = await db.query("UPDATE requests SET rating=? WHERE id=? AND driver_id=? AND status='completed' AND rating IS NULL", [n, req.params.id, req.user.id]);
  if (!r.affectedRows) return res.status(400).json({ error: "Cannot rate this request" });
  ping(); res.json({ ok: true });
}));

// ---------- Mechanic ----------
app.get("/api/mechanic/status", auth("mechanic"), w(async (req, res) => {
  const [[u]] = await db.query("SELECT available FROM users WHERE id=?", [req.user.id]); res.json({ available: !!u.available });
}));
app.patch("/api/mechanic/status", auth("mechanic"), w(async (req, res) => {
  await db.query("UPDATE users SET available=? WHERE id=?", [req.body.available ? 1 : 0, req.user.id]); res.json({ ok: true });
}));
app.get("/api/requests/nearby", auth("mechanic"), w(async (req, res) => {
  const { lng, lat, km = 25 } = req.query;
  const [rows] = await db.query(`SELECT r.*, d.name dname, d.phone dphone, ${dist("r")} AS km FROM requests r
    JOIN users d ON d.id=r.driver_id WHERE r.status='open' HAVING km<=? ORDER BY (r.issue='emergency') DESC, km`, [lat, lng, lat, +km]);
  res.json(rows.map(reqShape));
}));
app.get("/api/requests/accepted", auth("mechanic"), w(async (req, res) => {
  const [rows] = await db.query(`SELECT r.*, d.name dname, d.phone dphone FROM requests r
    JOIN users d ON d.id=r.driver_id WHERE r.mechanic_id=? AND r.status='accepted' ORDER BY r.id DESC`, [req.user.id]);
  res.json(rows.map(reqShape));
}));
app.get("/api/requests/history", auth("mechanic"), w(async (req, res) => {
  const [rows] = await db.query(`SELECT r.*, d.name dname, d.phone dphone FROM requests r
    JOIN users d ON d.id=r.driver_id WHERE r.mechanic_id=? AND r.status='completed' ORDER BY r.id DESC`, [req.user.id]);
  res.json({ jobs: rows.map(reqShape), earnings: rows.reduce((s, r) => s + (r.fare || 0), 0) });
}));
app.patch("/api/requests/:id/accept", auth("mechanic"), w(async (req, res) => {
  const [[rq]] = await db.query("SELECT * FROM requests WHERE id=? AND status='open'", [req.params.id]);
  if (!rq) return res.status(409).json({ error: "Request already taken" });
  const [[m]] = await db.query("SELECT lng,lat FROM users WHERE id=?", [req.user.id]);
  const fare = estimate(rq.issue, kmBetween(m.lat, m.lng, rq.lat, rq.lng));
  const [r] = await db.query("UPDATE requests SET status='accepted', mechanic_id=?, fare=? WHERE id=? AND status='open'", [req.user.id, fare, rq.id]);
  if (!r.affectedRows) return res.status(409).json({ error: "Request already taken" });
  notify("u" + rq.driver_id, `✅ ${req.user.name} accepted your request. Estimated fare ₹${fare}`);
  ping(); res.json({ ok: true });
}));
app.patch("/api/requests/:id/complete", auth("mechanic"), w(async (req, res) => {
  const [[rq]] = await db.query("SELECT driver_id FROM requests WHERE id=? AND mechanic_id=?", [req.params.id, req.user.id]);
  if (!rq) return res.status(404).json({ error: "Request not found" });
  await db.query("UPDATE requests SET status='completed' WHERE id=?", [req.params.id]);
  notify("u" + rq.driver_id, "🎉 Service completed. Please rate your mechanic.");
  ping(); res.json({ ok: true });
}));

// ---------- Admin ----------
app.get("/api/admin/stats", auth("admin"), w(async (req, res) => {
  const [u] = await db.query("SELECT role, COUNT(*) n FROM users GROUP BY role");
  const [q] = await db.query("SELECT status, COUNT(*) n FROM requests GROUP BY status");
  const [[a]] = await db.query("SELECT ROUND(AVG(rating),1) avg, COALESCE(SUM(CASE WHEN status='completed' THEN fare END),0) rev FROM requests");
  const c = (arr, k, f) => +((arr.find((x) => x[k] === f) || {}).n || 0);
  res.json({ drivers: c(u, "role", "driver"), mechanics: c(u, "role", "mechanic"), open: c(q, "status", "open"), accepted: c(q, "status", "accepted"),
    completed: c(q, "status", "completed"), total: q.reduce((s, x) => s + +x.n, 0), avgRating: a.avg, revenue: +a.rev });
}));
app.get("/api/admin/users", auth("admin"), w(async (req, res) => {
  const [rows] = await db.query("SELECT id,name,phone,email,role,services,available FROM users ORDER BY id DESC"); res.json(rows);
}));
app.get("/api/admin/requests", auth("admin"), w(async (req, res) => {
  const [rows] = await db.query(`SELECT r.id,r.vehicle,r.issue,r.status,r.fare,r.rating,r.created_at, d.name dname, m.name mname FROM requests r
    LEFT JOIN users d ON d.id=r.driver_id LEFT JOIN users m ON m.id=r.mechanic_id ORDER BY r.id DESC LIMIT 100`); res.json(rows);
}));
app.delete("/api/admin/users/:id", auth("admin"), w(async (req, res) => {
  await db.query("DELETE FROM users WHERE id=? AND role<>'admin'", [req.params.id]); ping(); res.json({ ok: true });
}));

init().catch((e) => { console.error("MySQL connection failed:", e.message); process.exit(1); });
