// Minimal React-hook / effect scheduler and a controllable fetch, just enough
// to drive lib/client.js's ConfigEditorModal in a Node test process — the same
// kind of "controlled state/event execution" the issue reproductions used.
//
// This is NOT a general React implementation. It renders one function component
// at a time (never reentrantly), supports useState / useCallback / useEffect
// with dependency arrays and cleanups, and coalesces synchronous re-renders.
// Children produced by React.createElement are kept as plain vnodes so a test
// can query props (a button's `disabled`, a textarea's `value`) and invoke the
// handlers the component wired up (onClick, onChange).
//
// Named .mjs (not *.test.js) on purpose: node --test's default glob treats every
// *.js under test/ as a test file, and this module defines no tests.

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../..", import.meta.url));

function depsEqual(a, b) {
	if (a === undefined || b === undefined) return false;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
	return true;
}

// A React stub. `_current` points at the renderer whose component is mid-render
// so the hooks resolve their slot storage. setState closures capture their own
// renderer, so they work when called later from async effects.
function makeReact() {
	const react = {
		_current: null,
		useState(init) {
			const r = react._current;
			const i = r.hookIndex++;
			if (!(i in r.hooks)) r.hooks[i] = { v: typeof init === "function" ? init() : init };
			const slot = r.hooks[i];
			const setState = (nv) => {
				const next = typeof nv === "function" ? nv(slot.v) : nv;
				if (!Object.is(next, slot.v)) {
					slot.v = next;
					r.dirty = true;
				}
			};
			return [slot.v, setState];
		},
		useCallback(fn, deps) {
			const r = react._current;
			const i = r.hookIndex++;
			const prev = r.hooks[i];
			if (!prev || !depsEqual(prev.deps, deps)) r.hooks[i] = { fn, deps };
			return r.hooks[i].fn;
		},
		useEffect(fn, deps) {
			const r = react._current;
			const i = r.hookIndex++;
			const prev = r.hooks[i];
			if (!prev || !depsEqual(prev.deps, deps)) {
				r.pendingEffects.push(i);
				r.hooks[i] = { deps, cleanup: prev ? prev.cleanup : null, fn };
			}
		},
		createElement(type, props, ...children) {
			let kids = children;
			if (kids.length === 1 && Array.isArray(kids[0])) kids = kids[0];
			return { type, props: props || {}, children: kids };
		}
	};
	return react;
}

// A renderer owns one function component's hook storage and drives its
// render/effect loop. `rootFn` is the slot render function the plugin
// registered, i.e. () => React.createElement(Component).
function makeRenderer(react, rootFn) {
	const r = { hooks: {}, hookIndex: 0, pendingEffects: [], dirty: false, tree: null };

	function renderOnce() {
		r.hookIndex = 0;
		r.pendingEffects = [];
		react._current = r;
		try {
			const vnode = rootFn();
			const Component = vnode.type;
			r.tree = Component(vnode.props || {});
		} finally {
			react._current = null;
		}
	}

	function runEffects() {
		const due = r.pendingEffects;
		r.pendingEffects = [];
		for (const i of due) {
			const slot = r.hooks[i];
			if (typeof slot.cleanup === "function") {
				try { slot.cleanup(); } catch (_e) { /* ignore */ }
			}
			const cl = slot.fn();
			slot.cleanup = typeof cl === "function" ? cl : null;
		}
	}

	r.flush = function flush() {
		let guard = 0;
		do {
			r.dirty = false;
			renderOnce();
			runEffects();
		} while (r.dirty && guard++ < 200);
		return r.tree;
	};
	return r;
}

// A fetch double. Every call parks a deferred the test resolves or rejects,
// so read/save orderings can be interleaved deterministically.
export function makeFetch() {
	const calls = [];
	function fetch(url, options) {
		let resolveFn, rejectFn;
		const promise = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
		const call = {
			url,
			options,
			promise,
			settled: false,
			// Resolve with a JSON body.
			resolveJson(body) { this.settled = true; resolveFn({ json: () => Promise.resolve(body) }); },
			// Resolve the HTTP response but fail JSON decoding (the "decode error" case).
			resolveBadJson() { this.settled = true; resolveFn({ json: () => Promise.reject(new SyntaxError("Unexpected end of JSON input")) }); },
			// Reject the request itself (a network failure).
			reject(err) { this.settled = true; rejectFn(err instanceof Error ? err : new Error(String(err))); }
		};
		calls.push(call);
		return promise;
	}
	fetch.calls = calls;
	fetch.last = () => calls[calls.length - 1];
	// GET(id) calls carry ?id= in the URL; POST calls carry an options.method.
	fetch.reads = (id) => calls.filter((c) => (!c.options || !c.options.method) && c.url.includes("id=" + encodeURIComponent(id)));
	fetch.writes = () => calls.filter((c) => c.options && c.options.method === "POST");
	return fetch;
}

