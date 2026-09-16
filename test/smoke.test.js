// Smoke tests for @vbcdx/dsh-config-editor-plugin.
// Run with: npm test  (node --test, auto-discovers test/*.test.js)

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const mod = await import(pathToFileURL(join(root, "lib/index.js")).href);

test("host half exports the composition plugin contract", () => {
  assert.equal(typeof mod.apply, "function", "apply must be a function");
  assert.ok(Array.isArray(mod.inject), "inject must be an array");
  assert.ok(mod.inject.includes("webServer"), "inject must declare webServer");
});

test("browser half registers under the package name", () => {
  const src = readFileSync(join(root, "lib/client.js"), "utf8");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.ok(
    src.includes("window.__ModuleLoader__.load"),
    "must register via the module loader"
  );
  // The dsh web shell builds its client-module manifest rows from the PACKAGE
  // NAME, then asserts that the loaded bundle registered a factory under that
  // exact id (see @deepseek-ai/dsh-client-modules: arrive() throws
  // "loaded without registering <id> via __ModuleLoader__.load"). Derive the
  // expectation from package.json so the bundle and the manifest cannot drift.
  assert.ok(
    src.includes(`id: "${pkg.name}"`),
    `must register under the package name "${pkg.name}"`
  );
});

test("document listing uses agent.cordis.yml (the real preset filename)", () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-ce-test-"));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    writeFileSync(join(home, "settings.yaml"), "x: 1\n");
    mkdirSync(join(home, ".agent-presets", "code-agent"), { recursive: true });
    writeFileSync(join(home, ".agent-presets", "code-agent", "agent.cordis.yml"), "rows: []\n");
    // A preset dir using the OLD wrong filename must NOT be listed.
    mkdirSync(join(home, ".agent-presets", "legacy"), { recursive: true });
    writeFileSync(join(home, ".agent-presets", "legacy", "cordis.yml"), "rows: []\n");

    const docs = mod.listDocuments();
    const ids = docs.map((d) => d.id);
    assert.ok(ids.includes("settings"), "fixed doc: settings");
    assert.ok(ids.includes("reverse-proxy"), "fixed doc: reverse-proxy");
    assert.ok(ids.includes("credentials"), "fixed doc: credentials");
    assert.ok(ids.includes("preset:code-agent"), "preset with agent.cordis.yml must be listed");
    assert.ok(!ids.includes("preset:legacy"), "preset with only cordis.yml must not be listed");

    const preset = docs.find((d) => d.id === "preset:code-agent");
    assert.ok(preset.label.includes("agent.cordis.yml"), "label must name the real filename");
    assert.equal(preset.path, join(home, ".agent-presets", "code-agent", "agent.cordis.yml"));

    assert.equal(mod.resolveDocPath("preset:code-agent"), preset.path);
    assert.equal(mod.resolveDocPath("preset:legacy"), null);
    assert.equal(mod.resolveDocPath("../settings.yaml"), null, "no path traversal");
    assert.equal(mod.resolveDocPath(""), null);
    assert.equal(mod.resolveDocPath("settings"), join(home, "settings.yaml"));
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("package manifest is installable as a DSH bundle", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.name, "@vbcdx/dsh-config-editor-plugin");
  assert.equal(pkg.dsh.plugin, true, "dsh.plugin must be true");
  assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
  assert.equal(pkg.publishConfig.access, "public");
  assert.ok(pkg.files.includes(".env.example"), ".env.example must be shipped");
});

test("env example documents DSH_HOME with placeholders only", () => {
  const env = readFileSync(join(root, ".env.example"), "utf8");
  assert.ok(env.includes("DSH_HOME"), "must document DSH_HOME");
  assert.ok(!/[A-Za-z0-9_-]{32,}/.test(env), "must not contain real-looking secrets");
});
