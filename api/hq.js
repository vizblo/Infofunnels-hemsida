// InfoFunnels HQ API: one Vercel function, routed by `action`.
// Storage: Upstash Redis (REST). Auth: signed, HttpOnly session cookie.
// Env: KV_REST_API_URL + KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL/_TOKEN),
//      ADMIN_PASSWORD, SESSION_SECRET, optional ADMIN_USERNAME, SLACK_WEBHOOK_URL.
const crypto = require("crypto");

const RURL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const RTOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const SECRET = process.env.SESSION_SECRET || "";
const ADMIN_USER = (process.env.ADMIN_USERNAME || "admin").trim().toLowerCase();
const ADMIN_PASS = process.env.ADMIN_PASSWORD || "";
const SLACK = process.env.SLACK_WEBHOOK_URL || "";
const COOKIE = "hq_s";
const SESSION_DAYS = 30;

const DEFAULT_LINKS = [
  { title: "Shared Google Drive", url: "https://drive.google.com/drive/folders/0AA2ZyXkapCAwUk9PVA?dmr=1&ec=wgc-drive-%5Bmodule%5D-goto", note: "All company files" },
  { title: "Internal SOPs", url: "https://app.notion.com/p/InfoFunnels-Internal-SOP-s-3d4e067e6c1b8098b3aee139c56ea8d4?source=copy_link", note: "Notion · how we do everything" }
];

/* ---------- redis ---------- */
async function redis(...cmd) {
  const r = await fetch(RURL, { method: "POST", headers: { Authorization: `Bearer ${RTOK}`, "Content-Type": "application/json" }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error("redis: " + j.error);
  return j.result;
}
async function pipeline(cmds) {
  if (!cmds.length) return [];
  const r = await fetch(RURL + "/pipeline", { method: "POST", headers: { Authorization: `Bearer ${RTOK}`, "Content-Type": "application/json" }, body: JSON.stringify(cmds) });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error("redis pipeline: " + JSON.stringify(j));
  return j.map(x => { if (x.error) throw new Error("redis: " + x.error); return x.result; });
}
const parse = v => { try { return v == null ? null : JSON.parse(v); } catch { return null; } };
const hashToObj = arr => { const o = {}; for (let i = 0; arr && i < arr.length; i += 2) { const v = parse(arr[i + 1]); if (v) o[arr[i]] = v; } return o; };

/* ---------- auth ---------- */
function sign(p) {
  const b = Buffer.from(JSON.stringify(p)).toString("base64url");
  return b + "." + crypto.createHmac("sha256", SECRET).update(b).digest("base64url");
}
function verify(t) {
  if (!t || !t.includes(".")) return null;
  const [b, h] = t.split(".");
  const e = crypto.createHmac("sha256", SECRET).update(b).digest("base64url");
  if (h.length !== e.length || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(e))) return null;
  const p = parse(Buffer.from(b, "base64url").toString());
  return p && p.exp > Date.now() ? p : null;
}
function hashPw(pw) { const salt = crypto.randomBytes(16).toString("hex"); return `s1:${salt}:${crypto.scryptSync(pw, salt, 32).toString("hex")}`; }
function checkPw(pw, stored) {
  const [, salt, hex] = String(stored || "").split(":"); if (!salt || !hex) return false;
  const a = crypto.scryptSync(pw, salt, 32), b = Buffer.from(hex, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function safeEq(a, b) { const x = crypto.createHash("sha256").update(String(a)).digest(), y = crypto.createHash("sha256").update(String(b)).digest(); return crypto.timingSafeEqual(x, y); }
function readCookie(req, name) { const m = (req.headers.cookie || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)")); return m ? decodeURIComponent(m[1]) : null; }
function setSession(res, p) {
  const v = p ? sign({ ...p, exp: Date.now() + SESSION_DAYS * 864e5 }) : "";
  res.setHeader("Set-Cookie", `${COOKIE}=${encodeURIComponent(v)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${p ? SESSION_DAYS * 86400 : 0}`);
}

/* ---------- helpers ---------- */
const send = (res, code, obj) => { res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(obj)); };
const str = (v, max = 4000) => String(v ?? "").slice(0, max).trim();
const num = v => { const n = +v; return isFinite(n) ? Math.round(n * 100) / 100 : 0; };
const isYm = s => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
function dateRange(days) { const out = []; const d = new Date(Date.now() + 864e5); for (let i = 0; i <= days; i++) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() - 1); } return out; }

async function getUsers() {
  const users = hashToObj(await redis("HGETALL", "hq:users"));
  if (!users.admin) users.admin = { id: "admin", name: "Admin", role: "Founder", active: true };
  return users;
}
const publicUser = (u, full) => ({ id: u.id, name: u.name, role: u.role || "", active: u.active !== false, ...(full ? { username: u.username || "" } : {}) });

function slackEsc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function slackText(r, user, updated) {
  const day = new Date(r.date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });
  const L = [`*EOD · ${slackEsc(user.name)}${r.role ? " (" + slackEsc(r.role) + ")" : ""} · ${day}*${updated ? "  _(updated)_" : ""}`];
  L.push("", "*✅ Done today*", slackEsc(r.done));
  if (r.win) L.push("", "*🏆 Biggest win*", slackEsc(r.win));
  L.push("", "*🚧 Blockers*", slackEsc(r.blockers || "None"));
  L.push("", "*🎯 Tomorrow*", slackEsc(r.tomorrow));
  const meta = []; if (r.hours != null) meta.push(`*Hours:* ${r.hours}`); if (r.energy) meta.push(`*Day:* ${r.energy}/5`);
  if (meta.length) L.push("", meta.join("  ·  "));
  if (r.notes) L.push("", "*📝 Notes*", slackEsc(r.notes));
  return L.join("\n");
}

