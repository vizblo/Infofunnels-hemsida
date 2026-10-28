// InfoFunnels Applications API: public application forms (/applications/<slug>) + the owner's form builder (/applications).
// Storage: Upstash Redis (REST), same database as HQ. Auth: the HQ owner's session cookie (hq_s); only the owner can build forms or read applications.
// Env: same as api/hq.js (KV_REST_API_URL + KV_REST_API_TOKEN, SESSION_SECRET).
const crypto = require("crypto");

const RURL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const RTOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const SECRET = process.env.SESSION_SECRET || "";
const COOKIE = "hq_s";

const TYPES = ["text", "textarea", "email", "tel", "select", "yesno"];
const STATUSES = ["new", "shortlisted", "rejected"];
const SLUG = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;
const MAX_FORMS = 50;
const MAX_SUBS = 2000;
const RETENTION_DAYS = 365; // applications older than this are deleted when the owner opens a form's applications (see privacy.html)

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

/* ---------- auth (same signed cookie as HQ) ---------- */
function verify(t) {
  if (!t || !t.includes(".")) return null;
  const [b, h] = t.split(".");
  const e = crypto.createHmac("sha256", SECRET).update(b).digest("base64url");
  if (h.length !== e.length || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(e))) return null;
  const p = parse(Buffer.from(b, "base64url").toString());
  return p && p.exp > Date.now() ? p : null;
}
function readCookie(req, name) { const m = (req.headers.cookie || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)")); return m ? decodeURIComponent(m[1]) : null; }

/* ---------- helpers ---------- */
const send = (res, code, obj) => { res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(obj)); };
const str = (v, max = 4000) => (typeof v === "string" || typeof v === "number" ? String(v) : "").slice(0, max).trim();
const subsKey = slug => "app:subs:" + slug;
const newId = prefix => prefix + crypto.randomBytes(5).toString("hex");

function cleanForm(f, slug, existing) {
  const title = str(f.title, 100);
  if (!title) return { error: "Give the form a title." };
  const details = (Array.isArray(f.details) ? f.details : []).slice(0, 12)
    .map(d => ({ label: str(d && d.label, 40), value: str(d && d.value, 200) })).filter(d => d.label && d.value);
  const seen = new Set();
  const questions = [];
  for (const q of (Array.isArray(f.questions) ? f.questions : []).slice(0, 40)) {
    const label = str(q && q.label, 200);
    if (!label) continue;
    const type = TYPES.includes(q.type) ? q.type : "text";
    let id = str(q.id, 16).toLowerCase();
    if (!/^[a-z0-9]{3,16}$/.test(id) || seen.has(id)) id = newId("q");
    seen.add(id);
    const out = { id, label, help: str(q.help, 300), type, required: !!q.required };
    if (type === "select") {
      out.options = (Array.isArray(q.options) ? q.options : []).slice(0, 20).map(o => str(o, 80)).filter(Boolean);
      if (out.options.length < 2) return { error: `"${label}" is a dropdown, so it needs at least two options.` };
    }
    questions.push(out);
  }
  if (!questions.length) return { error: "Add at least one question." };
  const now = new Date().toISOString();
  return { form: {
    slug, title, status: f.status === "closed" ? "closed" : "open", details, about: str(f.about, 4000), questions,
    successMessage: str(f.successMessage, 500) || "Thanks, your application is in. If it's a fit, we'll reach out.",
    createdAt: existing ? existing.createdAt : now, updatedAt: now
  } };
}

