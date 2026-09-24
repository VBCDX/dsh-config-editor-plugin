// Request-trust regression tests for @vbcdx/dsh-config-editor-plugin (issue #3).
// Run with: npm test  (node --test, auto-discovers test/*.test.js)
//
// These exercise the actual registered HTTP route on an isolated loopback
// server with a synthetic DSH_HOME, sending raw requests so Host, Origin,
// Sec-Fetch-Site, and Content-Type are controlled exactly. They prove:
//   - denied reads return no file content (403),
//   - denied writes create no backup and change no file (403 / 415),
//     including text/plain JSON POSTs,
//   - authorized same-origin list / read / write still work.
// All credential material here is obviously-synthetic (SENTINEL-NOT-REAL-*).

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const mod = await import(pathToFileURL(join(root, "lib/index.js")).href);

// Obviously-synthetic sentinels — never real credentials.
const SENTINEL_CRED = "openai_api_key: SENTINEL-NOT-REAL-0001\n";
const SENTINEL_SETTINGS = "sentinel: original-value-0002\n";

// Capture the handler the plugin registers, the way the DSH web server would:
// apply() calls ctx.effect(() => ctx.webServer.register({ kind, path, handler })).
function registeredHandler() {
  let route;
  const ctx = {
    effect: (fn) => fn(),
    webServer: {
      register: (r) => {
        route = r;
        return () => {};
      }
    }
  };
  mod.apply(ctx);
  assert.ok(route, "apply must register a route");
  assert.equal(route.kind, "exact", "route must be exact-path");
  assert.equal(route.path, "/plugins/config-editor", "route must be the config-editor path");
  assert.equal(typeof route.handler, "function", "route must carry a handler");
  return route.handler;
}

