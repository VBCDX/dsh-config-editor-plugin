// Regression tests for @vbcdx/dsh-config-editor-plugin issues #6 and #7.
// Run with: npm test  (node --test, auto-discovers test/*.test.js)
//
// #6 — document target containment: an existing symlink on an allowed path must
//      not let a read or write escape DSH_HOME. These stand the real registered
//      route on a loopback server (so the request-trust fence passes) and assert
//      that symlinked fixed files, symlinked preset files, symlinked preset
//      directories, and dangling symlinks are refused and leak nothing, while
//      genuine in-root regular documents remain editable.
//
// #7 — backup collisions: two saves sharing a millisecond must each get a
//      distinct, exclusively-created backup so the original recovery point is
//      never overwritten; a backup that cannot be created aborts the save and
//      leaves the file unchanged.
//
// All sentinel content is obviously-synthetic (OUTSIDE-*, SENTINEL-*).

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync,
  symlinkSync, existsSync, renameSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const mod = await import(pathToFileURL(join(root, "lib/index.js")).href);

// Capture the handler the plugin registers, the way the DSH web server would.
function registeredHandler() {
  let route;
  mod.apply({
    effect: (fn) => fn(),
    webServer: { register: (r) => { route = r; return () => {}; } }
  });
  assert.ok(route && typeof route.handler === "function", "apply must register a handler");
  return route.handler;
}

// Same-origin loopback headers — the request-trust fence admits these.
const AUTH = (port) => ({
  host: `127.0.0.1:${port}`,
  origin: `http://127.0.0.1:${port}`,
  "sec-fetch-site": "same-origin"
});

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

function backups(home) {
  return readdirSync(home).filter((f) => f.includes(".bak."));
}

