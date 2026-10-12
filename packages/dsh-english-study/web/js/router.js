/**
 * Hash router.
 *
 * A hash router (not history) is deliberate: it keeps deep links working when the
 * app is either served directly at `/english-study/` or embedded in the DSH shell
 * iframe, without the host having to add rewrite rules.
 *
 * The `params` second argument is what makes `#/diary/2026-02-14` open a specific
 * day's detail view.
 */

/** @typedef {{ path: string, render: (context: { params: Record<string,string>, query: URLSearchParams }) => Node }} Route */

function parseHash(hash) {
  const raw = String(hash ?? "").replace(/^#/, "");
  const [pathPart, queryPart] = raw.split("?");
  const path = pathPart.length === 0 ? "/" : pathPart;
  return { path, query: new URLSearchParams(queryPart ?? "") };
}

/** Match `/diary/:date` style patterns. */
function matchRoute(pattern, path) {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = path.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index];
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = decodeURIComponent(pathParts[index]);
    } else if (expected !== pathParts[index]) {
      return null;
    }
  }
  return params;
}

/**
 * @param {Route[]} routes
 * @param {{ outlet: HTMLElement, fallback?: (path: string) => Node, onNavigate?: (path: string) => void }} options
 */
export function createRouter(routes, options) {
  const { outlet } = options;

  function resolve() {
    const { path, query } = parseHash(window.location.hash);
    for (const route of routes) {
      const params = matchRoute(route.path, path);
      if (params !== null) {
        return { route, params, query, path };
      }
    }
    return { route: null, params: {}, query, path };
  }

  function renderCurrent() {
    const matched = resolve();
    if (typeof options.onNavigate === "function") options.onNavigate(matched.path);
    // Give the outgoing view a chance to unsubscribe from the store; without this
    // a long session would accumulate listeners and leak memory.
    const outgoing = outlet.firstChild;
    if (outgoing !== null && typeof outgoing.__dispose === "function") {
      try {
        outgoing.__dispose();
      } catch (error) {
        console.warn("[english-study] 视图清理失败:", error);
      }
    }
    try {
      const node = matched.route !== null
        ? matched.route.render({ params: matched.params, query: matched.query })
        : (options.fallback?.(matched.path) ?? document.createTextNode("页面不存在"));
      outlet.textContent = "";
      outlet.appendChild(node);
    } catch (error) {
      console.error("[english-study] 路由渲染失败:", error);
      outlet.textContent = "";
      const alert = document.createElement("div");
      alert.className = "alert bad";
      alert.textContent = `页面渲染失败：${error?.message ?? error}`;
      outlet.appendChild(alert);
    }
    // A route change should always start at the top of the new view.
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  }

  window.addEventListener("hashchange", renderCurrent);
  renderCurrent();

  return {
    go(path) {
      const next = path.startsWith("#") ? path : `#${path}`;
      if (window.location.hash === next) renderCurrent();
      else window.location.hash = next;
    },
    current: () => parseHash(window.location.hash).path,
    refresh: renderCurrent,
  };
}

/** Build a hash link. */
export function link(path) {
  return `#${path}`;
}
