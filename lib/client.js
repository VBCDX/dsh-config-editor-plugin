// Config & Agent Preset Editor — client half (browser bundle).
//
// Loaded by the DSH web shell's client-module scan (see the dsh.client field
// in package.json). Registers:
// 1. A header utilities button ("Config Editor") that toggles the editor
// 2. An overlay window in the shell.overlay slot for viewing and editing
//    config files and agent presets, through the host half's
//    /plugins/config-editor route.
window.__ModuleLoader__.load({
	id: "@vbcdx/dsh-config-editor-plugin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		// Shared UI state across the trigger and the overlay.
		let isOpen = false;
		const listeners = new Set();
		function setOpen(val) {
			isOpen = val;
			listeners.forEach((fn) => fn(isOpen));
		}
		function subscribe(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		}

		// The route served by this package's host half.
		const ROUTE = "/plugins/config-editor";

		// Trigger in the conversation session header.
		function ConfigTrigger() {
			const [, setTick] = React.useState(0);
			React.useEffect(() => subscribe(() => setTick((t) => t + 1)), []);

			return React.createElement(
				"button",
				{
					onClick: () => setOpen(!isOpen),
					style: {
						display: "flex",
						alignItems: "center",
						gap: "4px",
						padding: "4px 8px",
						fontSize: "12px",
						fontWeight: "500",
						cursor: "pointer",
						borderRadius: "4px",
						border: "1px solid var(--dsw-alias-border-l1)",
						backgroundColor: isOpen ? "var(--dsw-alias-bg-layer-3)" : "var(--dsw-alias-bg-layer-2)",
						color: "var(--dsw-alias-label-primary)"
					},
					title: "Open In-App Configuration Editor"
				},
				[
					React.createElement("span", { key: "icon" }, "📝"),
					React.createElement("span", { key: "text" }, "Config Editor")
				]
			);
		}

		// Editor modal window in the shell overlay.
		function ConfigEditorModal() {
			const [open, setModalOpen] = React.useState(isOpen);
			const [docs, setDocs] = React.useState([]);
			const [selectedDoc, setSelectedDoc] = React.useState(null);
			// Per-document editor state, keyed by document id. Each entry is
			// { content, original, loaded }: the live buffer, the on-disk baseline,
			// and whether a successful read populated it. Keying by id is what binds
			// a buffer to the document it came from — a save can only ever target the
			// id whose entry it reads, so switching documents (or a failed read) can
			// never move one file's buffer under another id (#4). Entries persist
			// across selection changes and modal close/reopen, which is what
			// preserves an unsaved draft (#5).
			const [drafts, setDrafts] = React.useState({});
			// In-flight reads and saves, keyed by id, so completing one document's
			// request never clears another document's spinner (#4 AC3).
			const [loadingIds, setLoadingIds] = React.useState({});
			const [savingIds, setSavingIds] = React.useState({});
			// Transient status message, keyed by id, so a save/error on document A
			// is not shown against — or cleared by — document B (#4 AC3).
			const [statuses, setStatuses] = React.useState({});
			// List-level status (e.g. the document listing itself failing to load),
			// which is not tied to any one document.
			const [listStatus, setListStatus] = React.useState(null);

			React.useEffect(() => subscribe((val) => setModalOpen(val)), []);

			// Fetch the document list from the host route.
			const loadDocList = React.useCallback(async () => {
				try {
					const res = await fetch(ROUTE);
					const body = await res.json();
					if (body && body.docs) {
						setDocs(body.docs);
						if (body.docs.length > 0 && !selectedDoc) {
							setSelectedDoc(body.docs[0]);
						}
					}
				} catch (err) {
					setListStatus({ type: "error", text: "Failed to list documents: " + err.message });
				}
			}, [selectedDoc]);

			React.useEffect(() => {
				if (open) loadDocList();
			}, [open, loadDocList]);

			// Load file content when the selection changes. Everything the read
			// touches is keyed by the id captured here, never by whatever happens to
			// be selected when the request resolves — so a navigation mid-flight
			// cannot land document A's bytes under document B (#4).
			React.useEffect(() => {
				if (!selectedDoc || !open) return;
				const id = selectedDoc.id;
				// Preserve a retained draft: if this document already loaded once,
				// do not re-fetch and overwrite the buffer (#5). Also skip if a read
				// for this id is already in flight.
				if (drafts[id] && drafts[id].loaded) return;
				if (loadingIds[id]) return;
				async function fetchContent() {
					setLoadingIds((prev) => ({ ...prev, [id]: true }));
					setStatuses((prev) => {
						const next = { ...prev };
						delete next[id];
						return next;
					});
					try {
						const res = await fetch(ROUTE + "?id=" + encodeURIComponent(id));
						const body = await res.json();
						if (body.error) {
							setStatuses((prev) => ({ ...prev, [id]: { type: "error", text: body.error } }));
						} else {
							const disk = body.content || "";
							setDrafts((prev) => {
								// A concurrent load may have already populated this id.
								if (prev[id] && prev[id].loaded) return prev;
								return { ...prev, [id]: { content: disk, original: disk, loaded: true } };
							});
						}
					} catch (err) {
						setStatuses((prev) => ({ ...prev, [id]: { type: "error", text: err.message } }));
					} finally {
						setLoadingIds((prev) => {
							const next = { ...prev };
							delete next[id];
							return next;
						});
					}
				}
				fetchContent();
				// Trigger only on selection / open changes. The drafts and loadingIds
				// guards above read the snapshot captured at selection time — which is
				// what we want. Adding them here would re-fire the effect when a read
				// clears its loading flag, hammering a persistently failing GET.
			}, [selectedDoc, open]);

			const handleSave = async () => {
				if (!selectedDoc) return;
				const id = selectedDoc.id;
				const draft = drafts[id];
				// A document is only saveable once its own read completed successfully.
				// This is the invariant that makes the wrong-file write impossible: the
				// buffer being written was loaded from, and is being written back to,
				// this exact id (#4 AC1).
				if (!draft || !draft.loaded) return;
				if (savingIds[id] || loadingIds[id]) return;
				const saved = draft.content;
				setSavingIds((prev) => ({ ...prev, [id]: true }));
				setStatuses((prev) => {
					const next = { ...prev };
					delete next[id];
					return next;
				});
				try {
					const res = await fetch(ROUTE, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ id: id, content: saved })
					});
					const body = await res.json();
					if (body.error) {
						setStatuses((prev) => ({ ...prev, [id]: { type: "error", text: "Save failed: " + body.error } }));
					} else {
						// Advance only this id's baseline. Completing Save(A) must never
						// touch document B's state, even if the selection has since moved
						// to B (#4 AC3).
						setDrafts((prev) => {
							const cur = prev[id];
							if (!cur) return prev;
							return { ...prev, [id]: { ...cur, original: saved } };
						});
						setStatuses((prev) => ({ ...prev, [id]: { type: "success", text: "Saved successfully! (Backup created)" } }));
					}
				} catch (err) {
					setStatuses((prev) => ({ ...prev, [id]: { type: "error", text: "Save failed: " + err.message } }));
				} finally {
					setSavingIds((prev) => {
						const next = { ...prev };
						delete next[id];
						return next;
					});
				}
			};

			if (!open) return null;

			// Everything the UI shows is derived from the selected document's own
			// entry, so the editor can only ever display and act on the buffer that
			// belongs to the current selection.
			const selId = selectedDoc ? selectedDoc.id : null;
			const draft = selId ? drafts[selId] : undefined;
			const content = draft ? draft.content : "";
			const loaded = !!(draft && draft.loaded);
			const isLoading = !!(selId && loadingIds[selId]);
			const isSaving = !!(selId && savingIds[selId]);
			// A document-scoped status takes precedence over a list-level one.
			const status = (selId && statuses[selId]) || listStatus;
			const isDirty = !!(draft && draft.loaded && draft.content !== draft.original);
			// Save is offered only for a loaded, dirty document with no read/save of
			// its own in flight — a document mid-load can never be saved (#4).
			const canSave = isDirty && !isSaving && !isLoading;

			return React.createElement(
				"div",
				{
					style: {
						position: "fixed",
						top: "5%",
						left: "10%",
						width: "80%",
						height: "85%",
						backgroundColor: "var(--dsw-alias-bg-layer-1)",
						border: "1px solid var(--dsw-alias-border-l1)",
						borderRadius: "8px",
						boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
						zIndex: 9999,
						display: "flex",
						flexDirection: "column",
						overflow: "hidden",
						fontFamily: "var(--dsw-alias-font-sans, system-ui, sans-serif)"
					}
				},
				[
					// Header: title, document select, status, save, close.
					React.createElement(
						"div",
						{
							key: "header",
							style: {
								display: "flex",
								alignItems: "center",
								justifyContent: "space-between",
								padding: "12px 16px",
								backgroundColor: "var(--dsw-alias-bg-layer-2)",
								borderBottom: "1px solid var(--dsw-alias-border-l1)"
							}
						},
						[
							React.createElement(
								"div",
								{
									key: "title-group",
									style: { display: "flex", alignItems: "center", gap: "10px" }
								},
								[
									React.createElement("span", { key: "title", style: { fontWeight: "600", fontSize: "15px" } }, "Configuration & Agent Preset Editor"),
									React.createElement(
										"select",
										{
											key: "doc-select",
											value: selectedDoc ? selectedDoc.id : "",
											onChange: (e) => {
												const found = docs.find((d) => d.id === e.target.value);
												if (found) setSelectedDoc(found);
											},
											style: {
												padding: "4px 8px",
												borderRadius: "4px",
												border: "1px solid var(--dsw-alias-border-l1)",
												backgroundColor: "var(--dsw-alias-bg-layer-1)",
												color: "var(--dsw-alias-label-primary)",
												fontSize: "13px"
											}
										},
										docs.map((d) => React.createElement("option", { key: d.id, value: d.id }, d.label))
									)
								]
							),
							React.createElement(
								"div",
								{
									key: "actions",
									style: { display: "flex", alignItems: "center", gap: "8px" }
								},
								[
									status && React.createElement("span", {
										key: "status",
										style: {
											fontSize: "12px",
											color: status.type === "error" ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-state-success-primary)"
										}
									}, status.text),
									React.createElement("button", {
										key: "save-btn",
										onClick: handleSave,
										disabled: !canSave,
										style: {
											padding: "6px 14px",
											borderRadius: "4px",
											border: "none",
											backgroundColor: isDirty ? "var(--dsw-alias-accent-primary, #2563eb)" : "var(--dsw-alias-bg-layer-3)",
											color: "#fff",
											cursor: isDirty ? "pointer" : "default",
											fontWeight: "500",
											fontSize: "12px"
										}
									}, isSaving ? "Saving…" : isDirty ? "Save Changes" : "Saved"),
									React.createElement("button", {
										key: "close-btn",
										onClick: () => setOpen(false),
										style: {
											padding: "6px 10px",
											borderRadius: "4px",
											border: "1px solid var(--dsw-alias-border-l1)",
											backgroundColor: "transparent",
											color: "var(--dsw-alias-label-secondary)",
											cursor: "pointer",
											fontSize: "12px"
										}
									}, "✕ Close")
								]
							)
						]
					),
					// Body: the path bar and the editor textarea.
					React.createElement(
						"div",
						{
							key: "body",
							style: { flex: 1, padding: "12px", display: "flex", flexDirection: "column" }
						},
						[
							React.createElement(
								"div",
								{
									key: "path-bar",
									style: { fontSize: "11px", color: "var(--dsw-alias-label-secondary)", marginBottom: "6px", fontFamily: "monospace" }
								},
								selectedDoc ? selectedDoc.path : ""
							),
							React.createElement("textarea", {
								key: "editor-area",
								value: content,
								// Edits mutate only the selected document's own buffer, and
								// only after it has loaded — so a document mid-load (or one
								// whose read failed) can neither be edited nor saved (#4).
								onChange: (e) => {
									const val = e.target.value;
									setDrafts((prev) => {
										const cur = selId ? prev[selId] : undefined;
										if (!cur || !cur.loaded) return prev;
										return { ...prev, [selId]: { ...cur, content: val } };
									});
								},
								readOnly: !loaded,
								placeholder: isLoading ? "Loading file content…" : loaded ? "File is empty" : "",
								style: {
									flex: 1,
									width: "100%",
									boxSizing: "border-box",
									backgroundColor: "var(--dsw-alias-bg-layer-2)",
									color: "var(--dsw-alias-label-primary)",
									border: "1px solid var(--dsw-alias-border-l1)",
									borderRadius: "4px",
									padding: "12px",
									fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
									fontSize: "13px",
									lineHeight: "1.5",
									resize: "none",
									outline: "none"
								}
							})
						]
					)
				]
			);
		}

		const inject = ["slots"];

		function apply(ctx) {
			const slots = ctx.get("slots");
			if (!slots) {
				console.error("config-editor: slots service unavailable");
				return;
			}

			ctx.effect(() => {
				const offUtilities = slots.inject("conversation.session.header.utilities", () => {
					return slots.register(
						{
							name: "conversation.session.header.utilities",
							id: "config-editor-trigger",
							order: 20,
							label: "Config Editor"
						},
						() => React.createElement(ConfigTrigger)
					);
				});

				const offOverlay = slots.inject("shell.overlay", () => {
					return slots.register(
						{
							name: "shell.overlay",
							id: "config-editor-modal",
							order: 100
						},
						() => React.createElement(ConfigEditorModal)
					);
				});

				return () => {
					offUtilities();
					offOverlay();
				};
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
