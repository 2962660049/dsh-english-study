/**
 * 英语学习小助手 — DSH browser half.
 *
 * Hand-written in the DSH module-loader envelope. A client bundle is nothing more
 * than a Cordis plugin (`{ name, inject, apply }`) registered through
 * `window.__ModuleLoader__.load`, with `require` bound to the platform module
 * baseline (React included). No bundler is involved.
 *
 * What it mounts:
 *   - a global page into the root-scoped `main` keyed slot (key `english-study`),
 *     which is where DSH renders full pages, and
 *   - a launcher button into the root-scoped `shell.overlay` list slot so the user
 *     can actually reach the page.
 *
 * The page itself is a self-contained web app served by this plugin's host half at
 * `/english-study/`. Embedding it in an iframe (same origin, same webserver) keeps
 * the application independently testable at its own URL while still living inside
 * the DSH GUI.
 */

window.__ModuleLoader__.load({
	id: "dsh-english-study",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		/** Route base owned by the host half. */
		const ROUTE_BASE = "/english-study";
		/** Key of our entry in the root-scoped, keyed `main` slot. */
		const PANEL_KEY = "english-study";

		/**
		 * Full-page panel. DSH renders the active main-panel key inside the frame,
		 * so this component is the whole viewport below the frame's top clearance.
		 */
		function StudyPanel() {
			return React.createElement(
				"div",
				{
					style: {
						position: "relative",
						width: "100%",
						height: "100%",
						minHeight: "70vh",
						overflow: "hidden",
					},
				},
				React.createElement("iframe", {
					src: `${ROUTE_BASE}/`,
					title: "英语学习小助手",
					// Same-origin, so no sandbox relaxation is needed; scripts and forms
					// must work for uploads, fetch and speech synthesis.
					allow: "clipboard-read; clipboard-write",
					style: {
						display: "block",
						position: "absolute",
						inset: "0",
						width: "100%",
						height: "100%",
						border: "0",
						background: "transparent",
					},
				}),
			);
		}

		exports.name = "dsh-english-study";
		/** `slots` for registration; `layout` for panel selection. */
		exports.inject = ["slots", "layout"];

		/**
		 * @param {object} ctx client root context
		 */
		exports.apply = function apply(ctx) {
			/** Switch the main panel to this plugin's page. */
			const openPanel = () => {
				try {
					ctx.layout.selectPanel(PANEL_KEY);
				} catch (error) {
					// selectPanel throws when the panel is not registered yet; surfacing it
					// as an unhandled rejection would trip the app's error boundary.
					console.warn("english-study: 无法切换到插件面板，请改用 /english-study/ 地址", error);
				}
			};

			/**
			 * Register into a slot once that slot exists.
			 *
			 * Root child slots (`main`, `shell.overlay`) are declared by ui-layout in
			 * the same effect that provides `ctx.layout`, so a direct register() can
			 * win the race and throw "undeclared slot". `ctx.slots.inject(name, cb)`
			 * is the documented wait-for-declaration idiom used by the built-in
			 * marketplace and sidebar plugins.
			 */
			const registerWhenDeclared = (slotName, register) => {
				if (typeof ctx.slots?.inject === "function") {
					return ctx.slots.inject(slotName, register);
				}
				// Older slot registries have no inject(); fall back to a direct attempt.
				try {
					return register();
				} catch {
					return undefined;
				}
			};

			ctx.effect(
				() =>
					registerWhenDeclared("main", () =>
						ctx.slots.register(
							{
								name: "main",
								key: PANEL_KEY,
								id: PANEL_KEY,
								order: 50,
								label: () => "英语学习小助手",
							},
							StudyPanel,
						),
					),
				"english-study: main panel",
			);

			ctx.effect(
				() =>
					registerWhenDeclared("shell.overlay", () =>
						ctx.slots.register(
							{
								name: "shell.overlay",
								id: "english-study-launcher",
								order: 60,
							},
							function Launcher() {
								return React.createElement(
									"button",
									{
										type: "button",
										onClick: openPanel,
										title: "打开英语学习小助手",
										style: {
											position: "fixed",
											right: "16px",
											bottom: "16px",
											zIndex: 40,
											display: "inline-flex",
											alignItems: "center",
											gap: "6px",
											padding: "8px 14px",
											borderRadius: "999px",
											border: "1px solid var(--dsh-border, rgba(127,127,127,.35))",
											background: "var(--dsh-surface, rgba(30,30,32,.92))",
											color: "inherit",
											font: "inherit",
											fontSize: "13px",
											cursor: "pointer",
											boxShadow: "0 6px 20px rgba(0,0,0,.28)",
											backdropFilter: "blur(8px)",
										},
									},
									"英语学习",
								);
							},
						),
					),
				"english-study: launcher",
			);
		};

		return module.exports;
	},
});
