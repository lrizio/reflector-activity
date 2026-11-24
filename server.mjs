// Reflector Activity — collector + API + static UI, all in one process.
// D-STAR (XLX) only for now: polls each reflector's UDP JSON monitor (port 10001)
// and records every *new* last-heard entry as a transmission, stamped with our own clock
// (XLX servers report time in their own unlabelled timezone, so we don't trust it).
import dgram from "node:dgram";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import dns from "node:dns/promises";
import net from "node:net";
import ioClient from "socket.io-client"; // v2 client: TGIF runs the old socket.io protocol

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const POLL_MS = 30_000;
const LIST_URL = "http://xlxapi.rlx.lu/api.php?do=GetReflectorList";
const KEEP_MS = 24 * 3600_000;

fs.mkdirSync(path.join(DIR, "data"), { recursive: true });
const DB_FILE = path.join(DIR, "data", "activity.db");
function openDb() {
  const d = new DatabaseSync(DB_FILE);
  try {
    d.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    const ok = d.prepare("PRAGMA quick_check").get();
    if (Object.values(ok)[0] !== "ok") throw new Error("integrity check failed");
    return d;
  } catch (e) { d.close(); throw e; } // release the file so it can be moved aside
}
let db;
try { db = openDb(); }
catch (e) {
  console.warn("[db] unusable (" + e.message + "), starting a fresh database");
  try { db?.close(); } catch {}
  for (const ext of ["", "-wal", "-shm"]) { try { fs.renameSync(DB_FILE + ext, DB_FILE + ".corrupt" + ext); } catch {} }
  db = openDb();
}
db.exec(`
  CREATE TABLE IF NOT EXISTS events (ts INTEGER NOT NULL, ref TEXT NOT NULL, module TEXT NOT NULL, call TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`);
try { db.exec("ALTER TABLE events ADD COLUMN mode TEXT NOT NULL DEFAULT 'dstar'"); } catch { /* already migrated */ }
try { db.exec("ALTER TABLE events ADD COLUMN dur INTEGER NOT NULL DEFAULT 0"); } catch { /* already migrated */ }
db.exec(`
  CREATE INDEX IF NOT EXISTS events_mode_ts ON events(mode, ts);
  CREATE TABLE IF NOT EXISTS tg_names (tg INTEGER PRIMARY KEY, name TEXT);
`);
const insEvent = db.prepare("INSERT INTO events (ts, ref, module, call, mode, dur) VALUES (?,?,?,?,?,?)");
const setTgName = db.prepare("INSERT OR REPLACE INTO tg_names (tg, name) VALUES (?,?)");
const getMeta = (k) => db.prepare("SELECT v FROM meta WHERE k=?").get(k)?.v;
const setMeta = (k, v) => db.prepare("INSERT OR REPLACE INTO meta (k,v) VALUES (?,?)").run(k, String(v));
if (!getMeta("collecting_since")) setMeta("collecting_since", Date.now());

// ---- reflector directory ------------------------------------------------
// Declared up here (before the server starts answering) because requests can arrive while the
// slow startup awaits below are still running; anything the API reads must already exist.
const dplus = new Map(); // "REF023" -> { name, ip, version, seen:Set|null, nodes, lastOk }
const refs = new Map(); // name -> reflector state
const byIp = new Map();

const tag = (s, t) => (s.match(new RegExp("<" + t + ">([\\s\\S]*?)</" + t + ">")) || [])[1]?.trim() ?? "";
const unesc = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");

async function loadList() {
  try {
    const xml = await (await fetch(LIST_URL, { signal: AbortSignal.timeout(20_000) })).text();
    let n = 0;
    for (const block of xml.split("<reflector>").slice(1)) {
      const name = tag(block, "name"), ip = tag(block, "lastip");
      if (!/^XLX\d+$/.test(name) || !ip) continue;
      const r = refs.get(name) ?? { name, lastReply: 0, sent: 0, seen: null, nodes: 0, modules: [] };
      Object.assign(r, { ip, country: unesc(tag(block, "country")), dashboard: tag(block, "dashboardurl"), comment: unesc(tag(block, "comment")) });
      refs.set(name, r); byIp.set(ip, r); n++;
    }
    console.log(`[list] ${n} reflectors`);
  } catch (e) { console.warn("[list] failed:", e.message); }
}

