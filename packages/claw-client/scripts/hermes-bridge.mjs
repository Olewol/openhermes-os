#!/usr/bin/env node
/**
 * OpenHermes OS dev bridge: browser <-> Hermes dashboard gateway (/api/ws).
 *
 * Why it exists (verified against Hermes 0.23.2):
 *  - The dashboard (default 127.0.0.1:9119) is auth-gated: /api/ws needs a single-use ticket from
 *    `POST /api/auth/ws-ticket`, which needs the login cookie from `POST /auth/password-login`
 *    (hermes_cli/dashboard_auth/routes.py).
 *  - A page on another port (the Next dev server, :18790) cannot open /api/ws itself: the upgrade is
 *    refused with `origin_mismatch` (hermes_cli/web_server_boundary.py, ws_host_origin_reason).
 *  So this tiny Node process logs in server-side, mints a ticket per browser socket and pipes the
 *  JSON-RPC frames unchanged to the dashboard. The browser then speaks Hermes' native protocol
 *  through the vendored JsonRpcGatewayClient. Nothing in ~/.hermes is touched.
 *
 * Config (env):
 *   HERMES_DASH_URL            default http://127.0.0.1:9119
 *   HERMES_DASH_USER           username (dashboard.basic_auth.username)
 *   HERMES_DASH_PASSWORD       password, or
 *   HERMES_DASH_PASSWORD_CMD   a command that prints the password (e.g. a vault helper); never logged
 *   HERMES_DASH_USER_CMD       a command that prints the username
 *   HERMES_DASH_PROVIDER       default "basic"
 *   HERMES_BRIDGE_HOST/PORT    default 127.0.0.1 / 18791
 *   HERMES_BRIDGE_ORIGINS      extra allowed browser origins, comma separated
 *                              (localhost/127.0.0.1 on any port is always allowed)
 *
 * Endpoints:  WS /hermes/ws   GET /hermes/health   ANY /hermes/api/*  (REST passthrough with cookie)
 */
import { execSync } from "node:child_process";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";

