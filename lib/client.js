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
			const [content, setContent] = React.useState("");
			const [originalContent, setOriginalContent] = React.useState("");
			const [loading, setLoading] = React.useState(false);
			const [status, setStatus] = React.useState(null);

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
					setStatus({ type: "error", text: "Failed to list documents: " + err.message });
				}
			}, [selectedDoc]);

			React.useEffect(() => {
				if (open) loadDocList();
			}, [open, loadDocList]);

			// Load file content when the selection changes.
			React.useEffect(() => {
				if (!selectedDoc || !open) return;
				let active = true;
				async function fetchContent() {
					setLoading(true);
					setStatus(null);
					try {
						const res = await fetch(ROUTE + "?id=" + encodeURIComponent(selectedDoc.id));
						const body = await res.json();
						if (!active) return;
						if (body.error) {
							setStatus({ type: "error", text: body.error });
							setContent("");
							setOriginalContent("");
						} else {
							setContent(body.content || "");
							setOriginalContent(body.content || "");
						}
					} catch (err) {
						if (active) setStatus({ type: "error", text: err.message });
					} finally {
						if (active) setLoading(false);
					}
				}
				fetchContent();
				return () => {
					active = false;
				};
			}, [selectedDoc, open]);

			const handleSave = async () => {
				if (!selectedDoc) return;
				setLoading(true);
				setStatus(null);
				try {
					const res = await fetch(ROUTE, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ id: selectedDoc.id, content: content })
					});
					const body = await res.json();
					if (body.error) {
						setStatus({ type: "error", text: "Save failed: " + body.error });
					} else {
						setOriginalContent(content);
						setStatus({ type: "success", text: "Saved successfully! (Backup created)" });
					}
				} catch (err) {
					setStatus({ type: "error", text: "Save failed: " + err.message });
				} finally {
					setLoading(false);
				}
			};

			if (!open) return null;

			const isDirty = content !== originalContent;

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
										disabled: loading || !isDirty,
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
									}, loading ? "Saving…" : isDirty ? "Save Changes" : "Saved"),
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
								onChange: (e) => setContent(e.target.value),
								placeholder: loading ? "Loading file content…" : "File is empty",
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