// ---- UDP monitor polling -------------------------------------------------
const sock = dgram.createSocket("udp4");
sock.on("error", (e) => console.warn("[udp]", e.message));
sock.on("message", (buf, rinfo) => {
  const r = byIp.get(rinfo.address);
  if (!r) return;
  let j; try { j = JSON.parse(buf.toString()); } catch { return; }
  r.lastReply = Date.now();
  if (j.reflector && Array.isArray(j.modules)) r.modules = j.modules;
  if (Array.isArray(j.nodes)) r.nodes = j.nodes.length;
  if (Array.isArray(j.stations)) handleStations(r, j.stations);
});

function handleStations(r, stations) {
  const now = Date.now();
  const cur = new Set();
  const fresh = [];
  for (const s of stations) {
    const key = `${s.callsign}|${s.node}|${s.module}|${s.time}`;
    cur.add(key);
    if (r.seen && !r.seen.has(key)) fresh.push(s);
  }
  r.seen = cur; // first snapshot is only a baseline
  try {
    for (const s of fresh) insEvent.run(now, r.name, String(s.module || "?"), String(s.callsign || "?").trim(), "dstar", 0);
  } catch (e) { console.warn("[db] insert failed:", e.message); }
}

let cycle = 0;
async function pollAll() {
  cycle++;
  const list = [...refs.values()].filter((r) => r.lastReply > 0 || r.sent < 5 || cycle % 20 === 0); // retry silent ones rarely
  for (let i = 0; i < list.length; i += 50) {
    for (const r of list.slice(i, i + 50)) { r.sent++; sock.send("hello", 10001, r.ip); }
    await new Promise((res) => setTimeout(res, 150));
  }
}

function prune() { db.prepare("DELETE FROM events WHERE ts < ?").run(Date.now() - KEEP_MS); }

// ---- API -----------------------------------------------------------------
const MODES = {
  dstar: { label: "D-STAR", available: true, note: "XLX reflectors" },
  ysf: { label: "YSF", available: true, note: "Ranked by connected users (YSF reflectors don't publish talk activity)" },
  dmr: { label: "DMR", available: true, note: "TGIF network talkgroups only (BrandMeister is not reachable)" },
};

function dmrItems(acc, windowMin, now) {
  const names = new Map(db.prepare("SELECT tg, name FROM tg_names").all().map((r) => [r.tg, r.name]));
  return [...acc].map(([ref, a]) => {
    const tg = Number(ref.slice(2));
    return {
      name: ref, country: "", comment: names.get(tg) ?? "", dashboard: `https://tgif.network/tgprofile.php?id=${tg}`,
      nodes: null, tx: a.tx, stations: a.calls.size, perHalfHour: Math.round(((a.tx * 30) / windowMin) * 10) / 10,
      lastHeardMsAgo: a.last ? now - a.last : null, topModule: null, modules: [], spark: a.spark,
    };
  });
}