const DASH = (process.env.HERMES_DASH_URL ?? "http://127.0.0.1:9119").replace(/\/+$/, "");
const PROVIDER = process.env.HERMES_DASH_PROVIDER ?? "basic";
const HOST = process.env.HERMES_BRIDGE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.HERMES_BRIDGE_PORT ?? 18791);
const EXTRA_ORIGINS = (process.env.HERMES_BRIDGE_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const log = (...a) => console.log(new Date().toISOString(), "[hermes-bridge]", ...a);

function fromCmd(cmd) {
  return execSync(cmd, { encoding: "utf8", timeout: 45_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
}
function credentials() {
  const user = process.env.HERMES_DASH_USER ?? (process.env.HERMES_DASH_USER_CMD ? fromCmd(process.env.HERMES_DASH_USER_CMD) : "");
  const password =
    process.env.HERMES_DASH_PASSWORD ??
    (process.env.HERMES_DASH_PASSWORD_CMD ? fromCmd(process.env.HERMES_DASH_PASSWORD_CMD) : "");
  if (!user || !password) {
    throw new Error("Set HERMES_DASH_USER and HERMES_DASH_PASSWORD (or *_CMD variants).");
  }
  return { user, password };
}

// Node's fetch keeps sockets alive; uvicorn closes idle ones, so the first reuse can fail with
// "fetch failed". One retry on a fresh connection is enough.
async function dfetch(url, init) {
  try {
    return await fetch(url, init);
  } catch (e) {
    if (e instanceof TypeError) return await fetch(url, init);
    throw e;
  }
}

// ── dashboard session (cookie) ─────────────────────────────────────────────
let cookie = "";
let loginInFlight = null;

async function login() {
  if (loginInFlight) return loginInFlight;
  loginInFlight = (async () => {
    const { user, password } = credentials();
    const res = await dfetch(`${DASH}/auth/password-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: PROVIDER, username: user, password }),
    });
    if (!res.ok) throw new Error(`dashboard login failed: HTTP ${res.status}`);
    cookie = res
      .headers.getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    if (!cookie) throw new Error("dashboard login returned no cookie");
    log("dashboard login ok");
  })().finally(() => {
    loginInFlight = null;
  });
  return loginInFlight;
}

async function mintTicket() {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!cookie) await login();
    const res = await dfetch(`${DASH}/api/auth/ws-ticket`, { method: "POST", headers: { cookie } });
    if (res.status === 401) {
      cookie = "";
      continue;
    }
    if (!res.ok) throw new Error(`ws-ticket failed: HTTP ${res.status}`);
    const body = await res.json();
    return body.ticket;
  }
  throw new Error("ws-ticket: unauthorized after re-login");
}

// ── origin guard ───────────────────────────────────────────────────────────
function originAllowed(origin) {
  if (!origin) return true; // non-browser client (curl/node)
  if (EXTRA_ORIGINS.includes(origin)) return true;
  try {
    const u = new URL(origin);
    return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  } catch {
    return false;
  }
}

// ── HTTP: health + REST passthrough ───────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const cors = origin && originAllowed(origin) ? { "access-control-allow-origin": origin, vary: "Origin" } : {};
  if (req.method === "OPTIONS") {
    res.writeHead(204, { ...cors, "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE" });
    return res.end();
  }
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/hermes/health") {
    let upstream = "down";
    try {
      upstream = (await dfetch(`${DASH}/api/auth/providers`)).ok ? "up" : "error";
    } catch {
      /* down */
    }
    res.writeHead(200, { "content-type": "application/json", ...cors });
    return res.end(JSON.stringify({ ok: true, upstream, dashboard: DASH, loggedIn: Boolean(cookie) }));
  }
  if (url.pathname.startsWith("/hermes/api/")) {
    if (!originAllowed(origin)) {
      res.writeHead(403);
      return res.end("origin not allowed");
    }
    try {
      if (!cookie) await login();
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const target = `${DASH}${url.pathname.replace("/hermes", "")}${url.search}`;
      const up = await dfetch(target, {
        method: req.method,
        headers: { cookie, ...(req.headers["content-type"] ? { "content-type": req.headers["content-type"] } : {}) },
        body: body && req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
      });
      res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/octet-stream", ...cors });
      return res.end(Buffer.from(await up.arrayBuffer()));
    } catch (e) {
      res.writeHead(502, cors);
      return res.end(String(e?.message ?? e));
    }
  }
  res.writeHead(404);
  res.end("not found");
});

// ── WS: /hermes/ws ↔ dashboard /api/ws ─────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname !== "/hermes/ws" || !originAllowed(req.headers.origin)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (client) => wss.emit("connection", client, req));
});

wss.on("connection", async (client) => {
  const pending = [];
  let upstream = null;
  client.on("message", (data, isBinary) => {
    const text = isBinary ? data : data.toString();
    if (upstream?.readyState === WebSocket.OPEN) upstream.send(text);
    else pending.push(text);
  });
  client.on("close", () => upstream?.close());
  try {
    const ticket = await mintTicket();
    const wsUrl = `${DASH.replace(/^http/, "ws")}/api/ws?ticket=${encodeURIComponent(ticket)}`;
    // No Origin header is sent by `ws`, which is what the dashboard's host/origin guard accepts.
    upstream = new WebSocket(wsUrl);
    upstream.on("open", () => {
      for (const t of pending.splice(0)) upstream.send(t);
    });
    upstream.on("message", (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(isBinary ? data : data.toString());
    });
    upstream.on("close", (code, reason) => {
      if (client.readyState === WebSocket.OPEN) client.close(code === 1005 ? 1000 : code, reason.toString().slice(0, 100));
    });
    upstream.on("error", (e) => {
      log("upstream error:", e.message);
      if (client.readyState === WebSocket.OPEN) client.close(1011, "upstream error");
    });
  } catch (e) {
    log("connect failed:", e.message);
    client.close(1011, String(e.message).slice(0, 100));
  }
});

server.listen(PORT, HOST, () => log(`listening on http://${HOST}:${PORT}  (dashboard ${DASH})`));