// Build a synthetic DSH_HOME (and a sibling "outside" dir that is NOT under the
// home root), let `setup` populate them, stand the route on loopback, run
// `body`, then tear everything down.
async function withHome(setup, body) {
  const home = mkdtempSync(join(tmpdir(), "dsh-ce-contain-home-"));
  const outside = mkdtempSync(join(tmpdir(), "dsh-ce-contain-outside-"));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const server = createServer((req, res) => registeredHandler()(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    setup({ home, outside });
    await body({ home, outside, port });
  } finally {
    await new Promise((r) => server.close(r));
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}

// Every home needs the three fixed files present so listing/reads of the
// untouched docs behave normally.
function seedFixedFiles(home) {
  writeFileSync(join(home, "settings.yaml"), "sentinel: original-0001\n");
  writeFileSync(join(home, ".credentials.yaml"), "openai_api_key: SENTINEL-NOT-REAL-0002\n");
  writeFileSync(join(home, "reverse-proxy.json"), '{ "sentinel": "0003" }\n');
}

// ── #6 containment ───────────────────────────────────────────────────────────

test("#6 symlinked fixed file: read refused, write refused, outside file untouched", async () => {
  await withHome(
    ({ home, outside }) => {
      writeFileSync(join(home, ".credentials.yaml"), "c: 1\n");
      writeFileSync(join(home, "reverse-proxy.json"), "{}\n");
      const secret = join(outside, "secret.yaml");
      writeFileSync(secret, "OUTSIDE-SECRET-0100\n");
      // settings.yaml is a symlink escaping the home root.
      symlinkSync(secret, join(home, "settings.yaml"));
    },
    async ({ outside, port }) => {
      const secret = join(outside, "secret.yaml");

      const read = await request(port, { path: "/plugins/config-editor?id=settings", headers: AUTH(port) });
      assert.equal(read.status, 404, "read through a symlinked fixed file must be refused");
      assert.ok(!read.body.includes("OUTSIDE-SECRET-0100"), "refusal must not leak outside content");
      assert.ok(!read.body.includes(outside), "refusal must not leak the resolved outside path");

      const write = await request(port, {
        method: "POST",
        headers: { ...AUTH(port), "content-type": "application/json" },
        body: JSON.stringify({ id: "settings", content: "INJECTED-0101\n" })
      });
      assert.equal(write.status, 404, "write through a symlinked fixed file must be refused");
      assert.equal(readFileSync(secret, "utf8"), "OUTSIDE-SECRET-0100\n", "outside file must be unchanged");
    }
  );
});

test("#6 symlinked preset file: not listed, read/write refused, outside file untouched", async () => {
  await withHome(
    ({ home, outside }) => {
      seedFixedFiles(home);
      const target = join(outside, "target.yml");
      writeFileSync(target, "OUTSIDE-PRESET-0200\n");
      mkdirSync(join(home, ".agent-presets", "sneaky"), { recursive: true });
      // The terminal agent.cordis.yml is itself a symlink escaping the root.
      symlinkSync(target, join(home, ".agent-presets", "sneaky", "agent.cordis.yml"));
    },
    async ({ outside, port }) => {
      const target = join(outside, "target.yml");

      const list = await request(port, { headers: AUTH(port) });
      assert.equal(list.status, 200, "list must still succeed");
      assert.ok(!list.body.includes("preset:sneaky"), "escaping preset must not be listed");

      const read = await request(port, { path: "/plugins/config-editor?id=preset:sneaky", headers: AUTH(port) });
      assert.equal(read.status, 404, "read of escaping preset must be refused");
      assert.ok(!read.body.includes("OUTSIDE-PRESET-0200"), "refusal must not leak outside content");

      const write = await request(port, {
        method: "POST",
        headers: { ...AUTH(port), "content-type": "application/json" },
        body: JSON.stringify({ id: "preset:sneaky", content: "INJECTED-0201\n" })
      });
      assert.equal(write.status, 404, "write of escaping preset must be refused");
      assert.equal(readFileSync(target, "utf8"), "OUTSIDE-PRESET-0200\n", "outside file must be unchanged");
    }
  );
});

test("#6 symlinked preset DIRECTORY (regular-file terminal): parent-symlink is caught", async () => {
  // The terminal agent.cordis.yml is a genuine regular file — only the parent
  // directory is a symlink. O_NOFOLLOW on the terminal alone would miss this;
  // the component walk must reject it.
  await withHome(
    ({ home, outside }) => {
      seedFixedFiles(home);
      writeFileSync(join(outside, "agent.cordis.yml"), "OUTSIDE-DIR-0300\n");
      mkdirSync(join(home, ".agent-presets"), { recursive: true });
      symlinkSync(outside, join(home, ".agent-presets", "inter"));
    },
    async ({ outside, port }) => {
      const target = join(outside, "agent.cordis.yml");

      const list = await request(port, { headers: AUTH(port) });
      assert.ok(!list.body.includes("preset:inter"), "preset behind a symlinked dir must not be listed");

      const read = await request(port, { path: "/plugins/config-editor?id=preset:inter", headers: AUTH(port) });
      assert.equal(read.status, 404, "read behind a symlinked parent dir must be refused");
      assert.ok(!read.body.includes("OUTSIDE-DIR-0300"), "refusal must not leak outside content");

      const write = await request(port, {
        method: "POST",
        headers: { ...AUTH(port), "content-type": "application/json" },
        body: JSON.stringify({ id: "preset:inter", content: "INJECTED-0301\n" })
      });
      assert.equal(write.status, 404, "write behind a symlinked parent dir must be refused");
      assert.equal(readFileSync(target, "utf8"), "OUTSIDE-DIR-0300\n", "outside file must be unchanged");
    }
  );
});

test("#6 dangling preset symlink is refused and not listed", async () => {
  await withHome(
    ({ home }) => {
      seedFixedFiles(home);
      mkdirSync(join(home, ".agent-presets", "dangling"), { recursive: true });
      symlinkSync(join(home, "does-not-exist.yml"), join(home, ".agent-presets", "dangling", "agent.cordis.yml"));
    },
    async ({ port }) => {
      const list = await request(port, { headers: AUTH(port) });
      assert.ok(!list.body.includes("preset:dangling"), "dangling preset must not be listed");
      const read = await request(port, { path: "/plugins/config-editor?id=preset:dangling", headers: AUTH(port) });
      assert.equal(read.status, 404, "read of a dangling symlink must be refused");
    }
  );
});

test("#6 genuine in-root documents remain listed, readable, and writable", async () => {
  await withHome(
    ({ home }) => {
      seedFixedFiles(home);
      mkdirSync(join(home, ".agent-presets", "code-agent"), { recursive: true });
      writeFileSync(join(home, ".agent-presets", "code-agent", "agent.cordis.yml"), "rows: []\n");
    },
    async ({ home, port }) => {
      const list = await request(port, { headers: AUTH(port) });
      const ids = JSON.parse(list.body).docs.map((d) => d.id);
      for (const id of ["settings", "credentials", "reverse-proxy", "preset:code-agent"]) {
        assert.ok(ids.includes(id), `list must include ${id}`);
      }

      const read = await request(port, { path: "/plugins/config-editor?id=settings", headers: AUTH(port) });
      assert.equal(read.status, 200, "in-root read must succeed");
      assert.ok(JSON.parse(read.body).content.includes("original-0001"), "in-root read returns content");

      const preset = await request(port, { path: "/plugins/config-editor?id=preset:code-agent", headers: AUTH(port) });
      assert.equal(JSON.parse(preset.body).content, "rows: []\n", "in-root preset content returned");

      const write = await request(port, {
        method: "POST",
        headers: { ...AUTH(port), "content-type": "application/json" },
        body: JSON.stringify({ id: "settings", content: "sentinel: updated-0004\n" })
      });
      assert.equal(write.status, 200, "in-root write must succeed");
      assert.equal(JSON.parse(write.body).success, true, "write reports success");
      assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), "sentinel: updated-0004\n", "in-root write persists");
      assert.equal(backups(home).length, 1, "in-root write makes exactly one backup");
    }
  );
});