function ranking(mode, windowMin) {
  if (mode === "ysf") return ysfItems(windowMin);
  const now = Date.now(), since = now - windowMin * 60_000, bucket = 5 * 60_000, nb = 12;
  const rows = db.prepare("SELECT ts, ref, module, call FROM events WHERE mode = ? AND ts >= ?").all(mode, now - nb * bucket);
  const acc = new Map();
  for (const e of rows) {
    const a = acc.get(e.ref) ?? { tx: 0, calls: new Set(), mods: new Map(), spark: Array(nb).fill(0), last: 0 };
    const bi = nb - 1 - Math.floor((now - e.ts) / bucket);
    if (bi >= 0 && bi < nb) a.spark[bi]++;
    if (e.ts > a.last) a.last = e.ts;
    if (e.ts >= since) {
      a.tx++; a.calls.add(e.call);
      const m = a.mods.get(e.module) ?? { tx: 0, calls: new Set() };
      m.tx++; m.calls.add(e.call); a.mods.set(e.module, m);
    }
    acc.set(e.ref, a);
  }
  if (mode === "dmr") return dmrItems(acc, windowMin, now);
  const items = [];
  const sources = [
    ...[...refs.values()].filter((r) => r.lastReply), // XLX: only reflectors we can actually see
    ...[...dplus.values()].filter((d) => d.lastOk).map((d) => ({
      name: d.name, country: "DPlus", dashboard: `http://${d.ip}/`, comment: `DPlus reflector (DREFD ${d.version || "?"})`, nodes: d.nodes,
    })),
  ];
  for (const r of sources) {
    const a = acc.get(r.name);
    const mods = a ? [...a.mods].map(([m, v]) => ({ module: m, tx: v.tx, stations: v.calls.size })).sort((x, y) => y.tx - x.tx) : [];
    items.push({
      name: r.name, country: r.country, dashboard: r.dashboard, comment: r.comment, nodes: r.nodes,
      tx: a?.tx ?? 0, stations: a?.calls.size ?? 0, perHalfHour: Math.round((((a?.tx ?? 0) * 30) / windowMin) * 10) / 10,
      lastHeardMsAgo: a?.last ? now - a.last : null, topModule: mods[0]?.module ?? null, modules: mods,
      spark: a?.spark ?? Array(nb).fill(0),
    });
  }
  return items;
}

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/api/modes") return send(res, 200, MODES);
  if (u.pathname === "/api/reflectors") {
    const mode = u.searchParams.get("mode") || "dstar";
    const windowMin = Math.min(60, Math.max(5, Number(u.searchParams.get("window")) || 30));
    const since = Number(getMeta(mode === "dstar" ? "collecting_since" : "collecting_since_" + mode));
    const base = { mode, windowMin, collectedMin: Math.floor((Date.now() - since) / 60_000), now: Date.now() };
    if (!MODES[mode]?.available) return send(res, 200, { ...base, available: false, note: MODES[mode]?.note ?? "Unknown mode", items: [] });
    const items = ranking(mode, windowMin);
    const summary = mode === "dmr"
      ? `${items.length} TGIF talkgroups heard in the last hour · TGIF only, not all of DMR`
      : mode === "ysf"
        ? `${items.length} of ${ysfRefs.size} YSF reflectors responding · ` + (listen.size
          ? `listening to the ${[...listen.values()].filter((l) => l.lastReply).length} busiest (by users) for real Tx counts; the rest show connected users only`
          : "ranked by connected users, not talk activity")
        : (() => {
          const dp = [...dplus.values()].filter((d) => d.lastOk).length;
          return `Watching ${items.length - dp} of ${refs.size} XLX reflectors + ${dp} DPlus (REF) reflectors`;
        })();
    const columns = mode === "ysf"
      ? (listen.size
        ? [{ key: "perHalfHour", label: "Tx/30m" }, { key: "stations", label: "Stations" }, { key: "avg", label: "Avg users" }]
        : [{ key: "avg", label: "Avg users" }, { key: "peak", label: "Peak" }, { key: "now", label: "Now", hide: true }])
      : [{ key: "perHalfHour", label: "Tx/30m" }, { key: "stations", label: "Stations" }, { key: "nodes", label: "Linked", hide: true }];
    if (mode !== "ysf") for (const it of items) it.active = it.tx > 0;
    return send(res, 200, { ...base, available: true, summary, columns, items });
  }
  if (u.pathname === "/guide" || u.pathname === "/guide.html")
    return send(res, 200, fs.readFileSync(path.join(DIR, "public", "guide.html")), "text/html; charset=utf-8");
  if (u.pathname === "/" || u.pathname === "/index.html")
    return send(res, 200, fs.readFileSync(path.join(DIR, "public", "index.html")), "text/html; charset=utf-8");
  send(res, 404, { error: "not found" });
}).on("error", (e) => {
  console.error(e.code === "EADDRINUSE" ? `Port ${PORT} is already in use - is Reflector Activity already running?` : e.message);
  process.exit(1);
}).listen(PORT, "127.0.0.1", () => console.log(`Reflector Activity on http://localhost:${PORT}`));

