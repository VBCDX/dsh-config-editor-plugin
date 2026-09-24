// Behavioral regressions for the config editor's document-state lifecycle.
//
//   #4 (P1) — a save must never write one document's buffer into another file.
//   #5 (P2) — switching documents or closing/reopening must not silently
//             discard unsaved edits.
//
// These drive the real lib/client.js bundle through a minimal hook/effect
// scheduler with a controllable fetch (test/support/client-harness.mjs), so
// they exercise the rendered ConfigEditorModal's state transitions — the layer
// the existing smoke tests (which only grep source strings) cannot reach.

import test from "node:test";
import assert from "node:assert/strict";
import { mountEditor } from "./support/client-harness.mjs";

const DOCS = [
	{ id: "settings", label: "settings.yaml", path: "/home/settings.yaml" },
	{ id: "preset:agent", label: "agent.cordis.yml", path: "/home/.agent-presets/agent/agent.cordis.yml" }
];

// Mount, open, load the doc list, and resolve the initially-selected doc's read.
async function bootWithSettings(settingsContent = "original settings") {
	const app = await mountEditor();
	await app.open();
	await app.resolveDocList(DOCS);
	// The first doc (settings) is auto-selected; complete its read.
	const read = app.pendingRead("settings");
	assert.ok(read, "settings read should be in flight after open");
	read.resolveJson({ content: settingsContent });
	await app.settle();
	return app;
}

// ------------------------------------------------------------------ #4 (P1) --

test("#4 a rejected read never makes the prior document's buffer saveable", async () => {
	const app = await bootWithSettings("original settings");
	await app.type("unsaved settings");
	assert.equal(app.snapshot().content, "unsaved settings");

	// Select the preset, then fail its read (network failure).
	await app.select("preset:agent");
	app.pendingRead("preset:agent").reject(new Error("network down"));
	await app.settle();

	const snap = app.snapshot();
	assert.equal(snap.selected, "preset:agent", "selection moved to the preset");
	assert.equal(snap.content, "", "the preset must not show the settings buffer");
	assert.equal(snap.readOnly, true, "an unloaded document is not editable");
	assert.equal(snap.saveDisabled, true, "an unloaded document is not saveable");

	// Even if a save is attempted, no write must be issued at all.
	await app.save();
	assert.equal(app.fetch.writes().length, 0, "no POST may target an unloaded document");
});

test("#4 a JSON-decode failure on read is treated the same as a rejected read", async () => {
	const app = await bootWithSettings("original settings");
	await app.type("unsaved settings");

	await app.select("preset:agent");
	app.pendingRead("preset:agent").resolveBadJson(); // HTTP ok, body undecodable
	await app.settle();

	const snap = app.snapshot();
	assert.equal(snap.content, "", "decode failure must not leave the prior buffer visible");
	assert.equal(snap.saveDisabled, true);
	await app.save();
	assert.equal(app.fetch.writes().length, 0, "no POST after a decode failure");
});

test("#4 a failed read after a CLEAN prior selection cannot be edited into a wrong-file save", async () => {
	const app = await bootWithSettings("original settings");
	// No edit — settings is clean.
	await app.select("preset:agent");
	app.pendingRead("preset:agent").reject(new Error("boom"));
	await app.settle();

	// Attempt to type into the still-visible textarea and save.
	await app.type("typed into a failed load");
	const snap = app.snapshot();
	assert.equal(snap.content, "", "typing is ignored while the document has not loaded");
	assert.equal(snap.saveDisabled, true);
	await app.save();
	assert.equal(app.fetch.writes().length, 0, "no POST from an unloaded document");
});

test("#4 a normal save targets its own id with its own buffer", async () => {
	const app = await bootWithSettings("original settings");
	await app.type("edited settings");
	await app.save();
	const write = app.pendingWrite();
	assert.ok(write, "a save should issue a POST");
	assert.deepEqual(JSON.parse(write.options.body), { id: "settings", content: "edited settings" });
	write.resolveJson({ ok: true });
	await app.settle();
	const snap = app.snapshot();
	assert.equal(snap.saveDisabled, true, "after a successful save the document is clean");
	assert.match(String(snap.status), /Saved successfully/);
});