// ── #7 backup collisions ─────────────────────────────────────────────────────

test("#7 two saves in one frozen millisecond keep two distinct backups (A and B preserved, file has C)", async () => {
  const realNow = Date.now;
  Date.now = () => 1700000000000; // freeze: model B and C saved in the same ms
  try {
    await withHome(
      ({ home }) => {
        writeFileSync(join(home, "settings.yaml"), "A\n");
        writeFileSync(join(home, ".credentials.yaml"), "c: 1\n");
        writeFileSync(join(home, "reverse-proxy.json"), "{}\n");
      },
      async ({ home, port }) => {
        const b = await request(port, {
          method: "POST", headers: { ...AUTH(port), "content-type": "application/json" },
          body: JSON.stringify({ id: "settings", content: "B\n" })
        });
        const c = await request(port, {
          method: "POST", headers: { ...AUTH(port), "content-type": "application/json" },
          body: JSON.stringify({ id: "settings", content: "C\n" })
        });
        assert.equal(b.status, 200);
        assert.equal(c.status, 200);
        const bBak = JSON.parse(b.body).backup;
        const cBak = JSON.parse(c.body).backup;
        assert.notEqual(bBak, cBak, "the two saves must not share a backup path");

        const baks = backups(home);
        assert.equal(baks.length, 2, "two saves must leave two backups");
        assert.equal(readFileSync(bBak, "utf8"), "A\n", "first backup preserves the original A");
        assert.equal(readFileSync(cBak, "utf8"), "B\n", "second backup preserves B");
        assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), "C\n", "live file holds the latest C");
      }
    );
  } finally {
    Date.now = realNow;
  }
});