// ---- DMR: TGIF live last-heard (anonymous socket, same as their public web page) ----
const seenStreams = new Map(); // streamid -> first-seen ms, to drop duplicate events
const tgNames = new Map();
let tgifLast = Date.now();

function onTgif(d) {
  if (!d || !d.talkgroup) return;
  const now = Date.now();
  tgifLast = now;
  const sid = d.streamid ?? `${d.talkgroup}|${d.timestamp}|${d.radio_id}`;
  if (seenStreams.has(sid)) return;
  seenStreams.set(sid, now);
  const call = String(d.callsign || "").trim() || (d.radio_id ? "ID" + d.radio_id : d.station_key || "?");
  try {
    insEvent.run(now, "TG" + d.talkgroup, "", call, "dmr", 0);
    const name = String(d.talkgroup_name || "").trim();
    if (name && tgNames.get(d.talkgroup) !== name) { tgNames.set(d.talkgroup, name); setTgName.run(Number(d.talkgroup), name); }
  } catch (e) { console.warn("[db] insert failed:", e.message); }
}

function startTgif() {
  const s = ioClient("https://tgif.network", { transports: ["websocket"], reconnection: true });
  s.on("connect", () => { console.log("[tgif] connected"); s.emit("handshake", ""); });
  s.on("lastheard", onTgif);
  s.on("connect_error", (e) => console.warn("[tgif]", e?.message ?? e));
  setInterval(() => { // watchdog: reconnect if the feed goes quiet
    if (Date.now() - tgifLast > 180_000) { console.warn("[tgif] feed quiet, reconnecting"); tgifLast = Date.now(); s.disconnect(); s.connect(); }
  }, 60_000);
  setInterval(() => { const cut = Date.now() - 15 * 60_000; for (const [k, t] of seenStreams) if (t < cut) seenStreams.delete(k); }, 60_000);
}

// ---- YSF: host list (Pi-Star mirror of DVRef data) + UDP status polling -------
// YSF reflectors answer a "YSFS" status query with their connected-user count. They don't
// publish who is talking, so we track users over time instead.
const YSF_URL = "https://www.pistar.uk/downloads/YSF_Hosts.txt"; // data provided by DVRef (https://dvref.com/aup/)
const YSF_CACHE = path.join(DIR, "data", "YSFHosts.txt"); // also lets you drop in a list by hand
const ysfRefs = new Map();   // designator -> {id,name,desc,host,port,ip,users,lastReply,sent}
const ysfByAddr = new Map(); // "ip:port" -> reflector
const ysfBuf = [];
db.exec("CREATE TABLE IF NOT EXISTS ysf_samples (ts INTEGER NOT NULL, ref TEXT NOT NULL, users INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS ysf_ts ON ysf_samples(ts);");
const insYsf = db.prepare("INSERT INTO ysf_samples (ts, ref, users) VALUES (?,?,?)");
for (const m of ["dmr", "ysf"]) if (!getMeta("collecting_since_" + m)) setMeta("collecting_since_" + m, Date.now());