test("#4 POST(A)-before-GET(B): B cannot be saved before it loads, and completing Save(A) leaves B untouched", async () => {
	const app = await bootWithSettings("original settings");
	await app.type("unsaved settings");

	// Begin saving settings; leave the POST in flight.
	await app.save();
	const postSettings = app.pendingWrite();
	assert.ok(postSettings, "settings POST is in flight");
	assert.equal(JSON.parse(postSettings.options.body).id, "settings");

	// Navigate to the preset while POST(settings) is pending; GET(preset) is now
	// in flight and the preset has not loaded.
	await app.select("preset:agent");
	assert.ok(app.pendingRead("preset:agent"), "preset GET is in flight");

	// The still-visible textarea must not be editable/saveable for the preset.
	let snap = app.snapshot();
	assert.equal(snap.content, "", "preset shows no buffer while loading");
	assert.equal(snap.readOnly, true);
	assert.equal(snap.saveDisabled, true);
	await app.type("sneaky preset edit");
	await app.save();
	assert.equal(app.fetch.writes().filter((w) => JSON.parse(w.options.body).id === "preset:agent").length, 0,
		"no preset POST may be issued before it loads");

	// Complete Save(settings). It must advance ONLY settings' baseline, never the
	// preset's — even though the preset is now selected.
	postSettings.resolveJson({ ok: true });
	await app.settle();
	snap = app.snapshot();
	assert.equal(snap.content, "", "completing Save(settings) must not put anything under the preset");
	assert.equal(snap.saveDisabled, true);

	// Now let the preset's own read finish: it shows the preset's disk content.
	app.pendingRead("preset:agent").resolveJson({ content: "preset on disk" });
	await app.settle();
	snap = app.snapshot();
	assert.equal(snap.content, "preset on disk");
	assert.equal(snap.readOnly, false);
	assert.equal(snap.saveDisabled, true, "freshly loaded preset is clean");
});

test("#4 GET(B)-before-POST(A): completing Save(A) does not overwrite B's freshly loaded content", async () => {
	const app = await bootWithSettings("original settings");
	await app.type("unsaved settings");
	await app.save();
	const postSettings = app.pendingWrite();

	await app.select("preset:agent");
	// Preset loads first.
	app.pendingRead("preset:agent").resolveJson({ content: "preset on disk" });
	await app.settle();
	let snap = app.snapshot();
	assert.equal(snap.content, "preset on disk");

	// Then Save(settings) completes. The preset's buffer/baseline must be intact.
	postSettings.resolveJson({ ok: true });
	await app.settle();
	snap = app.snapshot();
	assert.equal(snap.content, "preset on disk", "Save(settings) must not alter the preset buffer");
	assert.equal(snap.saveDisabled, true, "preset remains clean");

	// And settings itself is now saved: returning to it shows the saved text, clean.
	await app.select("settings");
	snap = app.snapshot();
	assert.equal(snap.content, "unsaved settings", "settings retains its (now saved) buffer");
	assert.equal(snap.saveDisabled, true, "settings is clean after its save completed");
});

test("#4 navigating again mid-read never lands the first read's bytes under the wrong document", async () => {
	const app = await bootWithSettings("original settings");
	// Select the preset (read B in flight)...
	await app.select("preset:agent");
	const readPreset = app.pendingRead("preset:agent");
	assert.ok(readPreset);
	// ...then navigate back to settings before B resolves.
	await app.select("settings");
	// Resolve the preset read late. Its bytes must not appear under settings.
	readPreset.resolveJson({ content: "PRESET BYTES" });
	await app.settle();
	const snap = app.snapshot();
	assert.equal(snap.selected, "settings");
	assert.equal(snap.content, "original settings", "the late preset read must not leak under settings");
	// Selecting the preset again shows the preset's own bytes.
	await app.select("preset:agent");
	// A retained, loaded preset draft means no refetch; if a read is pending, resolve it.
	const maybe = app.pendingRead("preset:agent");
	if (maybe) maybe.resolveJson({ content: "PRESET BYTES" });
	await app.settle();
	assert.equal(app.snapshot().content, "PRESET BYTES");
});

