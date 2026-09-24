// Regression test for @vbcdx/dsh-config-editor-plugin issue #16.
// Run with: npm test  (node --test, auto-discovers test/*.test.js)
//
// #16 — the dir-fd containment walk (pinnedParent, added for #13) silently
//      degraded to a string re-resolve when /proc/self/fd is unavailable
//      (a non-Linux host, or /proc not mounted). A security guard that
//      degrades in silence is indistinguishable from one that works, so the
//      plugin now warns loudly at startup (in apply) naming the specific
//      weakened protection, and keeps serving — option 2 of the ticket.
//
//      This forces supportsDirFdWalk() false via the test-only seam and asserts
//      apply() emits that warning; a companion case asserts the warning does
//      NOT fire on a host where the dir-fd walk is genuinely supported.
//
// No credential values appear here; there is no filesystem fixture to seed.

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const mod = await import(pathToFileURL(join(root, "lib/index.js")).href);

// Mount the plugin the way the DSH web server would (see the containment test),
// capturing everything console.warn emits during apply().
function applyCapturingWarnings() {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
  try {
    mod.apply({
      effect: (fn) => fn(),
      webServer: { register: () => () => {} }
    });
  } finally {
    console.warn = realWarn;
  }
  return warnings;
}

test("#16 startup warns loudly when the dir-fd containment walk is unsupported", () => {
  mod.__testHooks.forceDirFdWalkUnsupported = true;
  try {
    const warnings = applyCapturingWarnings();
    const degraded = warnings.find((w) => /\/proc\/self\/fd/.test(w) && /DEGRADED/.test(w));
    assert.ok(degraded, "apply must emit a degradation warning when the dir-fd walk is unsupported");
    assert.match(degraded, /intermediate-directory/i, "the warning must name the weakened guard");
    assert.match(degraded, /#13/, "the warning must reference the guard it degrades from");
  } finally {
    mod.__testHooks.forceDirFdWalkUnsupported = false;
  }
});

test("#16 no degradation warning fires when the dir-fd walk is supported", (t) => {
  mod.__testHooks.forceDirFdWalkUnsupported = false;
  if (!mod.supportsDirFdWalk()) {
    // Genuinely unsupported host (no /proc): the warning is expected here, so
    // this negative case does not apply. The hardened deploy target and CI both
    // run Linux with /proc, where the walk is supported and this case is live.
    t.skip("host lacks /proc/self/fd; the degraded-path warning is expected on it");
    return;
  }
  const warnings = applyCapturingWarnings();
  assert.ok(
    !warnings.some((w) => /DEGRADED/.test(w)),
    "no degradation warning may fire when the dir-fd walk is supported"
  );
});
