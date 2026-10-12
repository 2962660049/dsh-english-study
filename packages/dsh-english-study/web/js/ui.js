/**
 * DOM helpers: a minimal hyperscript, toasts, modals, lightbox and an error
 * boundary. Deliberately dependency-free and build-free — the DSH sandbox cannot
 * run esbuild (it spawns with piped stdio, which is denied), so the entire client
 * is plain ESM.
 *
 * Nothing here touches `document` at module scope, so the modules can be imported
 * under Node for syntax checks.
 */

/** Event handler prop names start with "on" and are attached with addEventListener. */
function isEventProp(key) {
  return key.length > 2 && key.startsWith("on") && key[2] === key[2].toUpperCase();
}

function appendChild(node, child) {
  if (child === null || child === undefined || child === false || child === true) return;
  if (Array.isArray(child)) {
    for (const item of child) appendChild(node, item);
    return;
  }
  node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
}

/**
 * Create an element.
 * @param {string | Function} tag tag name, or a component function
 * @param {object | null} props
 * @param {...unknown} children
 * @returns {Node}
 */
export function h(tag, props, ...children) {
  if (typeof tag === "function") {
    return tag({ ...(props ?? {}), children });
  }
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class" || key === "className") {
      node.className = String(value);
    } else if (key === "style" && typeof value === "object") {
      Object.assign(node.style, value);
    } else if (key === "dataset" && typeof value === "object") {
      Object.assign(node.dataset, value);
    } else if (key === "html") {
      node.innerHTML = String(value);
    } else if (key === "text") {
      node.textContent = String(value);
    } else if (key === "ref" && typeof value === "function") {
      value(node);
    } else if (isEventProp(key)) {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) {
      node.setAttribute(key, "");
    } else {
      node.setAttribute(key, String(value));
    }
  }
  appendChild(node, children);
  return node;
}

/** Document fragment helper. */
export function frag(...children) {
  const node = document.createDocumentFragment();
  appendChild(node, children);
  return node;
}

/** Replace a container's children. */
export function mount(container, ...children) {
  container.textContent = "";
  appendChild(container, children);
  return container;
}

/* --------------------------------------------------------------- formatting */

/** `2026-02-14` -> `2026年2月14日`. */
export function fmtDate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  if (match === null) return String(iso ?? "");
  return `${match[1]}年${Number(match[2])}月${Number(match[3])}日`;
}

/** ISO timestamp -> local `MM-DD HH:mm`. */
export function fmtDateTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso ?? "");
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Local `YYYY-MM-DD` for a Date (never UTC — a diary is filed by local day). */
export function toDateKey(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function debounce(fn, ms = 250) {
  let timer = null;
  return (...args) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
}

/* ------------------------------------------------------------------ toasts */

/**
 * @param {string} message
 * @param {"info" | "ok" | "warn" | "bad"} [kind]
 * @param {{ timeoutMs?: number, action?: { label: string, onClick: () => void } }} [options]
 */
export function toast(message, kind = "info", options = {}) {
  const layer = document.getElementById("toast-layer");
  if (layer === null) return () => {};
  const timeoutMs = options.timeoutMs ?? (kind === "bad" ? 8000 : 3600);
  const close = () => {
    node.remove();
  };
  const node = h(
    "div",
    { class: `toast ${kind}` },
    h("div", { class: "toast-body" }, message),
    options.action
      ? h(
          "button",
          {
            class: "sm",
            onClick: () => {
              try {
                options.action.onClick();
              } finally {
                close();
              }
            },
          },
          options.action.label,
        )
      : null,
    h("button", { class: "ghost sm", "aria-label": "关闭", onClick: close }, "×"),
  );
  layer.appendChild(node);
  if (timeoutMs > 0) setTimeout(close, timeoutMs);
  return close;
}

/* ------------------------------------------------------------------ modals */

/**
 * Open a modal. Returns handles so the caller can close it and update the body.
 * @param {{ title: string, body: Node | Node[], footer?: Node | Node[], onClose?: () => void, width?: string }} options
 */
export function openModal(options) {
  const layer = document.getElementById("modal-layer");
  const body = h("div", { class: "modal-body" });
  const foot = h("div", { class: "modal-foot" });
  appendChild(body, options.body ?? []);
  appendChild(foot, options.footer ?? []);

  const close = () => {
    layer.hidden = true;
    layer.textContent = "";
    document.removeEventListener("keydown", onKey);
    if (typeof options.onClose === "function") options.onClose();
  };
  const onKey = (event) => {
    if (event.key === "Escape") close();
  };

  const modal = h(
    "div",
    { class: "modal", style: options.width ? { width: options.width } : undefined },
    h(
      "div",
      { class: "modal-head" },
      h("div", { style: { flex: "1 1 auto" } }, options.title),
      h("button", { class: "ghost sm", "aria-label": "关闭", onClick: close }, "×"),
    ),
    body,
    foot,
  );

  layer.hidden = false;
  mount(layer, h("div", { onClick: (event) => { if (event.target === modal.parentElement) close(); } }, modal));
  document.addEventListener("keydown", onKey);
  return { body, foot, modal, close };
}

/** Full-screen image viewer. */
export function openLightbox(src, caption = "") {
  const node = h(
    "div",
    {
      class: "lightbox",
      onClick: () => node.remove(),
      onKeydown: (event) => {
        if (event.key === "Escape") node.remove();
      },
    },
    h("img", { src, alt: caption }),
    h("button", { class: "lb-close", onClick: () => node.remove() }, "关闭 ✕"),
  );
  document.body.appendChild(node);
  return node;
}

/* ---------------------------------------------------------- error boundary */

/**
 * Render `render()` inside an error boundary.
 *
 * The reliability spec requires that a view crash must never leave a white
 * screen. Any throw is caught and replaced with a readable error card plus a
 * retry button, and the failure is reported to the console for diagnosis.
 *
 * @param {() => Node} render
 * @param {{ label?: string, onRetry?: () => void }} [options]
 * @returns {Node}
 */
export function guarded(render, options = {}) {
  try {
    return render();
  } catch (error) {
    console.error(`[english-study] 渲染失败${options.label ? ` (${options.label})` : ""}:`, error);
    return h(
      "div",
      { class: "alert bad" },
      h(
        "div",
        { class: "alert-body" },
        h("div", { class: "alert-title" }, `界面渲染出错${options.label ? `：${options.label}` : ""}`),
        h("div", { class: "mono small pre-wrap" }, String(error?.stack ?? error)),
      ),
      h(
        "button",
        {
          onClick: () => {
            if (typeof options.onRetry === "function") options.onRetry();
          },
        },
        "重试",
      ),
    );
  }
}

/** Wrap a function so a throw never escapes into an event handler. */
export function safe(fn, label = "操作") {
  return (...args) => {
    try {
      return fn(...args);
    } catch (error) {
      console.error(`[english-study] ${label} 失败:`, error);
      toast(`${label}失败：${error?.message ?? error}`, "bad");
      return undefined;
    }
  };
}

export { appendChild };
