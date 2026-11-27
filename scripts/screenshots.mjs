/**
 * UI verification + screenshots for the docs (dev tool, not shipped).
 *
 * Serves the real page sources over http://127.0.0.1 with a `chrome` API stub,
 * seeds demo data into IndexedDB, renders the pages in headless Chrome (CDP) and
 * captures screenshots + console errors.
 *
 *   node scripts/screenshots.mjs
 *   CHROME_PATH=/usr/bin/google-chrome node scripts/screenshots.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHROME =
  process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const CDP_PORT = 9226;
const HTTP_PORT = 8765;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const OUT = path.join(ROOT, "docs", "media");
const PREVIEW = path.join(ROOT, ".preview", "site");
const profile = path.join(ROOT, ".preview", "profile");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ chrome stub */

const STUB = `(function () {
  const listeners = [];
  const store = {
    read() {
      try { return JSON.parse(localStorage.getItem("__stub_store__") || "{}"); } catch { return {}; }
    },
    write(value) { localStorage.setItem("__stub_store__", JSON.stringify(value)); }
  };
  const read = () => store.read();
  const write = (value) => store.write(value);

  const runtime = {
    id: "stub-extension-id",
    getManifest: () => ({ version: "2.0.0", name: "Colaborator" }),
    getURL: (resource) => new URL(resource, location.href).href,
    openOptionsPage: () => {},
    sendMessage: (message) => {
      if (!message || typeof message !== "object") return Promise.resolve({ ok: true });
      if (message.type === "poller:poll-one") return Promise.resolve({ ok: true, added: 0 });
      return Promise.resolve({ ok: true });
    },
    onMessage: { addListener: (fn) => listeners.push(fn), removeListener: () => {} },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    lastError: undefined
  };

  window.chrome = {
    runtime,
    storage: {
      local: {
        get: (key, callback) => {
          const all = read();
          let result;
          if (key == null) result = { ...all };
          else if (typeof key === "string") result = { [key]: all[key] };
          else if (Array.isArray(key)) result = Object.fromEntries(key.map((k) => [k, all[k]]));
          else result = { ...all };
          if (callback) { callback(result); return undefined; }
          return Promise.resolve(result);
        },
        set: (values, callback) => {
          write({ ...read(), ...values });
          if (callback) { callback(); return undefined; }
          return Promise.resolve();
        }
      },
      onChanged: { addListener: () => {}, removeListener: () => {} }
    },
    tabs: { create: () => Promise.resolve({}) },
    permissions: {
      contains: () => Promise.resolve(false),
      request: () => Promise.resolve(true)
    },
    notifications: { onClicked: { addListener: () => {} }, create: () => Promise.resolve() },
    action: {
      setBadgeText: () => Promise.resolve(),
      setBadgeBackgroundColor: () => Promise.resolve(),
      onClicked: { addListener: () => {} }
    },
    alarms: {
      get: () => Promise.resolve(undefined),
      create: () => Promise.resolve(),
      clear: () => Promise.resolve(),
      onAlarm: { addListener: () => {} }
    }
  };
})();`;

/* ------------------------------------------------------------------ static server */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function startServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${HTTP_PORT}`);
    let filePath = path.join(PREVIEW, decodeURIComponent(url.pathname));
    if (url.pathname === "/") filePath = path.join(PREVIEW, "html", "popup.html");
    if (
      !filePath.startsWith(PREVIEW) ||
      !fs.existsSync(filePath) ||
      fs.statSync(filePath).isDirectory()
    ) {
      response.writeHead(404).end("not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream"
    });
    fs.createReadStream(filePath).pipe(response);
  });
  return new Promise((resolve) => server.listen(HTTP_PORT, "127.0.0.1", () => resolve(server)));
}

function preparePreview() {
  fs.rmSync(PREVIEW, { recursive: true, force: true });
  fs.mkdirSync(PREVIEW, { recursive: true });
  fs.cpSync(path.join(SRC, "css"), path.join(PREVIEW, "css"), { recursive: true });
  fs.cpSync(path.join(SRC, "js"), path.join(PREVIEW, "js"), { recursive: true });
  fs.cpSync(path.join(SRC, "icons"), path.join(PREVIEW, "icons"), { recursive: true });
  fs.mkdirSync(path.join(PREVIEW, "html"), { recursive: true });
  fs.writeFileSync(path.join(PREVIEW, "stub.js"), STUB);
  for (const name of fs.readdirSync(path.join(SRC, "html"))) {
    let markup = fs.readFileSync(path.join(SRC, "html", name), "utf8");
    markup = markup.replace(
      '<script src="../js/theme-boot.js"></script>',
      '<script src="/stub.js"></script><script src="../js/theme-boot.js"></script>'
    );
    fs.writeFileSync(path.join(PREVIEW, "html", name), markup);
  }
  fs.writeFileSync(path.join(PREVIEW, "blank.html"), "<!doctype html><title>blank</title>");
}

/* ------------------------------------------------------------------ CDP client */

class Client {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.errors = [];
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
        return;
      }
      if (message.method === "Runtime.exceptionThrown") {
        this.errors.push(
          `exception: ${message.params.exceptionDetails.text} ${message.params.exceptionDetails.exception?.description ?? ""}`
        );
      }
      if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
        this.errors.push(`log: ${message.params.entry.text}`);
      }
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        this.errors.push(
          `console: ${message.params.args.map((a) => a.value ?? a.description).join(" ")}`
        );
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    return new Client(ws);
  }

  send(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout ${method}`));
      }, 20000);
    });
  }
}

