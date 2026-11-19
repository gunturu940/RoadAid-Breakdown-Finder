import { useState, useEffect, useCallback, useRef } from "react";
import L from "leaflet";
import { io } from "socket.io-client";
const HOST = "http://localhost:5000", API = HOST + "/api";
const api = async (path, method = "GET", body, token) => {
  const r = await fetch(API + path, { method, headers: { "Content-Type": "application/json", ...(token && { Authorization: "Bearer " + token }) }, body: body && JSON.stringify(body) });
  const d = await r.json();
  if (r.status === 401) { localStorage.removeItem("session"); location.reload(); }
  if (!r.ok) throw new Error(d.error || "Something went wrong"); return d;
};
const DEFAULT_POS = { lng: 78.4867, lat: 17.385 };
const getPos = () => new Promise((res) => {
  if (!navigator.geolocation) return res(DEFAULT_POS);
  navigator.geolocation.getCurrentPosition(p => res({ lng: p.coords.longitude, lat: p.coords.latitude }), () => res(DEFAULT_POS), { timeout: 6000 });
});
const mapLink = (c) => `https://www.google.com/maps?q=${c[1]},${c[0]}`;
const ISSUES = [["tyre", "🛞"], ["battery", "🔋"], ["fuel", "⛽"], ["engine", "⚙️"], ["towing", "🚛"]];
const VEHICLES = [["Car", "🚗"], ["Bike", "🏍️"], ["Auto", "🛺"], ["Truck", "🚚"]];
const ico = (k) => (ISSUES.find(i => i[0] === k) || [0, "🚨"])[1];
const money = (n) => (n == null ? "" : "₹" + n);
const Stars = ({ r }) => (r == null ? null : <span className="rate"> ★ {r}</span>);
const Sos = ({ r }) => (r.issue === "emergency" ? <span className="badge sos">SOS</span> : null);

function MapView({ points }) {
  const el = useRef(), map = useRef(), layer = useRef(), key = JSON.stringify(points);
  useEffect(() => {
    map.current = L.map(el.current).setView([17.385, 78.4867], 12);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap" }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
    return () => map.current.remove();
  }, []);
  useEffect(() => {
    layer.current.clearLayers();
    points.forEach(p => L.circleMarker([p.lat, p.lng], { radius: 9, color: p.color, fillOpacity: 0.85 }).bindPopup(p.label).addTo(layer.current));
    if (points.length) map.current.fitBounds(points.map(p => [p.lat, p.lng]), { maxZoom: 15, padding: [30, 30] });
  }, [key]);
  return <div className="map" ref={el} />;
}

const useLive = (load, token, toast) => useEffect(() => {
  load();
  const s = io(HOST);
  s.on("connect", () => s.emit("join", token));
  s.on("refresh", load);
  s.on("notify", toast);
  return () => s.disconnect();
}, [load, token, toast]);

const Tabs = ({ tabs, tab, setTab }) => <div className="tabs">{tabs.map(([k, t]) => <button key={k} className={"tab" + (tab === k ? " on" : "")} onClick={() => setTab(k)}>{t}</button>)}</div>;
const Steps = ({ status }) => { const i = ["open", "accepted", "completed"].indexOf(status);
  return <div className="steps">{["Requested", "Accepted", "Completed"].map((t, k) => <div key={t} className={"step" + (k <= i ? " on" : "")}>{t}</div>)}</div>; };

function Auth({ onAuth }) {
  const [mode, setMode] = useState("login"); const [f, setF] = useState({ role: "driver" }); const [err, setErr] = useState("");
  const set = k => e => setF({ ...f, [k]: e.target.value });
  const submit = async () => {
    try {
      const body = mode === "register" ? { ...f, ...(await getPos()), services: f.role === "mechanic" ? (f.services || "").split(",").map(s => s.trim()).filter(Boolean) : [] } : f;
      onAuth(await api("/" + mode, "POST", body));
    } catch (e) { setErr(e.message); }
  };
  return <div className="hero">
    <div><h1>Stranded on the road?<br />Get help in minutes.</h1>
      <p className="muted">RoadAid connects drivers with verified mechanics nearby, with live tracking and upfront fare estimates.</p>
      <ul><li>📍 Nearby mechanics on a live map</li><li>🚨 One-tap SOS for emergencies</li><li>💰 Fare estimate before you call</li><li>🔔 Instant updates when help is on the way</li></ul></div>
    <div className="card"><h2>{mode === "login" ? "Welcome back" : "Create your account"}</h2>
      {mode === "register" && <>
        <input placeholder="Full name" onChange={set("name")} /><input placeholder="Phone (10 digits)" onChange={set("phone")} />
        <select onChange={set("role")}><option value="driver">I am a driver</option><option value="mechanic">I am a mechanic</option></select>
        {f.role === "mechanic" && <input placeholder="Services: tyre, battery, towing, fuel, engine" onChange={set("services")} />}</>}
      <input placeholder="Email" onChange={set("email")} /><input type="password" placeholder="Password (min 6 characters)" onChange={set("password")} />
      <p className="err">{err}</p>
      <div className="btns"><button className="btn" onClick={submit}>{mode === "login" ? "Log in" : "Register"}</button>
        <button className="btn ghost" onClick={() => { setErr(""); setMode(mode === "login" ? "register" : "login"); }}>{mode === "login" ? "New here? Register" : "I have an account"}</button></div></div></div>;
}