test("#7 a pre-existing colliding backup is never overwritten", async () => {
  const realNow = Date.now;
  Date.now = () => 1700000000000;
  try {
    await withHome(
      ({ home }) => {
        writeFileSync(join(home, "settings.yaml"), "A\n");
        writeFileSync(join(home, ".credentials.yaml"), "c: 1\n");
        writeFileSync(join(home, "reverse-proxy.json"), "{}\n");
        // A backup with the exact name this save would choose already exists.
        writeFileSync(join(home, "settings.yaml.bak.1700000000000"), "PRE-EXISTING-0400\n");
      },
      async ({ home, port }) => {
        const save = await request(port, {
          method: "POST", headers: { ...AUTH(port), "content-type": "application/json" },
          body: JSON.stringify({ id: "settings", content: "B\n" })
        });
        assert.equal(save.status, 200, "save must still succeed by disambiguating");
        const bak = JSON.parse(save.body).backup;
        assert.notEqual(bak, join(home, "settings.yaml.bak.1700000000000"), "must not reuse the colliding name");
        assert.equal(readFileSync(join(home, "settings.yaml.bak.1700000000000"), "utf8"), "PRE-EXISTING-0400\n", "pre-existing backup must be untouched");
        assert.equal(readFileSync(bak, "utf8"), "A\n", "new backup preserves the original A");
        assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), "B\n", "live file holds B");
      }
    );
  } finally {
    Date.now = realNow;
  }
});

test("#7 backup creation failure aborts the save and leaves the file unchanged", async () => {
  const realNow = Date.now;
  Date.now = () => 1700000000000;
  try {
    await withHome(
      ({ home }) => {
        writeFileSync(join(home, "settings.yaml"), "ORIGINAL-0500\n");
        writeFileSync(join(home, ".credentials.yaml"), "c: 1\n");
        writeFileSync(join(home, "reverse-proxy.json"), "{}\n");
        // Occupy every candidate backup name so exclusive creation cannot
        // succeed — a deterministic, uid-independent backup failure.
        const base = join(home, "settings.yaml.bak.1700000000000");
        writeFileSync(base, "");
        for (let i = 1; i < mod.MAX_BACKUP_ATTEMPTS; i++) writeFileSync(base + "-" + i, "");
      },
      async ({ home, port }) => {
        const save = await request(port, {
          method: "POST", headers: { ...AUTH(port), "content-type": "application/json" },
          body: JSON.stringify({ id: "settings", content: "SHOULD-NOT-PERSIST-0501\n" })
        });
        assert.equal(save.status, 500, "save must fail when no backup can be created");
        assert.match(JSON.parse(save.body).error, /Backup failed/, "error must name the backup failure");
        assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), "ORIGINAL-0500\n", "original file must be left unchanged");
      }
    );
  } finally {
    Date.now = realNow;
  }
});