async function waitForChrome() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (response.ok) return response.json();
    } catch {
      /* not ready */
    }
    await sleep(250);
  }
  throw new Error("Chrome DevTools did not start");
}

/* ------------------------------------------------------------------ demo data */

function seedExpression() {
  const now = Date.now();
  const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
  const sessions = [
    {
      id: "sess-acme",
      name: "ACME — SSRF (prod)",
      keyB64: "o/HJ0ntOYIWhw+X3CStNb4oMLkttjxo8XnudDypMboA=",
      publicUrl: "https://3f9a2c8b1d.oastify.com",
      privateUrl:
        "https://polling.oastify.com:443/burpresults?biid=o%2FHJ0ntOYIWhw%2BX3CStNb4oMLkttjxo8XnudDypMboA%3D",
      host: "oastify.com",
      active: true,
      createdAt: now - 86_400_000,
      updatedAt: now - 60_000,
      lastPollAt: now - 45_000,
      lastStatus: 200,
      lastError: "",
      errorCount: 0,
      nextAttemptAt: 0,
      interactionCount: 7,
      lastInteractionAt: now - 120_000
    },
    {
      id: "sess-dns",
      name: "DNS rebinding — staging",
      keyB64: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=",
      publicUrl: "https://a71c94d0b2.oastify.com",
      privateUrl:
        "https://polling.oastify.com:443/burpresults?biid=AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA%3D",
      host: "oastify.com",
      active: true,
      createdAt: now - 43_200_000,
      updatedAt: now - 180_000,
      lastPollAt: now - 150_000,
      lastStatus: 200,
      lastError: "",
      errorCount: 0,
      nextAttemptAt: 0,
      interactionCount: 3,
      lastInteractionAt: now - 240_000
    },
    {
      id: "sess-staging",
      name: "Staging callback",
      keyB64: "//////////////////////////////////////////8=",
      publicUrl: "https://c0ffee1234.oastify.com",
      privateUrl:
        "https://polling.oastify.com:443/burpresults?biid=%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F8%3D",
      host: "oastify.com",
      active: false,
      createdAt: now - 7_200_000,
      updatedAt: now - 900_000,
      lastPollAt: now - 900_000,
      lastStatus: 502,
      lastError: "HTTP 502: Bad Gateway",
      errorCount: 2,
      nextAttemptAt: now + 60_000,
      interactionCount: 0,
      lastInteractionAt: null
    }
  ];

  const logs = [
    {
      id: "log-http-1",
      sessionId: "sess-acme",
      ts: now - 120_000,
      protocol: "http",
      client: "203.0.113.42:51422",
      interactionString: "3f9a2c8b1d.oastify.com",
      opCode: "",
      requestB64: b64(
        [
          "GET /debug/config?url=http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data HTTP/1.1",
          "Host: 3f9a2c8b1d.oastify.com",
          "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36",
          "Accept: */*",
          "Cookie: session=eyJhbGciOiJIUzI1NiJ9.demo",
          "Authorization: Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.demo",
          "X-Forwarded-For: 10.24.0.7",
          "",
          ""
        ].join("\r\n")
      ),
      responseB64: b64(
        "HTTP/1.1 200 OK\r\nServer: nginx\r\nContent-Type: application/json\r\n\r\n{}"
      ),
      error: "",
      source: "poll"
    },
    {
      id: "log-dns-1",
      sessionId: "sess-acme",
      ts: now - 240_000,
      protocol: "dns",
      client: "203.0.113.42:39011",
      interactionString: "3f9a2c8b1d.oastify.com",
      opCode: "TXT",
      requestB64: b64("DNS 3f9a2c8b1d.oastify.com"),
      responseB64: b64("3f9a2c8b1d.oastify.com"),
      error: "",
      source: "poll"
    },
    {
      id: "log-smtp-1",
      sessionId: "sess-acme",
      ts: now - 360_000,
      protocol: "smtp",
      client: "198.51.100.9:25",
      interactionString: "3f9a2c8b1d.oastify.com",
      opCode: "",
      requestB64: b64(
        [
          "EHLO mail.corp.test",
          "MAIL FROM:<bounce@corp.test>",
          "RCPT TO:<victim@corp.test>",
          "DATA",
          "Subject: Password reset",
          "From: no-reply@corp.test",
          "To: victim@corp.test",
          "",
          "Click http://3f9a2c8b1d.oastify.com/reset"
        ].join("\r\n")
      ),
      responseB64: b64("250 OK"),
      error: "",
      source: "poll"
    },
    {
      id: "log-http-2",
      sessionId: "sess-acme",
      ts: now - 420_000,
      protocol: "http",
      client: "203.0.113.42:51501",
      interactionString: "3f9a2c8b1d.oastify.com",
      opCode: "",
      requestB64: b64(
        "POST /webhook HTTP/1.1\r\nHost: 3f9a2c8b1d.oastify.com\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 27\r\n\r\nuser=admin&password=hunter2"
      ),
      responseB64: "",
      error: "",
      source: "poll"
    },
    {
      id: "log-ldap-1",
      sessionId: "sess-acme",
      ts: now - 60_000,
      protocol: "ldap",
      client: "203.0.113.42:38912",
      interactionString: "3f9a2c8b1d.oastify.com",
      opCode: "",
      requestB64: Buffer.from(
        "300c020101600702010304008000300c020101600702010304008000",
        "hex"
      ).toString("base64"),
      responseB64: Buffer.from("300c02010161070a010004000400", "hex").toString("base64"),
      error: "",
      source: "poll"
    },
    {
      id: "log-dns-3",
      sessionId: "sess-acme",
      ts: now - 500_000,
      protocol: "dns",
      client: "198.51.100.9:41002",
      interactionString: "3f9a2c8b1d.oastify.com",
      opCode: "A",
      requestB64: b64("DNS 3f9a2c8b1d.oastify.com"),
      responseB64: "",
      error: "",
      source: "poll"
    },
    {
      id: "log-http-5",
      sessionId: "sess-acme",
      ts: now - 520_000,
      protocol: "http",
      client: "203.0.113.42:51555",
      interactionString: "3f9a2c8b1d.oastify.com",
      opCode: "",
      requestB64: b64("OPTIONS / HTTP/1.1\r\nHost: 3f9a2c8b1d.oastify.com\r\n\r\n"),
      responseB64: "",
      error: "",
      source: "poll"
    },
    {
      id: "log-dns-2",
      sessionId: "sess-dns",
      ts: now - 240_000,
      protocol: "dns",
      client: "192.0.2.77:5353",
      interactionString: "a71c94d0b2.oastify.com",
      opCode: "A",
      requestB64: b64("DNS a71c94d0b2.oastify.com"),
      responseB64: "",
      error: "",
      source: "poll"
    },
    {
      id: "log-http-3",
      sessionId: "sess-dns",
      ts: now - 300_000,
      protocol: "http",
      client: "192.0.2.77:44811",
      interactionString: "a71c94d0b2.oastify.com",
      opCode: "",
      requestB64: b64(
        "POST /webhook HTTP/1.1\r\nHost: a71c94d0b2.oastify.com\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 27\r\n\r\nuser=admin&password=hunter2"
      ),
      responseB64: "",
      error: "",
      source: "poll"
    }
  ].map((log) => ({ ...log, raw: "" }));

  return `(async () => {
    const sessions = ${JSON.stringify(sessions)};
    const logs = ${JSON.stringify(logs)};
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("session_manager_pro", 2);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("sessions")) database.createObjectStore("sessions", { keyPath: "id" });
        let store;
        if (!database.objectStoreNames.contains("logs")) store = database.createObjectStore("logs", { keyPath: "id" });
        else store = request.transaction.objectStore("logs");
        for (const name of ["sessionId", "ts", "protocol", "fingerprint"]) {
          if (!store.indexNames.contains(name)) store.createIndex(name, name, { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(["sessions", "logs"], "readwrite");
    for (const session of sessions) tx.objectStore("sessions").put(session);
    for (const log of logs) tx.objectStore("logs").put(log);
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    db.close();
    return "seeded " + sessions.length + " sessions / " + logs.length + " logs";
  })()`;
}