async function loadYsf() {
  let text;
  try {
    const r = await fetch(YSF_URL, { signal: AbortSignal.timeout(30_000), headers: { "user-agent": "reflector-activity/0.1 (personal local tool)" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    text = await r.text();
    if (!/^\d+;/m.test(text)) throw new Error("unexpected content");
    fs.writeFileSync(YSF_CACHE, text);
  } catch (e) {
    console.warn("[ysf] list download failed:", e.message, "- using cached copy if any");
    try { text = fs.readFileSync(YSF_CACHE, "utf8"); } catch { return; }
  }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const [id, name, desc, host, port] = line.split(";");
    if (id && host && Number(port)) rows.push({ id, name: (name || id).trim(), desc: (desc || "").trim(), host: host.trim(), port: Number(port) });
  }
  const hosts = [...new Set(rows.map((r) => r.host))], ips = new Map();
  let next = 0;
  await Promise.all(Array.from({ length: 40 }, async () => {
    while (next < hosts.length) {
      const h = hosts[next++];
      if (net.isIPv4(h)) { ips.set(h, h); continue; }
      try { ips.set(h, (await dns.lookup(h, 4)).address); } catch { /* unresolvable: skip */ }
    }
  }));
  ysfByAddr.clear();
  for (const row of rows) {
    const ip = ips.get(row.host) ?? ysfRefs.get(row.id)?.ip;
    if (!ip) continue;
    const r = Object.assign(ysfRefs.get(row.id) ?? { users: 0, lastReply: 0, sent: 0 }, row, { ip });
    ysfRefs.set(row.id, r); ysfByAddr.set(`${ip}:${row.port}`, r);
  }
  console.log(`[ysf] ${ysfRefs.size} reflectors`);
}

const ysfSock = dgram.createSocket("udp4");
ysfSock.on("error", (e) => console.warn("[ysf udp]", e.message));
ysfSock.on("message", (b, ri) => {
  const r = ysfByAddr.get(`${ri.address}:${ri.port}`);
  if (!r || b.length < 14 || b.toString("latin1", 0, 4) !== "YSFS") return;
  const n = parseInt(b.toString("latin1", b.length - 3), 10); // reply ends with a 3-digit user count
  if (!Number.isFinite(n)) return;
  r.users = n; r.lastReply = Date.now();
  ysfBuf.push([r.lastReply, r.id, n]);
});

let ysfCycle = 0;
async function pollYsf() {
  ysfCycle++;
  const list = [...ysfRefs.values()].filter((r) => r.lastReply > 0 || r.sent < 5 || ysfCycle % 20 === 0);
  const q = Buffer.from("YSFS", "latin1");
  for (let i = 0; i < list.length; i += 50) {
    for (const r of list.slice(i, i + 50)) { r.sent++; ysfSock.send(q, r.port, r.ip, () => {}); }
    await new Promise((res) => setTimeout(res, 150));
  }
}
function flushYsf() {
  if (!ysfBuf.length) return;
  const rows = ysfBuf.splice(0);
  try { db.exec("BEGIN"); for (const r of rows) insYsf.run(...r); db.exec("COMMIT"); }
  catch (e) { try { db.exec("ROLLBACK"); } catch {} console.warn("[db] ysf insert failed:", e.message); }
}

// ---- YSF listener: join the busiest reflectors (listen-only) to see real talk activity ----
// Protocol: "YSFP"+callsign(10) is a keep-alive poll (every 5 s); "YSFU"+callsign unlinks;
// "YSFD" (155 B) voice frames: gateway call @4, source (talker) call @14, byte 34 bit0 = end of transmission.
// We never send voice frames, only polls, so we appear as a silent connected station.
const cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(DIR, "config.json"), "utf8")); } catch { return {}; } })();
const LISTEN_CALL = String(cfg.callsign || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
const LISTEN_TOP = Math.max(0, Math.min(200, Number(cfg.listenTop ?? 50)));
const listen = new Map(); // designator -> { ref, lastReply, streams: Map<key,{start,last,src}> }
const listenSock = dgram.createSocket("udp4");
listenSock.on("error", (e) => console.warn("[ysf listen]", e.message));
const pad10 = (s) => Buffer.from(s.padEnd(10, " ").slice(0, 10), "latin1");
const sendTag = (tag, L) => listenSock.send(Buffer.concat([Buffer.from(tag, "latin1"), pad10(LISTEN_CALL)]), L.ref.port, L.ref.ip, () => {});

function finishStream(L, key) {
  const s = L.streams.get(key);
  if (!s) return;
  L.streams.delete(key);
  const dur = s.last - s.start + 90; // a frame is ~90 ms
  if (dur < 300) return; // ignore stray single frames
  try { insEvent.run(s.start, L.ref.id, "", s.src, "ysf", dur); } catch (e) { console.warn("[db] ysf event failed:", e.message); }
}

listenSock.on("message", (b, ri) => {
  const ref = ysfByAddr.get(`${ri.address}:${ri.port}`), L = ref && listen.get(ref.id);
  if (!L || b.length < 4) return;
  const tag = b.toString("latin1", 0, 4);
  if (tag === "YSFP") { L.lastReply = Date.now(); return; }
  if (tag !== "YSFD" || b.length < 35) return;
  L.lastReply = Date.now();
  const clean = (x) => b.toString("latin1", x, x + 10).replace(/[^\x21-\x7e]/g, "").trim() || "?";
  const gw = clean(4), src = clean(14), end = b[34] & 1, key = gw + "|" + src, now = Date.now();
  if (process.env.YSF_DEBUG) console.log(`[ysf frame] ${ref.name} gw=${gw} src=${src} dst=${clean(24)} ctr=${b[34]} len=${b.length}`);
  let s = L.streams.get(key);
  if (s && now - s.last > 3000) { finishStream(L, key); s = null; }
  if (!s) L.streams.set(key, (s = { start: now, last: now, src }));
  s.last = now;
  if (end) finishStream(L, key);
});

function selectListeners() {
  if (!LISTEN_CALL || !LISTEN_TOP) return;
  const rows = db.prepare("SELECT ref, AVG(users) a FROM ysf_samples WHERE ts >= ? GROUP BY ref ORDER BY a DESC LIMIT ?").all(Date.now() - 30 * 60_000, LISTEN_TOP * 2);
  const want = new Set(rows.filter((r) => r.a >= 1 && ysfRefs.has(r.ref)).slice(0, LISTEN_TOP).map((r) => r.ref));
  for (const [id, L] of listen) if (!want.has(id)) { sendTag("YSFU", L); listen.delete(id); }
  for (const id of want) if (!listen.has(id)) listen.set(id, { ref: ysfRefs.get(id), lastReply: 0, streams: new Map() });
  console.log(`[ysf listen] watching ${listen.size} reflectors as ${LISTEN_CALL}`);
}
function pollListeners() {
  const now = Date.now();
  for (const L of listen.values()) {
    if (L.lastReply && now - L.lastReply > 30_000) L.lastReply = 0; // went quiet: show as not connected until it answers again
    sendTag("YSFP", L);
  }
}
function sweepStreams() {
  const now = Date.now();
  for (const L of listen.values()) for (const [k, s] of L.streams) if (now - s.last > 2000) finishStream(L, k);
}
function unlinkAll() { for (const L of listen.values()) sendTag("YSFU", L); }
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { unlinkAll(); setTimeout(() => process.exit(0), 200); });