function cleanAnswer(q, raw) {
  const v = str(raw, q.type === "textarea" ? 5000 : 500);
  if (!v) return q.required ? { error: "This one is required." } : { value: "" };
  if (q.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return { error: "Enter a valid email address." };
  if (q.type === "tel" && !/^[+\d][\d\s().-]{5,}$/.test(v)) return { error: "Enter a valid phone number, including the area code." };
  if (q.type === "select" && !q.options.includes(v)) return { error: "Pick one of the options." };
  if (q.type === "yesno") { const y = /^yes$/i.test(v), n = /^no$/i.test(v); if (!y && !n) return { error: "Pick Yes or No." }; return { value: y ? "Yes" : "No" }; }
  return { value: v };
}

/* ---------- handler ---------- */
module.exports = async (req, res) => {
  try {
    if (!RURL || !RTOK || SECRET.length < 16) return send(res, 503, { error: "setup" });
    if (req.method !== "POST") return send(res, 405, { error: "method" });
    let body = req.body;
    if (typeof body === "string") body = parse(body) || {};
    body = body || {};
    const action = body.action;

    /* ----- public: an applicant opens and submits a form ----- */
    if (action === "getForm" || action === "submit") {
      const slug = str(body.slug, 40).toLowerCase();
      const form = SLUG.test(slug) ? parse(await redis("HGET", "app:forms", slug)) : null;
      if (!form) return send(res, 404, { error: "This application doesn't exist." });
      if (action === "getForm") {
        const { slug: s, title, status, details, about, questions, successMessage } = form;
        return send(res, 200, { form: status === "closed" ? { slug: s, title, status } : { slug: s, title, status, details, about, questions, successMessage } });
      }
      if (str(body.website, 200)) return send(res, 200, { ok: true }); // spam trap
      if (form.status === "closed") return send(res, 403, { error: "This application is closed." });
      const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
      const rl = "app:rl:" + ip;
      const n = await redis("INCR", rl); if (n === 1) await redis("EXPIRE", rl, 3600);
      if (n > 15) return send(res, 429, { error: "Too many applications from this connection. Try again in an hour." });
      const given = body.answers && typeof body.answers === "object" ? body.answers : {};
      const answers = [];
      for (const q of form.questions) {
        const out = cleanAnswer(q, given[q.id]);
        if (out.error) return send(res, 400, { error: `${q.label}: ${out.error}`, field: q.id });
        answers.push({ id: q.id, label: q.label, value: out.value });
      }
      if (await redis("HLEN", subsKey(slug)) >= MAX_SUBS) return send(res, 400, { error: "This application is full. Please contact us directly." });
      const sub = { id: newId("a"), answers, status: "new", submittedAt: new Date().toISOString() };
      await redis("HSET", subsKey(slug), sub.id, JSON.stringify(sub));
      return send(res, 200, { ok: true });
    }

    /* ----- owner only ----- */
    const sess = verify(readCookie(req, COOKIE));
    if (!sess || sess.role !== "admin") return send(res, 401, { error: "auth" });

    switch (action) {
      case "listForms": {
        const forms = Object.values(hashToObj(await redis("HGETALL", "app:forms"))).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
        const vals = await pipeline(forms.map(f => ["HVALS", subsKey(f.slug)]));
        return send(res, 200, { forms: forms.map((f, i) => {
          const subs = (vals[i] || []).map(parse).filter(Boolean);
          return { ...f, count: subs.length, newCount: subs.filter(x => x.status === "new").length };
        }) });
      }
      case "saveForm": {
        const f = body.form || {};
        const slug = str(f.slug, 40).toLowerCase();
        if (!SLUG.test(slug)) return send(res, 400, { error: "The URL needs 2-40 characters: lowercase letters, numbers and dashes." });
        const existing = parse(await redis("HGET", "app:forms", slug));
        if (body.isNew && existing) return send(res, 400, { error: "That URL is already used by another form." });
        if (!body.isNew && !existing) return send(res, 404, { error: "That form no longer exists." });
        if (body.isNew && await redis("HLEN", "app:forms") >= MAX_FORMS) return send(res, 400, { error: "You've reached the limit of " + MAX_FORMS + " forms." });
        const out = cleanForm(f, slug, existing);
        if (out.error) return send(res, 400, { error: out.error });
        await redis("HSET", "app:forms", slug, JSON.stringify(out.form));
        return send(res, 200, { ok: true, form: out.form });
      }
      case "deleteForm": {
        const slug = str(body.slug, 40).toLowerCase();
        await pipeline([["HDEL", "app:forms", slug], ["DEL", subsKey(slug)]]);
        return send(res, 200, { ok: true });
      }
      case "listSubmissions": {
        const slug = str(body.slug, 40).toLowerCase();
        const form = parse(await redis("HGET", "app:forms", slug));
        if (!form) return send(res, 404, { error: "That form no longer exists." });
        const all = hashToObj(await redis("HGETALL", subsKey(slug)));
        const cutoff = Date.now() - RETENTION_DAYS * 864e5;
        const expired = Object.values(all).filter(s => Date.parse(s.submittedAt) < cutoff).map(s => s.id);
        if (expired.length) { await redis("HDEL", subsKey(slug), ...expired); expired.forEach(id => delete all[id]); }
        const subs = Object.values(all).sort((a, b) => (b.submittedAt || "").localeCompare(a.submittedAt || ""));
        return send(res, 200, { form, submissions: subs, retentionDays: RETENTION_DAYS });
      }
      case "setStatus": {
        const slug = str(body.slug, 40).toLowerCase(), id = str(body.id, 40);
        if (!STATUSES.includes(body.status)) return send(res, 400, { error: "Unknown status." });
        const sub = parse(await redis("HGET", subsKey(slug), id));
        if (!sub) return send(res, 404, { error: "That application no longer exists." });
        sub.status = body.status;
        await redis("HSET", subsKey(slug), id, JSON.stringify(sub));
        return send(res, 200, { ok: true });
      }
      case "deleteSubmission": {
        await redis("HDEL", subsKey(str(body.slug, 40).toLowerCase()), str(body.id, 40));
        return send(res, 200, { ok: true });
      }
      default:
        return send(res, 400, { error: "Unknown action." });
    }
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: "Something went wrong on the server. Try again." });
  }
};