/* ------------------------------------------------------------------ capture */

async function capture({ url, out, width, height, client, after, fit = false }) {
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("Log.enable");
  await client.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: false
  });
  await client.send("Page.navigate", { url });
  await sleep(1800);
  if (after) {
    await client.send("Runtime.evaluate", { expression: after, awaitPromise: true });
    await sleep(700);
  }
  if (fit) {
    const measured = await client.send("Runtime.evaluate", {
      expression: "document.body.scrollHeight",
      returnByValue: true
    });
    const fitted = Math.min(Number(measured.result.value) || height, 620);
    if (fitted && fitted !== height) {
      await client.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: fitted,
        deviceScaleFactor: 2,
        mobile: false
      });
      await sleep(400);
    }
  }
  const info = await client.send("Runtime.evaluate", {
    expression: `JSON.stringify({
      title: document.title,
      cards: document.querySelectorAll(".session-card").length,
      rows: document.querySelectorAll(".log-row").length,
      badge: document.querySelector("#countBadge")?.textContent ?? null,
      logCount: document.querySelector("#logCount")?.textContent ?? null,
      inspector: document.querySelector("#inspSummary")?.textContent ?? null,
      fields: document.querySelectorAll("#inspFields dt").length,
      toasts: Array.from(document.querySelectorAll(".toast")).map((n) => n.textContent.trim())
    })`,
    returnByValue: true
  });
  const screenshot = await client.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(out, Buffer.from(screenshot.data, "base64"));
  return JSON.parse(info.result.value);
}