function ysfItems(windowMin) {
  const now = Date.now(), since = now - windowMin * 60_000, bucket = 5 * 60_000, nb = 12;
  const acc = new Map();
  for (const e of db.prepare("SELECT ts, ref, users FROM ysf_samples WHERE ts >= ?").all(now - nb * bucket)) {
    const a = acc.get(e.ref) ?? { sum: 0, n: 0, peak: 0, bs: Array(nb).fill(0), bn: Array(nb).fill(0) };
    const bi = nb - 1 - Math.floor((now - e.ts) / bucket);
    if (bi >= 0 && bi < nb) { a.bs[bi] += e.users; a.bn[bi]++; }
    if (e.ts >= since) { a.sum += e.users; a.n++; if (e.users > a.peak) a.peak = e.users; }
    acc.set(e.ref, a);
  }
  const heard = new Map(); // listened reflectors: real transmissions in the window
  for (const e of db.prepare("SELECT ref, call, dur, ts FROM events WHERE mode = 'ysf' AND ts >= ?").all(since)) {
    const h = heard.get(e.ref) ?? { tx: 0, calls: new Set(), talkMs: 0, last: 0 };
    h.tx++; h.calls.add(e.call); h.talkMs += e.dur; if (e.ts > h.last) h.last = e.ts;
    heard.set(e.ref, h);
  }
  const items = [];
  for (const r of ysfRefs.values()) {
    if (!r.lastReply) continue;
    const a = acc.get(r.id);
    const watched = listen.get(r.id)?.lastReply > 0, h = heard.get(r.id);
    const avg = a?.n ? Math.round((a.sum / a.n) * 10) / 10 : r.users;
    const peak = a?.n ? a.peak : r.users;
    items.push({
      id: r.id, name: r.name, country: "#" + r.id, comment: r.desc, dashboard: "", now: r.users, avg, peak, active: avg > 0,
      lastHeardMsAgo: h ? now - h.last : null, topModule: null, modules: [], tx: 0, nodes: null,
      perHalfHour: watched ? Math.round((((h?.tx ?? 0) * 30) / windowMin) * 10) / 10 : null,
      stations: watched ? (h?.calls.size ?? 0) : null,
      spark: a ? a.bs.map((s, i) => (a.bn[i] ? s / a.bn[i] : 0)) : Array(nb).fill(0),
      detail: `${r.users} users now · avg ${avg}, peak ${peak} over ${windowMin} min · ${r.host}:${r.port} · ` +
        (watched ? `listening: ${h?.tx ?? 0} transmissions, ${h?.calls.size ?? 0} stations, ${Math.round((h?.talkMs ?? 0) / 6000) / 10} min of talk in ${windowMin} min` : "not listened to (only the busiest reflectors are)"),
    });
  }
  return items;
}