/* ---------- EOD ---------- */
async function storeEod(me, r, allowRename) {
  const date = str(r.date, 10);
  if (!isDate(date)) return { code: 400, body: { error: "Pick a valid date." } };
  const age = (Date.now() - Date.parse(date)) / 864e5;
  if (age > 31 || age < -2) return { code: 400, body: { error: "You can only send reports for the last 30 days." } };
  const rec = { date, role: me.role || "", done: str(r.done), win: str(r.win), blockers: str(r.blockers), tomorrow: str(r.tomorrow), notes: str(r.notes),
    hours: r.hours === null || r.hours === "" || r.hours == null ? null : Math.max(0, Math.min(24, num(r.hours))),
    energy: [1, 2, 3, 4, 5].includes(+r.energy) ? +r.energy : null, submittedAt: new Date().toISOString() };
  if (!rec.done || !rec.tomorrow) return { code: 400, body: { error: "Fill in what you got done and tomorrow's priorities." } };
  const key = "hq:eod:" + date;
  const existed = await redis("HEXISTS", key, me.id);
  await pipeline([["HSET", key, me.id, JSON.stringify(rec)], ["EXPIRE", key, 60 * 60 * 24 * 400]]);
  const newName = str(r.name, 80);
  if (allowRename && newName && newName !== me.name) { me.name = newName; await redis("HSET", "hq:users", me.id, JSON.stringify(me)); }
  let slack = "off";
  if (SLACK) {
    try { const s = await fetch(SLACK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: slackText(rec, me, !!existed) }) }); slack = s.ok ? "sent" : "failed"; }
    catch { slack = "failed"; }
  }
  return { code: 200, body: { ok: true, slack, updated: !!existed, report: { ...rec, uid: me.id } } };
}
const normName = s => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();