function ReqCard({ r, onRate }) {
  return <div className="req"><div className="reqtop">
    <div><b>{ico(r.issue)} {r.vehicle} · {r.issue}</b><Sos r={r} /><div className="muted">{new Date(r.at).toLocaleString()}</div></div>
    <span className={"badge " + r.status}>{r.status}</span></div>
    <Steps status={r.status} />
    {r.mechanic ? <div>🔧 <b>{r.mechanic.name}</b> · <a href={"tel:" + r.mechanic.phone}>{r.mechanic.phone}</a>{r.fare != null && <> · Est. fare <b>{money(r.fare)}</b></>}</div>
      : <div className="muted">Waiting for a mechanic to accept…</div>}
    {r.status === "completed" && (r.rating ? <div className="rate">Your rating: ★ {r.rating}</div> :
      <div className="btns" style={{ marginTop: 8 }}><span className="muted">Rate service:</span>{[1, 2, 3, 4, 5].map(n => <button key={n} className="btn ghost sm" onClick={() => onRate(r._id, n)}>{n}★</button>)}</div>)}
  </div>;
}

function Driver({ token, toast }) {
  const [tab, setTab] = useState("help"); const [f, setF] = useState({ vehicle: "Car", issue: "tyre", notes: "" });
  const [mechs, setMechs] = useState([]); const [reqs, setReqs] = useState([]); const [me, setMe] = useState(null);
  const load = useCallback(() => api("/requests/mine", "GET", null, token).then(setReqs).catch(() => {}), [token]);
  useLive(load, token, toast);
  const find = async () => { const p = await getPos(); setMe(p); try { setMechs(await api(`/mechanics?lng=${p.lng}&lat=${p.lat}&service=${f.issue}`, "GET", null, token)); } catch (e) { toast(e.message); } };
  const send = async (extra = {}) => { try { const p = await getPos(); await api("/requests", "POST", { ...f, ...extra, ...p }, token); toast("Request sent. Nearby mechanics have been alerted."); setTab("track"); load(); } catch (e) { toast(e.message); } };
  const sos = () => window.confirm("Send an SOS to all nearby mechanics?") && send({ issue: "emergency", notes: "SOS - urgent help needed" });
  const rate = async (id, n) => { try { await api(`/requests/${id}/rate`, "PATCH", { rating: n }, token); } catch (e) { toast(e.message); } };
  const active = reqs.filter(r => r.status !== "completed"), done = reqs.filter(r => r.status === "completed");
  const points = me ? [{ ...me, label: "You", color: "#1d4ed8" }, ...mechs.map(m => ({ lng: m.location.coordinates[0], lat: m.location.coordinates[1], label: `${m.name} (${m.services.join(", ")})`, color: "#15803d" }))] : [];
  return <>
    <div className="card" style={{ padding: "6px 18px 18px" }}>
      <Tabs tab={tab} setTab={setTab} tabs={[["help", "Get help"], ["track", `Active (${active.length})`], ["history", `History (${done.length})`]]} />
      {tab === "help" && <div style={{ marginTop: 16 }}>
        <button className="btn sos" style={{ width: "100%", padding: 14, fontSize: "1.05rem" }} onClick={sos}>🚨 SOS – I need urgent help</button>
        <p className="label" style={{ marginTop: 18 }}>Vehicle</p>
        <div className="chips">{VEHICLES.map(([v, i]) => <button key={v} className={"chip" + (f.vehicle === v ? " on" : "")} onClick={() => setF({ ...f, vehicle: v })}>{i} {v}</button>)}</div>
        <p className="label">What is the problem?</p>
        <div className="chips">{ISSUES.map(([v, i]) => <button key={v} className={"chip" + (f.issue === v ? " on" : "")} onClick={() => setF({ ...f, issue: v })}>{i} {v}</button>)}</div>
        <textarea placeholder="Landmark or extra details (optional)" onChange={e => setF({ ...f, notes: e.target.value })} />
        <div className="btns"><button className="btn" onClick={() => send()}>Send help request</button><button className="btn ghost" onClick={find}>Find mechanics near me</button></div></div>}
      {tab === "track" && <div style={{ marginTop: 16 }}>{active.length === 0 ? <p className="muted">No active requests. Go to “Get help” to report a breakdown.</p> : active.map(r => <ReqCard key={r._id} r={r} onRate={rate} />)}</div>}
      {tab === "history" && <div style={{ marginTop: 16 }}>{done.length === 0 ? <p className="muted">Completed services will appear here.</p> : done.map(r => <ReqCard key={r._id} r={r} onRate={rate} />)}</div>}
    </div>
    {tab === "help" && me && <div className="card"><h2>Mechanics near you for “{f.issue}”</h2><MapView points={points} />
      {mechs.length === 0 && <p className="muted">No available mechanics within 20 km. Try SOS or another service.</p>}
      {mechs.map(m => <div className="row" key={m._id}>
        <div><b>{m.name}</b><Stars r={m.rating} /><div className="muted">{m.services.join(", ")} · {m.km.toFixed(1)} km away</div></div>
        <div className="btns">{m.fare != null && <span>~<b>{money(m.fare)}</b></span>}<a className="btn ghost sm" href={"tel:" + m.phone}>📞 Call</a><a className="btn ghost sm" target="_blank" rel="noreferrer" href={mapLink(m.location.coordinates)}>Map</a></div></div>)}</div>}
  </>;
}