/* ------------------------------------------------------------------ main */

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(profile, { recursive: true, force: true });
  preparePreview();
  const server = await startServer();

  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      "about:blank"
    ],
    { stdio: "ignore" }
  );

  try {
    await waitForChrome();
    const target = await (
      await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" })
    ).json();
    const client = await Client.connect(target.webSocketDebuggerUrl);

    const base = `http://127.0.0.1:${HTTP_PORT}`;
    await client.send("Page.enable");
    await client.send("Page.navigate", { url: `${base}/blank.html` });
    await sleep(600);
    const seeded = await client.send("Runtime.evaluate", {
      expression: seedExpression(),
      awaitPromise: true,
      returnByValue: true
    });
    console.log("seed:", seeded.result.value);

    const popup = await capture({
      url: `${base}/html/popup.html`,
      out: path.join(OUT, "popup.png"),
      width: 440,
      height: 600,
      client,
      fit: true
    });
    console.log("popup:", JSON.stringify(popup));

    const session = await capture({
      url: `${base}/html/session.html?id=sess-acme`,
      out: path.join(OUT, "session.png"),
      width: 1440,
      height: 900,
      client,
      after: `(async () => {
        document.querySelectorAll(".log-row")[1]?.click();
        await new Promise((r) => setTimeout(r, 200));
        document.querySelector("[data-mode=\x27text\x27]")?.click();
      })()`
    });
    console.log("session:", JSON.stringify(session));

    await capture({
      url: `${base}/html/session.html?id=sess-acme`,
      out: path.join(OUT, "session-light.png"),
      width: 1440,
      height: 900,
      client,
      after: `(async () => {
        localStorage.setItem("colaborator-theme", "light");
        document.documentElement.setAttribute("data-theme", "light");
        document.documentElement.setAttribute("data-theme-mode", "light");
        document.querySelector(".log-row")?.click();
        await new Promise((r) => setTimeout(r, 150));
        document.querySelector("[data-mode='hex']")?.click();
        await new Promise((r) => setTimeout(r, 250));
      })()`
    });

    const options = await capture({
      url: `${base}/html/options.html`,
      out: path.join(OUT, "options.png"),
      width: 1100,
      height: 1180,
      client
    });
    console.log("options:", JSON.stringify(options));

    console.log("ERRORS:", client.errors.length ? client.errors : "none");
    fs.writeFileSync(
      path.join(ROOT, ".preview", "ui-errors.json"),
      JSON.stringify(client.errors, null, 2)
    );
  } finally {
    chrome.kill();
    server.close();
  }
}

main().catch((error) => {
  console.error("FAILED:", error);
  process.exit(1);
});