// Walk the vnode tree and find the first element with props.key === key.
function walk(node, visit) {
	if (node == null || typeof node !== "object") return;
	if (Array.isArray(node)) { for (const n of node) walk(n, visit); return; }
	visit(node);
	if (node.children) for (const c of node.children) walk(c, visit);
}
function findByKey(tree, key) {
	let found = null;
	walk(tree, (n) => { if (found === null && n && n.props && n.props.key === key) found = n; });
	return found;
}

// Mount the plugin fresh: a new factory instance (fresh module-level isOpen /
// listeners), a new React stub, a controllable fetch, and renderers for the
// modal and the header trigger. Returns a small driver API.
export async function mountEditor() {
	let captured = null;
	global.window = { __ModuleLoader__: { load: (def) => { captured = def; } } };
	// Import once; re-importing with a cache-buster gives a fresh top-level run
	// so each mount starts from a clean registration.
	const url = pathToFileURL(join(root, "lib/client.js")).href + "?mount=" + Math.random();
	await import(url);
	if (!captured) throw new Error("client.js did not register via __ModuleLoader__.load");

	const react = makeReact();
	const requireStub = (name) => {
		if (name === "react") return react;
		throw new Error("unexpected require(" + name + ")");
	};
	const mod = captured.factory(requireStub);

	const registered = {};
	const slots = {
		inject(_name, cb) { return cb(); },
		register(meta, renderFn) { registered[meta.id] = renderFn; return () => {}; }
	};
	const ctx = {
		get(name) { return name === "slots" ? slots : null; },
		effect(fn) { return fn(); }
	};
	mod.apply(ctx);

	const fetch = makeFetch();
	global.fetch = fetch;

	const modal = makeRenderer(react, registered["config-editor-modal"]);
	const trigger = makeRenderer(react, registered["config-editor-trigger"]);

	// Bring the modal and trigger to life (they subscribe to shared open state).
	modal.flush();
	trigger.flush();

	async function settle() {
		// Let queued microtasks (resolved fetch continuations) run, then re-render.
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		modal.flush();
	}

	const api = {
		fetch,
		registered,
		// Open the editor by clicking the header trigger (drives real setOpen()).
		async open() {
			// The trigger component renders the button as its root vnode.
			trigger.tree.props.onClick();
			modal.flush();
			trigger.flush();
			await settle();
		},
		// Toggle via the same header button (used for the header-toggle-close path).
		async toggleHeader() {
			const onClick = trigger.tree.props.onClick;
			onClick();
			modal.flush();
			trigger.flush();
			await settle();
		},
		// Provide the document list the next loadDocList() GET resolves with.
		resolveDocList(docs) {
			const c = fetch.calls.find((x) => x.url === "/plugins/config-editor" && !x.settled && (!x.options || !x.options.method));
			if (!c) throw new Error("no pending doc-list GET");
			c.resolveJson({ docs });
			return settle();
		},
		// Select a document by id in the header <select>.
		async select(id) {
			const sel = findByKey(modal.tree, "doc-select");
			sel.props.onChange({ target: { value: id } });
			modal.flush();
			await settle();
		},
		// Type into the editor textarea.
		async type(text) {
			const ta = findByKey(modal.tree, "editor-area");
			ta.props.onChange({ target: { value: text } });
			modal.flush();
			await settle();
		},
		// Click Save.
		async save() {
			const btn = findByKey(modal.tree, "save-btn");
			btn.props.onClick();
			modal.flush();
			await settle();
		},
		// Click the modal's ✕ Close button.
		async close() {
			const btn = findByKey(modal.tree, "close-btn");
			btn.props.onClick();
			modal.flush();
			trigger.flush();
			await settle();
		},
		// Current editor snapshot for assertions.
		snapshot() {
			const ta = findByKey(modal.tree, "editor-area");
			const save = findByKey(modal.tree, "save-btn");
			const status = findByKey(modal.tree, "status");
			const sel = findByKey(modal.tree, "doc-select");
			return {
				content: ta ? ta.props.value : null,
				readOnly: ta ? !!ta.props.readOnly : null,
				placeholder: ta ? ta.props.placeholder : null,
				saveDisabled: save ? !!save.props.disabled : null,
				saveLabel: save ? save.children && save.children[0] : null,
				status: status ? (status.children && status.children[0]) : null,
				statusType: status ? (status.props && status.props.style && status.props.style.color) : null,
				selected: sel ? sel.props.value : null,
				rendered: modal.tree !== null
			};
		},
		// Pending GET for an id (first unsettled), for interleaving control.
		pendingRead(id) {
			return fetch.reads(id).find((c) => !c.settled) || null;
		},
		pendingWrite() {
			return fetch.writes().find((c) => !c.settled) || null;
		},
		settle
	};
	return api;
}