await loadYsf();
setInterval(loadYsf, 24 * 3600_000);
setInterval(pollYsf, 60_000);
setInterval(flushYsf, 5_000);
setInterval(() => db.prepare("DELETE FROM ysf_samples WHERE ts < ?").run(Date.now() - KEEP_MS), 3600_000);
pollYsf();
if (LISTEN_CALL && LISTEN_TOP) {
  setTimeout(selectListeners, 90_000); // wait for a couple of status polls to know who is busy
  setInterval(selectListeners, 15 * 60_000);
  setInterval(pollListeners, 5_000);
  setInterval(sweepStreams, 1_000);
} else console.log("[ysf listen] disabled (set callsign in config.json to enable)");

// ---- D-STAR DPlus (REF) reflectors, via their public DREFD web dashboards -------
// REF reflectors have no status protocol we can query, but ~70 of the numbered ones publish a
// "DPLUS Dashboard" with a Last Heard table. We fetch each once a minute and count new rows.
const DPLUS_LIST_URL = "https://www.pistar.uk/downloads/DPlus_Hosts.txt";
const DASH_CACHE = path.join(DIR, "data", "dplus_dashboards.json");
const DASH_HEADERS = { "user-agent": "reflector-activity/0.1 (personal local tool)" };

function parseDplus(html) {
  const i = html.search(/Last Heard/i);
  const part = i >= 0 ? html.slice(i) : "";
  const rows = [];
  // each row: callsign | user message | module letter | yyyy/mm/dd hh:mm:ss
  const re = /<td[^>]*>\s*<span[^>]*>([^<]*)<\/span>\s*<\/td>\s*<td[^>]*>\s*<span[^>]*>[^<]*<\/span>\s*<\/td>\s*<td[^>]*>\s*<span[^>]*>\s*([A-Z])\s*<\/span>\s*<\/td>\s*<td[^>]*>\s*<span[^>]*>\s*(\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d)\s*<\/span>/g;
  for (const m of part.matchAll(re)) rows.push({ call: m[1].replace(/&nbsp;/g, " ").trim(), module: m[2], time: m[3] });
  const n = html.match(/(\d+)\s+remote users?\s*-\s*(\d+)\s+gateways?/i);
  return { rows, users: n ? +n[1] : null, gateways: n ? +n[2] : null };
}