// Stand the registered handler on an isolated loopback server with a synthetic
// DSH_HOME and run `body(ctx)` against it.
async function withServer(body) {
  const home = mkdtempSync(join(tmpdir(), "dsh-ce-trust-"));
  writeFileSync(join(home, "settings.yaml"), SENTINEL_SETTINGS);
  writeFileSync(join(home, ".credentials.yaml"), SENTINEL_CRED);
  writeFileSync(join(home, "reverse-proxy.json"), '{ "sentinel": "0005" }\n');
  mkdirSync(join(home, ".agent-presets", "code-agent"), { recursive: true });
  writeFileSync(join(home, ".agent-presets", "code-agent", "agent.cordis.yml"), "rows: []\n");

  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const handler = registeredHandler();
  const server = createServer((req, res) => handler(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    await body({ home, port });
  } finally {
    await new Promise((r) => server.close(r));
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

// Raw request helper: connects to loopback but sets whatever Host/Origin/etc.
// headers the caller passes (fetch would force a same-origin Host).
function request(port, { method = "GET", path = "/plugins/config-editor", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: "127.0.0.1", port, method, path, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function backupCount(home) {
  return readdirSync(home).filter((f) => f.includes(".bak.")).length;
}

const CROSS_SITE = {
  host: "untrusted.example",
  origin: "https://untrusted.example",
  "sec-fetch-site": "cross-site"
};

test("cross-site GET read of credentials is refused and leaks no content", async () => {
  await withServer(async ({ port }) => {
    const res = await request(port, { path: "/plugins/config-editor?id=credentials", headers: CROSS_SITE });
    assert.equal(res.status, 403, "cross-site read must be forbidden");
    assert.ok(!res.body.includes("SENTINEL-NOT-REAL-0001"), "response must not echo credential contents");
  });
});

test("cross-site GET document list is refused and leaks no paths", async () => {
  await withServer(async ({ home, port }) => {
    const res = await request(port, { headers: CROSS_SITE });
    assert.equal(res.status, 403, "cross-site list must be forbidden");
    assert.ok(!res.body.includes(home), "response must not echo filesystem paths");
  });
});

test("cross-site text/plain POST is refused; no backup, no file change", async () => {
  await withServer(async ({ home, port }) => {
    const before = readFileSync(join(home, "settings.yaml"), "utf8");
    const res = await request(port, {
      method: "POST",
      headers: { ...CROSS_SITE, "content-type": "text/plain" },
      body: JSON.stringify({ id: "settings", content: "pwned: SENTINEL-NOT-REAL-0003\n" })
    });
    assert.equal(res.status, 403, "cross-site write must be forbidden");
    assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), before, "settings.yaml must be unchanged");
    assert.equal(backupCount(home), 0, "no backup may be created for a denied write");
  });
});

test("loopback Host with foreign Origin is refused", async () => {
  await withServer(async ({ port }) => {
    const res = await request(port, {
      path: "/plugins/config-editor?id=credentials",
      headers: { host: `127.0.0.1:${port}`, origin: "https://evil.example" }
    });
    assert.equal(res.status, 403, "foreign Origin must be forbidden even on a loopback Host");
    assert.ok(!res.body.includes("SENTINEL-NOT-REAL-0001"), "response must not echo credential contents");
  });
});

test("same-origin text/plain JSON POST is refused for wrong Content-Type; no write", async () => {
  await withServer(async ({ home, port }) => {
    const before = readFileSync(join(home, "settings.yaml"), "utf8");
    const res = await request(port, {
      method: "POST",
      headers: {
        host: `127.0.0.1:${port}`,
        origin: `http://127.0.0.1:${port}`,
        "sec-fetch-site": "same-origin",
        "content-type": "text/plain"
      },
      body: JSON.stringify({ id: "settings", content: "pwned: SENTINEL-NOT-REAL-0006\n" })
    });
    assert.equal(res.status, 415, "wrong Content-Type must be rejected");
    assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), before, "settings.yaml must be unchanged");
    assert.equal(backupCount(home), 0, "no backup may be created for a rejected write");
  });
});

test("authorized same-origin requests still work: list, read (settings/credentials/preset), write", async () => {
  await withServer(async ({ home, port }) => {
    const auth = {
      host: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      "sec-fetch-site": "same-origin"
    };

    // GET list
    const list = await request(port, { headers: auth });
    assert.equal(list.status, 200, "authorized list must succeed");
    const ids = JSON.parse(list.body).docs.map((d) => d.id);
    for (const id of ["settings", "credentials", "reverse-proxy", "preset:code-agent"]) {
      assert.ok(ids.includes(id), `list must include ${id}`);
    }

    // GET individual documents
    const cred = await request(port, { path: "/plugins/config-editor?id=credentials", headers: auth });
    assert.equal(cred.status, 200, "authorized credentials read must succeed");
    assert.ok(JSON.parse(cred.body).content.includes("SENTINEL-NOT-REAL-0001"), "authorized read returns content");

    const preset = await request(port, { path: "/plugins/config-editor?id=preset:code-agent", headers: auth });
    assert.equal(preset.status, 200, "authorized preset read must succeed");
    assert.equal(JSON.parse(preset.body).content, "rows: []\n", "authorized preset content returned");

    // POST write with correct Content-Type
    const newContent = "sentinel: updated-value-0004\n";
    const write = await request(port, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ id: "settings", content: newContent })
    });
    assert.equal(write.status, 200, "authorized write must succeed");
    const written = JSON.parse(write.body);
    assert.equal(written.success, true, "write reports success");
    assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), newContent, "authorized write persists");
    assert.equal(backupCount(home), 1, "authorized write makes exactly one backup");
  });
});

test("non-browser loopback client with no Origin/Fetch-Metadata is allowed", async () => {
  // Over plain HTTP a legitimate loopback caller may attach neither Origin nor
  // Sec-Fetch-Site; the Host fence still admits it, so the editor is not
  // over-blocked.
  await withServer(async ({ port }) => {
    const res = await request(port, {
      path: "/plugins/config-editor?id=settings",
      headers: { host: `127.0.0.1:${port}` }
    });
    assert.equal(res.status, 200, "unmarked loopback read must succeed");
    assert.ok(JSON.parse(res.body).content.includes("original-value-0002"), "content returned");
  });
});