const Job = ({ r, children }) => <div className="req"><div className="reqtop"><div>
  <b>{ico(r.issue)} {r.vehicle} · {r.issue}</b><Sos r={r} />
  <div className="muted">{r.driver.name} · <a href={"tel:" + r.driver.phone}>{r.driver.phone}</a>{r.km != null && ` · ${r.km.toFixed(1)} km away`}</div>
  {r.notes && <div className="muted">“{r.notes}”</div>}
  <a href={mapLink(r.location.coordinates)} target="_blank" rel="noreferrer">📍 Open location</a>{r.fare != null && <div>Fare: <b>{money(r.fare)}</b>{r.rating && <Stars r={r.rating} />}</div>}</div>
  <div>{children}</div></div></div>;

function Mechanic({ token, toast }) {
  const [tab, setTab] = useState("req"); const [open, setOpen] = useState([]); const [mine, setMine] = useState([]); const [hist, setHist] = useState({ jobs: [], earnings: 0 });
  const [pos, setPos] = useState(null); const [avail, setAvail] = useState(true);
  useEffect(() => { api("/mechanic/status", "GET", null, token).then(d => setAvail(d.available)).catch(() => {}); }, [token]);
  const load = useCallback(async () => { try { const p = await getPos(); setPos(p);
    const [o, m, h] = await Promise.all([api(`/requests/nearby?lng=${p.lng}&lat=${p.lat}`, "GET", null, token), api("/requests/accepted", "GET", null, token), api("/requests/history", "GET", null, token)]);
    setOpen(o); setMine(m); setHist(h); } catch (e) { toast(e.message); } }, [token, toast]);
  useLive(load, token, toast);
  const act = async (id, a) => { try { await api(`/requests/${id}/${a}`, "PATCH", null, token); } catch (e) { toast(e.message); } };
  const toggle = async () => { const v = !avail; setAvail(v); try { await api("/mechanic/status", "PATCH", { available: v }, token); } catch (e) { setAvail(!v); toast(e.message); } };
  const points = pos ? [{ ...pos, label: "You", color: "#1d4ed8" }, ...open.map(r => ({ lng: r.location.coordinates[0], lat: r.location.coordinates[1], label: `${r.vehicle} – ${r.issue}`, color: r.issue === "emergency" ? "#d62839" : "#e08a00" }))] : [];
  return <>
    <div className="card"><div className="reqtop"><button className={"sw" + (avail ? " on" : "")} onClick={toggle} aria-pressed={avail}><i />{avail ? "Available for jobs" : "Offline – drivers can't find you"}</button></div></div>
    <div className="grid"><div className="stat"><b>{open.length}</b><span>Open requests nearby</span></div><div className="stat"><b>{mine.length}</b><span>Active jobs</span></div>
      <div className="stat"><b>{hist.jobs.length}</b><span>Completed</span></div><div className="stat"><b>{money(hist.earnings) || "₹0"}</b><span>Total earnings</span></div></div>
    <div className="card" style={{ padding: "6px 18px 18px" }}>
      <Tabs tab={tab} setTab={setTab} tabs={[["req", "Requests"], ["jobs", `My jobs (${mine.length})`], ["hist", "History"]]} />
      <div style={{ marginTop: 16 }}>
        {tab === "req" && <>{pos && <MapView points={points} />}
          {open.length === 0 && <p className="muted">No open requests within 25 km. New ones appear here instantly.</p>}
          {open.map(r => <Job key={r._id} r={r}><button className="btn" onClick={() => act(r._id, "accept")}>Accept</button></Job>)}</>}
        {tab === "jobs" && (mine.length === 0 ? <p className="muted">Accepted jobs appear here.</p> : mine.map(r => <Job key={r._id} r={r}><button className="btn dark" onClick={() => act(r._id, "complete")}>Mark completed</button></Job>))}
        {tab === "hist" && (hist.jobs.length === 0 ? <p className="muted">Completed jobs appear here.</p> : hist.jobs.map(r => <Job key={r._id} r={r} />))}
      </div></div></>;
}