/* ---------- handler ---------- */
module.exports = async (req, res) => {
  try {
    const missing = [];
    if (!RURL || !RTOK) missing.push("Upstash Redis storage");
    if (!ADMIN_PASS) missing.push("ADMIN_PASSWORD");
    if (SECRET.length < 16) missing.push("SESSION_SECRET");
    if (missing.length) return send(res, 503, { error: "setup", missing });

    if (req.method !== "POST") return send(res, 405, { error: "method" });
    let body = req.body;
    if (typeof body === "string") body = parse(body) || {};
    body = body || {};
    const action = body.action;

    if (action === "login") {
      const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
      const rl = "hq:rl:" + ip;
      const tries = await redis("INCR", rl); if (tries === 1) await redis("EXPIRE", rl, 900);
      if (tries > 10) return send(res, 429, { error: "Too many attempts. Wait 15 minutes and try again." });
      const username = str(body.username, 80).toLowerCase(), password = String(body.password || "");
      if (!username || !password) return send(res, 401, { error: "Enter your username and password." });
      if (username === ADMIN_USER && safeEq(password, ADMIN_PASS)) {
        setSession(res, { uid: "admin", role: "admin" }); await redis("DEL", rl);
        return send(res, 200, { ok: true });
      }
      const users = await getUsers();
      const u = Object.values(users).find(x => x.id !== "admin" && x.active !== false && (x.username || "").toLowerCase() === username);
      if (u && checkPw(password, u.pw)) {
        setSession(res, { uid: u.id, role: "team", pv: u.pv || 1 }); await redis("DEL", rl);
        return send(res, 200, { ok: true });
      }
      return send(res, 401, { error: "Wrong username or password." });
    }
    if (action === "logout") { setSession(res, null); return send(res, 200, { ok: true }); }

    // Standalone team form at /eod: no login, identified by name.
    if (action === "publicEod") {
      const r = body.report || {};
      if (str(body.website, 200)) return send(res, 200, { ok: true, slack: "off" }); // spam trap
      const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
      const rl = "hq:rlp:" + ip;
      const n = await redis("INCR", rl); if (n === 1) await redis("EXPIRE", rl, 3600);
      if (n > 20) return send(res, 429, { error: "Too many reports from this connection. Try again in an hour." });
      const name = str(r.name, 80).replace(/\s+/g, " ");
      if (name.length < 2) return send(res, 400, { error: "Add your name." });
      const users = await getUsers();
      if (normName(users.admin.name) === normName(name) && users.admin.name !== "Admin") return send(res, 400, { error: "That name belongs to the HQ owner. Submit your own report from HQ." });
      let me = Object.values(users).find(u => u.id !== "admin" && u.active !== false && normName(u.name) === normName(name));
      if (!me) {
        if (Object.values(users).some(u => u.id !== "admin" && u.active === false && normName(u.name) === normName(name))) return send(res, 403, { error: "This name no longer has access. Ask your manager." });
        if (Object.keys(users).length >= 60) return send(res, 400, { error: "Name not recognised. Ask your manager to add you on the Team page." });
        me = { id: "u" + crypto.randomBytes(6).toString("hex"), name, role: "", active: true, pv: 1, source: "form", createdAt: new Date().toISOString() };
        await redis("HSET", "hq:users", me.id, JSON.stringify(me));
      }
      const out = await storeEod(me, r, false);
      return send(res, out.code, out.body);
    }

    const sess = verify(readCookie(req, COOKIE));
    if (!sess) return send(res, 401, { error: "auth" });
    const users = await getUsers();
    const me = users[sess.uid];
    if (!me || me.active === false || (sess.role === "team" && (me.pv || 1) !== sess.pv)) { setSession(res, null); return send(res, 401, { error: "auth" }); }
    const admin = sess.role === "admin";
    const needAdmin = () => { if (!admin) { send(res, 403, { error: "Only the owner can do that." }); return true; } return false; };

    switch (action) {
      case "bootstrap": {
        const dates = dateRange(45);
        const cmds = dates.map(d => ["HGETALL", "hq:eod:" + d]);
        if (admin) cmds.push(["HGETALL", "hq:months"], ["GET", "hq:settings"], ["GET", "hq:links"]);
        const out = await pipeline(cmds);
        const reports = [];
        dates.forEach((d, i) => { const h = hashToObj(out[i]); for (const [uid, r] of Object.entries(h)) reports.push({ ...r, uid, date: d }); });
        const data = { me: { ...publicUser(me), admin }, users: Object.values(users).map(u => publicUser(u, admin)), reports, slack: !!SLACK };
        if (admin) {
          const n = dates.length;
          data.months = hashToObj(out[n]);
          data.settings = parse(out[n + 1]) || { rate: 0.2 };
          data.links = parse(out[n + 2]) || DEFAULT_LINKS;
          data.adminUsername = ADMIN_USER;
        }
        return send(res, 200, data);
      }
      case "submitEod": {
        const out = await storeEod(me, body.report || {}, true);
        return send(res, out.code, out.body);
      }
      case "saveMonth": {
        if (needAdmin()) return;
        const ym = str(body.ym, 7); if (!isYm(ym)) return send(res, 400, { error: "Invalid month." });
        const d = body.doc || {};
        const rows = (a, k1, k2, max) => (Array.isArray(a) ? a : []).slice(0, max).map(x => ({ [k1]: str(x[k1], 120), [k2]: num(x[k2]) })).filter(x => x[k1] || x[k2]);
        const doc = { month: ym, rate: Math.max(0, Math.min(1, num(d.rate ?? 0.2))), clients: rows(d.clients, "name", "gross", 200), other: rows(d.other, "label", "amount", 100), costs: rows(d.costs, "label", "amount", 200), updatedAt: new Date().toISOString() };
        await redis("HSET", "hq:months", ym, JSON.stringify(doc));
        return send(res, 200, { ok: true, doc });
      }
      case "saveSettings": {
        if (needAdmin()) return;
        const rate = num(body.rate); if (!(rate >= 0 && rate <= 1)) return send(res, 400, { error: "Rate must be between 0 and 100%." });
        await redis("SET", "hq:settings", JSON.stringify({ rate }));
        return send(res, 200, { ok: true });
      }
      case "saveLinks": {
        if (needAdmin()) return;
        const links = (Array.isArray(body.links) ? body.links : []).slice(0, 100).map(l => ({ title: str(l.title, 120), url: str(l.url, 2000), note: str(l.note, 200) })).filter(l => l.title && /^https?:\/\//i.test(l.url));
        await redis("SET", "hq:links", JSON.stringify(links));
        return send(res, 200, { ok: true, links });
      }
      case "saveUser": {
        if (needAdmin()) return;
        const id = str(body.id, 40);
        const name = str(body.name, 80), role = str(body.role, 80);
        if (!name) return send(res, 400, { error: "Add a name." });
        if (id === "admin") { const u = { ...users.admin, name, role }; await redis("HSET", "hq:users", "admin", JSON.stringify(u)); return send(res, 200, { ok: true }); }
        const username = str(body.username, 40).toLowerCase().replace(/[^a-z0-9._-]/g, "");
        if (username && (username === ADMIN_USER || Object.values(users).some(u => u.id !== id && (u.username || "").toLowerCase() === username))) return send(res, 400, { error: "That username is taken." });
        if (Object.values(users).some(u => u.id !== id && normName(u.name) === normName(name))) return send(res, 400, { error: "Someone on the team already has that name. Add a last name or initial." });
        const password = String(body.password || "");
        const existing = id ? users[id] : null;
        if (id && !existing) return send(res, 404, { error: "Team member not found." });
        if (username && !existing?.pw && password.length < 8) return send(res, 400, { error: "Set a password of at least 8 characters, or leave the username empty." });
        if (password && password.length < 8) return send(res, 400, { error: "Passwords need at least 8 characters." });
        const u = existing ? { ...existing, name, role, username } : { id: "u" + crypto.randomBytes(6).toString("hex"), name, role, username, active: true, pv: 1, createdAt: new Date().toISOString() };
        if (body.active === false || body.active === true) u.active = body.active;
        if (password) { u.pw = hashPw(password); u.pv = (u.pv || 0) + 1; }
        if (u.active === false) u.pv = (u.pv || 0) + 1; // signs them out
        await redis("HSET", "hq:users", u.id, JSON.stringify(u));
        return send(res, 200, { ok: true, user: publicUser(u, true) });
      }
      default:
        return send(res, 400, { error: "Unknown action." });
    }
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: "Something went wrong on the server. Try again." });
  }
};