// ------------------------------------------------------------------ #5 (P2) --

test("#5 switching documents and back preserves the unsaved draft", async () => {
	const app = await bootWithSettings("original settings");
	await app.type("unsaved settings");

	await app.select("preset:agent");
	app.pendingRead("preset:agent").resolveJson({ content: "preset body" });
	await app.settle();
	assert.equal(app.snapshot().content, "preset body");

	await app.select("settings");
	const snap = app.snapshot();
	assert.equal(snap.content, "unsaved settings", "the settings draft must survive the round trip");
	assert.equal(snap.saveDisabled, false, "the restored draft is still dirty and saveable");
});

test("#5 returning to a retained draft does not re-fetch and overwrite it", async () => {
	const app = await bootWithSettings("original settings");
	await app.type("unsaved settings");
	const readsBefore = app.fetch.reads("settings").length;

	await app.select("preset:agent");
	app.pendingRead("preset:agent").resolveJson({ content: "preset body" });
	await app.settle();
	await app.select("settings");
	await app.settle();

	assert.equal(app.fetch.reads("settings").length, readsBefore,
		"no automatic GET(settings) may fire when returning to a loaded draft");
	assert.equal(app.snapshot().content, "unsaved settings");
});

test("#5 closing and reopening via the ✕ Close button preserves the draft", async () => {
	const app = await bootWithSettings("original settings");
	await app.type("unsaved settings");

	await app.close();
	assert.equal(app.snapshot().rendered, false, "modal is closed");

	await app.open();
	const snap = app.snapshot();
	assert.equal(snap.content, "unsaved settings", "the draft must survive close/reopen");
	assert.equal(snap.saveDisabled, false);
});

test("#5 closing via the header toggle also preserves the draft", async () => {
	const app = await bootWithSettings("original settings");
	await app.type("unsaved settings");
	const readsBefore = app.fetch.reads("settings").length;

	// The header trigger toggles the same modal — protecting only ✕ Close would
	// leave this loss path open.
	await app.toggleHeader(); // close
	assert.equal(app.snapshot().rendered, false);
	await app.toggleHeader(); // reopen

	// The bug this guards: reopen fired an automatic re-read of the document,
	// which reverts the buffer to disk contents once it resolves. A plain
	// "content is still there" assertion does NOT catch it — the pre-fix code
	// leaves that reopen GET pending, so the stale draft merely lingers on
	// screen and the assertion passes against the broken code. Pin the actual
	// invariant: returning to a loaded draft must not re-fetch it at all (this
	// is what the "#5 returning to a retained draft does not re-fetch" test
	// checks for the switch-document path).
	assert.equal(app.fetch.reads("settings").length, readsBefore,
		"no automatic GET(settings) may fire on a header-toggle reopen of a loaded draft");
	// And if any read were in flight, resolving it (as a real browser does the
	// moment the modal reopens) must not clobber the draft with disk contents.
	const reopenRead = app.pendingRead("settings");
	if (reopenRead) reopenRead.resolveJson({ content: "original settings" });
	await app.settle();

	const snap = app.snapshot();
	assert.equal(snap.content, "unsaved settings", "the draft must survive a header-toggle close");
	assert.equal(snap.saveDisabled, false, "the retained draft is still dirty and saveable");
});

test("#5 clean navigation between documents remains usable", async () => {
	const app = await bootWithSettings("original settings");
	// No edits: switch to the preset and back.
	await app.select("preset:agent");
	app.pendingRead("preset:agent").resolveJson({ content: "preset body" });
	await app.settle();
	assert.equal(app.snapshot().content, "preset body");

	await app.select("settings");
	assert.equal(app.snapshot().content, "original settings", "clean settings still shows its content");
	assert.equal(app.snapshot().saveDisabled, true, "clean document is not saveable");
});

test("#5 a draft dirtied, then reset to its baseline, is no longer saveable", async () => {
	const app = await bootWithSettings("original settings");
	await app.type("changed");
	assert.equal(app.snapshot().saveDisabled, false);
	await app.type("original settings"); // back to disk baseline
	assert.equal(app.snapshot().saveDisabled, true, "content equal to baseline is not dirty");
});