function Admin({ token, toast }) {
  const [st, setSt] = useState(null); const [users, setUsers] = useState([]); const [reqs, setReqs] = useState([]); const [tab, setTab] = useState("users");
  const load = useCallback(async () => { try { setSt(await api("/admin/stats", "GET", null, token)); setUsers(await api("/admin/users", "GET", null, token)); setReqs(await api("/admin/requests", "GET", null, token)); } catch (e) { toast(e.message); } }, [token, toast]);
  useLive(load, token, toast);
  const del = async (u) => { if (window.confirm(`Delete ${u.name}?`)) { try { await api("/admin/users/" + u.id, "DELETE", null, token); } catch (e) { toast(e.message); } } };
  const cards = st ? [["Drivers", st.drivers], ["Mechanics", st.mechanics], ["Requests", st.total], ["Open", st.open], ["Completed", st.completed], ["Avg rating", st.avgRating ? "★ " + st.avgRating : "–"], ["Revenue", "₹" + st.revenue]] : [];
  return <>
    <div className="grid">{cards.map(([t, v]) => <div className="stat" key={t}><b>{v}</b><span>{t}</span></div>)}</div>
    <div className="card" style={{ padding: "6px 18px 18px" }}><Tabs tab={tab} setTab={setTab} tabs={[["users", "Users"], ["reqs", "All requests"]]} />
      <div className="scroll" style={{ marginTop: 12 }}>
        {tab === "users" ? <table className="tbl"><thead><tr><th>Name</th><th>Role</th><th>Email</th><th>Phone</th><th>Services</th><th></th></tr></thead>
          <tbody>{users.map(u => <tr key={u.id}><td>{u.name}</td><td>{u.role}</td><td>{u.email}</td><td>{u.phone}</td><td>{u.services}</td>
            <td>{u.role !== "admin" && <button className="btn danger sm" onClick={() => del(u)}>Delete</button>}</td></tr>)}</tbody></table>
        : <table className="tbl"><thead><tr><th>#</th><th>Vehicle</th><th>Issue</th><th>Status</th><th>Driver</th><th>Mechanic</th><th>Fare</th><th>Rating</th></tr></thead>
          <tbody>{reqs.map(r => <tr key={r.id}><td>{r.id}</td><td>{r.vehicle}</td><td>{r.issue}</td><td><span className={"badge " + r.status}>{r.status}</span></td><td>{r.dname}</td><td>{r.mname || "–"}</td><td>{money(r.fare)}</td><td>{r.rating ? "★ " + r.rating : ""}</td></tr>)}</tbody></table>}
      </div></div></>;
}

export default function App() {
  const [s, setS] = useState(() => JSON.parse(localStorage.getItem("session") || "null")); const [toasts, setToasts] = useState([]);
  const save = v => { v ? localStorage.setItem("session", JSON.stringify(v)) : localStorage.removeItem("session"); setS(v); };
  const toast = useCallback((m) => { const id = Date.now() + Math.random(); setToasts(t => [...t, { id, m }]); setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 6000); }, []);
  return <><header className="top"><div className="in">
    <div className="brand"><svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="#ffb703" /><path d="M16 6a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z" fill="#0f1b2d" /></svg>RoadAid</div>
    {s && <div className="who"><span className="pill">{s.user.name} · {s.user.role}</span><button className="btn ghost sm" onClick={() => save(null)}>Log out</button></div>}</div></header>
    <main>{!s ? <Auth onAuth={save} /> : s.user.role === "driver" ? <Driver token={s.token} toast={toast} /> : s.user.role === "mechanic" ? <Mechanic token={s.token} toast={toast} /> : <Admin token={s.token} toast={toast} />}</main>
    <div className="toasts" aria-live="polite">{toasts.map(t => <div className="toast" key={t.id}>{t.m}</div>)}</div></>;
}