function applyDplus(found) {
  for (const f of found) dplus.set(f.name, Object.assign(dplus.get(f.name) ?? { seen: null, nodes: null, lastOk: 0 }, f));
  console.log(`[dplus] ${dplus.size} dashboards`);
}

async function discoverDplus() {
  try {
    const text = await (await fetch(DPLUS_LIST_URL, { signal: AbortSignal.timeout(30_000), headers: DASH_HEADERS })).text();
    const xlxIps = new Set(byIp.keys()); // XLX hosts already covered
    const cands = [];
    for (const line of text.split(/\r?\n/)) {
      const [name, ip] = line.trim().split(/\s+/);
      if (/^REF\d{3}$/.test(name) && net.isIPv4(ip) && !xlxIps.has(ip)) cands.push({ name, ip });
    }
    const found = []; let next = 0;
    await Promise.all(Array.from({ length: 20 }, async () => {
      while (next < cands.length) {
        const c = cands[next++];
        try {
          const r = await fetch(`http://${c.ip}/`, { signal: AbortSignal.timeout(6000), headers: DASH_HEADERS });
          if (!r.ok) continue;
          const html = await r.text();
          if (/DPLUS Dashboard|DREFD/.test(html) && /Last Heard/i.test(html) && parseDplus(html).rows.length)
            found.push({ name: c.name, ip: c.ip, version: (html.match(/DREFD version ([\d.]+)/) || [])[1] ?? "" });
        } catch { /* no web server: not a dashboard host */ }
      }
    }));
    if (found.length < 10) throw new Error(`only ${found.length} dashboards found, keeping the old list`);
    fs.writeFileSync(DASH_CACHE, JSON.stringify({ ts: Date.now(), found }));
    applyDplus(found);
  } catch (e) { console.warn("[dplus] discovery failed:", e.message); }
}

function handleDplus(d, rows) {
  if (!rows.length) return; // empty/odd page: keep the previous snapshot so we don't re-count everything later
  const now = Date.now(), cur = new Set(), fresh = [];
  for (const e of rows) {
    const key = `${e.call}|${e.module}|${e.time}`;
    cur.add(key);
    if (d.seen && !d.seen.has(key)) fresh.push(e); // first snapshot is only a baseline
  }
  d.seen = cur;
  try { for (const e of fresh) insEvent.run(now, d.name, e.module, e.call || "?", "dstar", 0); }
  catch (e) { console.warn("[db] dplus insert failed:", e.message); }
}

let dpBusy = false;
async function pollDplus() {
  if (dpBusy) return;
  dpBusy = true;
  try {
    const list = [...dplus.values()]; let i = 0;
    await Promise.all(Array.from({ length: 10 }, async () => {
      while (i < list.length) {
        const d = list[i++];
        try {
          const r = await fetch(`http://${d.ip}/`, { signal: AbortSignal.timeout(8000), headers: DASH_HEADERS });
          if (!r.ok) continue;
          const p = parseDplus(await r.text());
          d.lastOk = Date.now();
          if (p.users != null) d.nodes = p.users + (p.gateways ?? 0);
          handleDplus(d, p.rows);
        } catch { /* unreachable this round */ }
      }
    }));
  } finally { dpBusy = false; }
}

function startDplus() {
  let age = Infinity;
  try { const c = JSON.parse(fs.readFileSync(DASH_CACHE, "utf8")); applyDplus(c.found); age = Date.now() - c.ts; } catch { /* no cache yet */ }
  if (age > 7 * 86400_000) discoverDplus();
  setInterval(pollDplus, 60_000);
  setInterval(discoverDplus, 7 * 86400_000);
}

await loadList();
startTgif();
startDplus();
setInterval(loadList, 6 * 3600_000);
setInterval(pollAll, POLL_MS);
setInterval(prune, 3600_000);
pollAll();