test("#7 createBackup propagates a non-collision error (source vanished)", () => {
  // A backup failure that is not EEXIST (here, a missing source file in an
  // otherwise valid parent) must throw rather than be swallowed, and must roll
  // back the empty backup it created, so the caller can abort the save with no
  // stray recovery point left behind.
  const dir = mkdtempSync(join(tmpdir(), "dsh-ce-bak-"));
  try {
    assert.throws(() => mod.createBackup(dir, "no-such-file.yaml"), /ENOENT|no such file/i);
    assert.equal(existsSync(join(dir, "no-such-file.yaml")), false, "the source is never created");
    assert.equal(readdirSync(dir).length, 0, "a failed backup rolls back and leaves no stray file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #13 intermediate-directory TOCTOU ─────────────────────────────────────────

// These arm __testHooks.beforeTerminalOpen — a test-only seam fired after the
// containment walk and just before the terminal is opened — to swap a checked
// intermediate directory for an out-of-root symlink at exactly that instant.
// A string re-open of the resolved path would now follow the swap to the outside
// file; the pinned dir-fd walk holds the real parent by descriptor and must not.
// The hook is always cleared in a finally so it never leaks to another test.

test("#13 an intermediate dir swapped for a symlink between check and open cannot redirect a read", async () => {
  await withHome(
    ({ home, outside }) => {
      seedFixedFiles(home);
      mkdirSync(join(home, ".agent-presets", "victim"), { recursive: true });
      writeFileSync(join(home, ".agent-presets", "victim", "agent.cordis.yml"), "IN-ROOT-PRESET-1300\n");
      writeFileSync(join(outside, "agent.cordis.yml"), "OUTSIDE-SECRET-1301\n");
    },
    async ({ home, outside, port }) => {
      let fired = false;
      mod.__testHooks.beforeTerminalOpen = () => {
        if (fired) return;
        fired = true;
        const victim = join(home, ".agent-presets", "victim");
        renameSync(victim, victim + ".real");        // move the real dir aside
        symlinkSync(outside, victim);                 // ...and hang a symlink in its place
      };
      try {
        const read = await request(port, { path: "/plugins/config-editor?id=preset:victim", headers: AUTH(port) });
        assert.ok(fired, "the swap hook must have fired between the check and the open");
        assert.equal(read.status, 200, "the legitimate in-root read still succeeds");
        assert.equal(JSON.parse(read.body).content, "IN-ROOT-PRESET-1300\n", "the pinned read returns the in-root file");
        assert.ok(!read.body.includes("OUTSIDE-SECRET-1301"), "the swap must not redirect the read outside the root");
      } finally {
        mod.__testHooks.beforeTerminalOpen = null;
      }
      assert.equal(readFileSync(join(outside, "agent.cordis.yml"), "utf8"), "OUTSIDE-SECRET-1301\n", "the outside file is untouched");
    }
  );
});

test("#13 an intermediate dir swapped for a symlink between check and open cannot redirect a write or its backup", async () => {
  await withHome(
    ({ home, outside }) => {
      seedFixedFiles(home);
      mkdirSync(join(home, ".agent-presets", "victim"), { recursive: true });
      writeFileSync(join(home, ".agent-presets", "victim", "agent.cordis.yml"), "IN-ROOT-PRESET-1310\n");
      writeFileSync(join(outside, "agent.cordis.yml"), "OUTSIDE-SECRET-1311\n");
    },
    async ({ home, outside, port }) => {
      let fired = false;
      mod.__testHooks.beforeTerminalOpen = () => {
        if (fired) return;
        fired = true;
        const victim = join(home, ".agent-presets", "victim");
        renameSync(victim, victim + ".real");
        symlinkSync(outside, victim);
      };
      let save;
      try {
        save = await request(port, {
          method: "POST",
          headers: { ...AUTH(port), "content-type": "application/json" },
          body: JSON.stringify({ id: "preset:victim", content: "REWRITTEN-1312\n" })
        });
        assert.ok(fired, "the swap hook must have fired between the check and the open");
      } finally {
        mod.__testHooks.beforeTerminalOpen = null;
      }
      assert.equal(save.status, 200, "the legitimate in-root write still succeeds");
      // The outside directory must be wholly untouched: no overwrite, no backup landed there.
      assert.equal(readFileSync(join(outside, "agent.cordis.yml"), "utf8"), "OUTSIDE-SECRET-1311\n", "the outside file is not overwritten");
      assert.deepEqual(readdirSync(outside), ["agent.cordis.yml"], "no backup may be written into the outside directory");
      // The real in-root document received the write, with its backup beside it.
      const realDir = join(home, ".agent-presets", "victim.real");
      assert.equal(readFileSync(join(realDir, "agent.cordis.yml"), "utf8"), "REWRITTEN-1312\n", "the in-root file holds the new content");
      assert.equal(readdirSync(realDir).filter((f) => f.includes(".bak.")).length, 1, "exactly one backup, beside the in-root file");
    }
  );
});
