/**
 * End to end smoke test against a locally running relay.
 *
 *   npx wrangler dev --port 8799 --local     (with .dev.vars setting NW_ADMIN_TOKEN)
 *   npm run smoke
 *
 * Covers the things that are painful to reason about statically: the grace
 * window, identity stamping, join code binding, the panic cap and revocation.
 */
import WebSocket from "ws";

const BASE = "http://127.0.0.1:8799";
const ADMIN = "test-admin-token";
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("  PASS", m)) : (fail++, console.log("  FAIL", m)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function admin(action, body = {}) {
  const r = await fetch(`${BASE}/hood/clermont/admin/${action}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

function decode(code) {
  const j = Buffer.from(code.slice(4).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString();
  return JSON.parse(j);
}

function connect(join, clientId) {
  const url = join.u.replace("wss://nw.clermont.digital", "ws://127.0.0.1:8799");
  const sock = new WebSocket(url, {
    headers: { Authorization: `Bearer ${join.t}`, "X-NW-Client": clientId },
  });
  sock.frames = [];
  sock.on("message", d => sock.frames.push(JSON.parse(d.toString())));
  return new Promise((res, rej) => {
    sock.on("open", () => res(sock));
    sock.on("error", rej);
    sock.on("unexpected-response", (_q, r) => rej(new Error("HTTP " + r.statusCode)));
  });
}
const seen = (s, t) => s.frames.filter(f => f.t === t);

console.log("\n== admin ==");
let r = await fetch(`${BASE}/hood/clermont/admin/properties`, { method: "POST" });
ok(r.status === 401, `admin without a token is refused (${r.status})`);
r = await fetch(`${BASE}/hood/clermont/admin/properties`, { method: "POST", headers: { Authorization: "Bearer wrong" } });
ok(r.status === 403, `admin with a bad token is refused (${r.status})`);
let allow = null;
try { await connect({ u: "wss://nw.clermont.digital/hood/notallowed/ws", t: "x" }, "probe"); allow = "connected"; }
catch (e) { allow = e.message; }
ok(String(allow).includes("404"), `a hood outside NW_HOODS is refused before any object is made (${allow})`);
r = await fetch(`${BASE}/hood/clermont/ws`);
ok(r.status === 426, `a non-upgrade request to /ws is refused (${r.status})`);

await admin("grace", { seconds: 15 });
const alphaInv = await admin("invite", { id: "alpha", name: "Alpha", icon: "mdi:home", rotate: true });
const bravoInv = await admin("invite", { id: "bravo", name: "Bravo", rotate: true });
ok(alphaInv.body.join_code?.startsWith("NW1."), "invite returns a join code");
const badPic = await admin("invite", { id: "charlie", picture: "x');position:fixed;inset:0", rotate: true });
ok(badPic.status === 400, `a picture that is not plain https is rejected (${badPic.status})`);
const badExp = await admin("invite", { id: "delta", expires_in: "soon", rotate: true });
ok(badExp.status === 400, `a non numeric expires_in is rejected rather than meaning never (${badExp.status})`);

const alphaJoin = decode(alphaInv.body.join_code);
const bravoJoin = decode(bravoInv.body.join_code);
ok(alphaJoin.u.startsWith("wss://nw.clermont.digital/hood/clermont/ws"), "join code carries the configured relay URL");

const freshId = `fresh-${Date.now() % 1000000}`;
await admin("invite", { id: freshId, name: "Never Connected" });
const fresh = (await admin("properties")).body.properties.find(p => p.id === freshId);
ok(fresh && fresh.state === "offline" && fresh.online === false,
   `an invited property that has never connected reads offline (${fresh?.state}, online=${fresh?.online})`);
await admin("revoke", { id: freshId });

console.log("\n== connect ==");
const alpha = await connect(alphaJoin, "alpha-install-1");
const bravo = await connect(bravoJoin, "bravo-install-1");
await sleep(400);
ok(seen(alpha, "welcome").length === 1, "welcome on connect");
ok(seen(alpha, "snapshot").length === 1, "snapshot on connect");
ok(seen(alpha, "snapshot")[0].properties.length === 2, "snapshot lists both properties");

console.log("\n== join code binding ==");
let bound = null;
try { await connect(alphaJoin, "someone-elses-machine"); bound = "connected"; }
catch (e) { bound = e.message; }
ok(String(bound).includes("403"), `a leaked code refuses a second install (${bound})`);

console.log("\n== status ==");
bravo.frames.length = 0;
alpha.send(JSON.stringify({ t: "status", state: "armed", detail: "Front gate" }));
await sleep(400);
let upd = seen(bravo, "update").pop();
ok(upd?.property.state === "armed", "a status change reaches the other property");
ok(upd?.property.id === "alpha", "the relay stamps the publisher id");

alpha.frames.length = 0;
alpha.send(JSON.stringify({ t: "status", state: "offline" }));
await sleep(300);
ok(seen(alpha, "error")[0]?.code === "bad_state", "offline cannot be published, it is derived");

alpha.frames.length = 0;
alpha.send(JSON.stringify({ t: "status", state: "armed", id: "bravo", name: "Not Bravo" }));
await sleep(300);
const spoof = await admin("properties");
ok(spoof.body.properties.find(p => p.id === "bravo").name === "Bravo", "a property cannot rename or publish as another");

console.log("\n== panic cap ==");
alpha.frames.length = 0;
for (let i = 0; i < 8; i++) {
  alpha.send(JSON.stringify({ t: "status", state: "panic" }));
  await sleep(60);
  alpha.send(JSON.stringify({ t: "status", state: "disarmed" }));
  await sleep(60);
}
ok(seen(alpha, "error").some(e => e.code === "panic_rate_limited"), "panic entries are capped per hour");

console.log("\n== grace window and offline ==");
bravo.frames.length = 0;
alpha.send(JSON.stringify({ t: "status", state: "armed" }));
await sleep(300);
alpha.terminate();
await sleep(3000);
ok(!seen(bravo, "update").some(u => u.property.state === "offline"), "no offline inside the grace window");
await sleep(30000);
const wentOffline = seen(bravo, "update").some(u => u.property.state === "offline");
ok(wentOffline, "offline once the grace window expires");
if (!wentOffline) {
  const view = (await admin("properties")).body.properties.find(p => p.id === "alpha");
  console.log("    relay's view of alpha:", JSON.stringify(view));
  console.log("    updates bravo saw:", seen(bravo, "update").map(u => `${u.property.id}=${u.property.state}`).join(", "));
}

console.log("\n== revoke ==");
const closed = new Promise(res => bravo.on("close", c => res(c)));
bravo.frames.length = 0;
await admin("revoke", { id: "bravo" });
const code = await Promise.race([closed, sleep(15000).then(() => "no close")]);
ok(seen(bravo, "bye")[0]?.reason === "revoked", "a revoked property is told why");
ok(code === 4003, `a revoked property's socket is closed immediately (${code})`);
let re = null;
try { await connect(bravoJoin, "bravo-install-1"); re = "connected"; } catch (e) { re = e.message; }
ok(String(re).includes("403"), `a revoked token cannot reconnect (${re})`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
