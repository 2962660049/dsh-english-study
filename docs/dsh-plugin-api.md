# DSH Plugin API — Engineering Reference

Target runtime: **DeepSeek Harness `0.2.0-rc.2`**, desktop install at `D:\deepseek harness\`.
Every claim below carries the file + line it was read from. Anything that could not be determined from
source is marked **`UNKNOWN`** — do not guess in their place.

Primary evidence sources (three tiers, in order of trust):

| Tier | Source | Why |
|---|---|---|
| 1 | `D:\dsh-English-study-workplace\.dsh-asar\<pkg>\lib\index.js` + `README.md` | Extracted verbatim from `D:\deepseek harness\resources\app.asar` under prefix `dsh/node_modules/@deepseek-ai/<pkg>/` — the shipped implementation. |
| 2 | `%USERPROFILE%\.dsh\profiles\desktop\node_modules\{dsh-context,dsh-image-gen,dsh-better-sidebar}\` | Installed, working, third-party plugins. Real end-to-end usage. |
| 3 | `D:\dsh-English-study-workplace\.dsh-asar\dsh-cordis-client-runner\lib\client.js` | Machine-generated, complete client-side API catalogue (services, events, types, all 89 slots). |

Extraction recipe used for everything under `.dsh-asar` (per-package output dir is **mandatory** —
`extract` strips the prefix, so two packages into one dir overwrite each other):

```powershell
$node = "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node "D:\dsh-English-study-workplace\tools\asar-list.mjs" `
    "D:\deepseek harness\resources\app.asar" `
    extract "dsh/node_modules/@deepseek-ai/dsh-tools/" `
    "D:\dsh-English-study-workplace\.dsh-asar\dsh-tools" 500
```

---

## 0. TL;DR — the smallest complete plugin

Five files. Host half and client half are two Cordis plugins in one npm package.

```
dsh-my-plugin/
  package.json          # the dsh field: bundle.patch + client.{platform,inject,external}
  cordis.patch.yml      # one insert row naming the package
  lib/index.js          # host half  (Node)  — export { name, inject, Config, apply }
  lib/client.js         # client half (browser) — export { name, inject, apply }
  icon.svg              # optional; top-level "icon" in package.json
```

| Need | One-liner |
|---|---|
| Load the plugin | declare `dsh.bundle.patch`, add the package to `dsh.profile.bundles` (the CLI does this on `dsh plugin --profile desktop add <pkg>`). |
| Host route | `ctx.effect(() => ctx.webServer.register({ kind: "exact", path: "/plugins/my-plugin/do", handler }), "…")` |
| Agent tool | `ctx.tools.register(defineTool({ name, description, parameters, output, execute }))` |
| LLM call | `for await (const chunk of ctx.llm.stream({ provider, model, messages })) …` |
| Image into an LLM call | `{ type: "image", attachment: await ctx.attachments.saveImage({ data, mediaType, name }) }` in message content |
| Persist data | `const domain = await ctx.storageDomain.open(spec); domain.table("t").put(id, rec)` |
| Client page | `ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: "my-plugin" }, Page))` |
| Dev loop | run `pnpm run dev:web` in the checkout; host+client changes hot-swap, new package install needs a restart. |

---

## 1. Plugin package contract

### 1.1 `package.json` — the `dsh` field

Ground truth: `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-context\package.json` (158 lines, read in full).

```jsonc
{
  "name": "dsh-my-plugin",
  "version": "0.1.0",
  "description": "…",
  "icon": "icon.svg",              // top-level, NOT inside "dsh"
  "type": "module",
  "engines": { "node": "^22.19.0 || >=24.0.0" },
  "main": "lib/index.js",
  "exports": {
    ".":              { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./client":       "./lib/client.js",          // REQUIRED for a browser half
    "./package.json": "./package.json",
    "./locale/*.json":".../locale/*.json"         // only if you ship dictionaries
  },
  "files": ["icon.svg","locale/*.json","lib/client.js","lib/index.js","lib/index.d.ts","cordis.patch.yml","README.md","LICENSE"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-api-remotes",
        "@deepseek-ai/dsh-client-connection",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-client-ui-sidebar-right"
      ]
      // "external": ["some-non-baseline-package"],   // optional
      // "immediately": true                            // optional
    },
    "compatibility": { "dshReleases": { "0.2.0-rc.2": "compatible" } }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.4",
    "@deepseek-ai/schemastery": "^3.18.2",
    "@deepseek-ai/dsh-client-ui-primitives": ">=0.1.7-rc.2",
    "@deepseek-ai/dsh-session": ">=0.1.7-rc.2",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "peerDependenciesMeta": {
    "@deepseek-ai/dsh-client-ui-primitives": { "optional": true },
    "react": { "optional": true },
    "react-dom": { "optional": true }
  },
  "dependencies": { "zod": "^4.4.3" },
  "scripts": { "build": "tsdown" }
}
```

**`dsh.client` is an exact, closed field set.** Validated in `D:\dsh-English-study-workplace\.dsh-asar\dsh-client-modules\lib\index.js:61-75` (`parseDshClient`), verbatim error strings:

- absent ⇒ `undefined` (package has no browser half)
- non-object ⇒ ``client-modules: ${pkgName} has a non-object dsh.client declaration``
- `platform` must be a string; only `"web"` is served (`lib/index.js:714`)
- `inject` / `external` must be string arrays (``client-modules: ${subject} ${field} must be a string array``)
- `immediately` must be boolean

Field semantics:

| Field | Meaning | Evidence |
|---|---|---|
| `bundle.patch` | Path(s) to Cordis loader patch file(s). **String or array of strings.** | `dsh-app-boot\lib\index.js:495-499` `bundlePatchFiles()`: `throw new Error("dsh.bundle.patch must be a file path or a list of file paths")` |
| `client.platform` | `"web"` — only value served | `dsh-client-modules\lib\index.js:714` |
| `client.inject` | Package-level dependency names carried onto the bundle's graph row | `dsh-client-modules\lib\index.js:395-403` (`graphRow`), `:724` |
| `client.external` | **Non-baseline** module requests. The shell seeds a frozen `PLATFORM_MODULES` table (React, Cordis, static UI libraries); everything else must be declared here and be answerable by another dynamic row. | `dsh-client-modules\README.md:46` |
| `client.immediately` | Load on boot instead of lazily | `dsh-client-modules\lib\index.js:726`; `README.md:38` "module bodies remain lazy and run only at first import" |
| `icon` | Top-level. SVG/PNG/JPEG/WebP ≤ 256 KiB, confined to the manifest dir after realpath. | `dsh-app-boot\lib\index.js:1969-1999` `readPluginMeta()` |
| `compatibility.dshReleases` | Map of exact DSH version → `"compatible"`. Version exemptions are `package-name@version` → list of exact runtime versions, stored in the profile's own `compatibility.json`. | `dsh-context\package.json`; `dsh-plugin-manager\README.md:63-69` |

**`manifestVersion` does not exist.** It was searched for across every extracted `@deepseek-ai/dsh-*`
package, `dsh-app-boot`, and all three installed example plugins, and appears nowhere. The manifest
contract above is the complete observed one. Treated as **UNKNOWN/absent** (see §12).

The package must export a `./client` bundle if it declares `dsh.client`:
`dsh-client-modules\lib\index.js:718-719` ⇒
``throw new Error(`client-modules: ${packageName} declares dsh.client but exports no "./client" bundle`)``.
`exports["./client"]` may be a string or an object with a string `default`
(`:170-180`).

### 1.2 `cordis.patch.yml`

The **entire** `dsh-context` file (6 lines, verbatim — the comment is the authoritative explanation):

```yaml
# The row loads the package's main entry as the host half (a plain Cordis plugin);
# the `dsh.client` declaration makes the web app load its ./client bundle as the
# browser half.
- insert:
    - id: dsh-context
      name: dsh-context
```

- `id` — the Cordis loader entry id. **Must be unique across all layers**; two bundles inserting the
  same id is a hard boot failure (`dshmarket\lib\hot.js:10`).
- `name` — the module specifier the Loader imports. `dsh-context` uses a bare name because the package
  is a direct dependency of the profile. A relative path (`./lib/index.js`) is also accepted
  (`dsh-client-modules\lib\index.js:745` handles `.`, `file:`, absolute).
- `config:` — optional; arbitrary object handed to `apply(ctx, config)` and validated by your exported
  `Config`. YAML `!!js` expressions are allowed in the profile patch layer.

A patch file is a **top-level YAML array**. Other row kinds (`dshmarket\lib\patch.js:127-158`,
`:294-295`):

```yaml
- id: ui-settings            # override / disable an EXISTING entry by id
  name: "@deepseek-ai/dsh-client-ui-settings"   # optional module-name assertion
  disabled: true             # the documented disable form (plugin-manager README:35-38)
  config: { enabled: false } # config override is a DIFFERENT mechanism, also valid

- insert:                    # rows nested under insert: are separate array elements
    - id: my-other-row
      name: my-other-row
```

### 1.3 How a plugin gets loaded — the two real channels

| Channel | Requirement | Where the mount lives |
|---|---|---|
| **BUNDLE** (preferred) | package declares `dsh.bundle.patch` **and** is listed in the profile's `dsh.profile.bundles` | the patch file is applied as a layer; nothing manual |
| **MANUAL ENTRY** | nothing special | you add your own `- insert:` row (and/or `- id:` override) to `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` |

Profile manifest, `%USERPROFILE%\.dsh\profiles\desktop\package.json`:

```jsonc
"dsh": {
  "profile": {
    "bundles": [
      "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dshmarket",
      "dsh-plugin-save-token", "dsh-context", "@liustack/modlens", "dsh-blender", "billion-context"
    ]
  }
}
```

- Nothing consumes the patch file unless the package is in that list. `dsh-image-gen`, `dsh-better-sidebar`
  and `dsh-pet` are installed dependencies but are **not** in `dsh.profile.bundles` on this machine —
  they load through the other channel (manual rows / market).
- A listed bundle that does **not** declare `dsh.bundle.patch` fails the boot:
  `dsh-app-boot\lib\index.js:929` ``throw new Error(`${binName}: profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle in its package.json`)``;
  `dshmarket\lib\check.js:855` ``layer.error = 'bundle declares no dsh.bundle.patch — the profile will fail to boot'``.
- Layer order: `dsh-base` → … → `dsh-web-app` → profile patch → home patch. Official in-box bundles
  (`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`) keep **fixed positions**; only community bundles
  are reorderable (`dshmarket\lib\order.js:6,19`). A bundle may declare
  `dsh.bundle.order.{before,after}` — "a list of bundle package names" (`dshmarket\lib\order.js:85`).
- The profile patch layer is documented in its own header comment
  (`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`): *"Your patch layer for this dsh profile,
  applied after every bundle layer: a top-level YAML array of loader patch entries (id-targeted config
  overrides, disables, and insert lists; `!!js` expressions allowed)."*

A third, **market-only hot-mount** channel exists in `dshmarket`. It accepts only plain `id`/`name`
insert rows; anything else (config blocks, disables, expressions) is rejected with
`dshmarket\lib/hot.js:548`: *"the bundle patch contains config/expression rows; hot-mount only supports
plain inserts — it activates on restart"*. Client-only packages (`dsh.client` **without** `dsh.bundle`)
never receive a host patch and are unreachable without that shim (`dshmarket\lib\hot.js:562-567,631-659`).

> The phrase **"market temp entry"** was found in **no** inspected source. The two documented channels
> above are the ones that exist. Treated as **UNKNOWN**.

---

## 2. Host half — `lib/index.js`

A host plugin is a plain Cordis plugin. Ground truth `dsh-context\lib\index.js:3013-3015,3035`:

```js
const name = "dsh-context";
const inject = ["sessionProjections"];
function apply(ctx, config) { /* … */ }
export { Config, apply, inject, name };
```

`dsh-image-gen\lib\index.js:28249-28262`:

```js
const name = "dsh-image-gen";
const inject = ["tools", "attachments", "credentials", "webServer"];
function apply(ctx, config = {}) { /* … */ }
```

Rules:

- **`name`** — string; convention is the package name (used in route namespacing and diagnostics).
- **`inject`** — array of **service names** this plugin hard-depends on. Cordis parks the fiber until
  every named service exists. Declaring a name that never appears leaves the plugin permanently
  `waitingFor`.
- **`apply(ctx, config)`** — the body. Called once per activation.
- **`Config`** — optional schemastery schema. Use `z.object` from `@deepseek-ai/schemastery`; normalize
  inside `apply` with `Config(config ?? {})`.

### 2.1 `Config` with schemastery

`dsh-context\lib\index.js:1523-1556`:

```js
const count = (defaultValue) => z$1.number().min(1).step(1).default(defaultValue);
const Config = z$1.object({
  maxRequestSteps: count(DEFAULT_BOUNDS.maxRequestSteps),
  defaultPlacement: volatileField(z$1.union(["all", "tab", "sidebar"]).default("all").loose()),
  defaultGranularity: volatileField(z$1.union(["step", "turn"]).default("step").loose()),
  // …
});
// inside apply:
const normalized = Config(config ?? {});
```

`dsh-host-webserver\lib\index.js:141-147` shows the same style with `z.const`, `z.natural`,
`z.union`, `z.boolean`, `.required()`, `.default()`.

### 2.2 Injectable services proven by real plugins

| Service name | Provided by | Seen in |
|---|---|---|
| `tools` | `@deepseek-ai/dsh-tools` | `dsh-image-gen` inject array |
| `attachments` | `@deepseek-ai/dsh-attachment` | `dsh-image-gen` |
| `credentials` | `@deepseek-ai/dsh-credentials` | `dsh-image-gen` |
| `webServer` | `@deepseek-ai/dsh-host-webserver` | `dsh-image-gen` |
| `sessionProjections` | `@deepseek-ai/dsh-session-projection` | `dsh-context` |
| `systemPrompt` | prompt assembly | `dsh-image-gen\lib\index.js:28358-28364` |
| `llm` | `@deepseek-ai/dsh-llm` | `dsh-llm\lib\index.js` `super(ctx, "llm")` |
| `storage`, `storageDomain` | `@deepseek-ai/dsh-storage{,-domain}` | see §6 |
| `approval`, `sandboxPolicy`, `fs`, `ptcRuntime`, `logger` | core | cross-plugin |

The service name is the literal first argument of `super(ctx, "<name>")` in the providing class —
e.g. `dsh-host-webserver\lib\index.js:157-162`:

```js
constructor(ctx, config) { super(ctx, "webServer"); … }
```

### 2.3 `ctx` escape hatches and lifecycle

```js
ctx.get("dshHomePath")            // untyped; ALWAYS typeof-check the result
typeof homePath === "function"    // dsh-context\lib\index.js:3003
ctx.get("attachments")?.fileHostPath(ref)   // dsh-llm\lib\types\index.js:809

ctx.logger.debug|info|warn|error  // dsh-context\lib\index.js:2469-2480

ctx.effect(() => <disposer-or-nested-fn>, "<label>")   // cleanup idiom
ctx.effect(() => ctx.webServer.register({...}), "dsh-image-gen: subscription login route")  // dsh-image-gen\lib\index.js:9694
ctx.effect(() => async () => { /* teardown */ }, "webServer.listen")                        // dsh-host-webserver\lib\index.js:306
```

**Rule:** any registration that returns a disposer should be wrapped in `ctx.effect(...)` so plugin
unload releases it. `ctx.tools.register()` is the one exception — it installs its own effect
(`dsh-tools\lib\index.js:2886`).

### 2.4 Providing your own service

```js
import { Service } from "@deepseek-ai/cordis";
class MyService extends Service {
  static inject = ["webServer"];
  static Config = z.object({ /* … */ });
  constructor(ctx, config) { super(ctx, "myService"); /* … */ }
}
export { MyService as default, MyService };
```

Modelled on `dsh-host-webserver\lib\index.js:157-162` (which exports
`export { WebServer, WebServer as default, renderIndexInjections };` at `:366`) — a service package's
`dsh.bundle.patch` mounts the class as an entry, not a bare `apply`.

---

## 3. Registering an HTTP route

`@deepseek-ai/dsh-host-webserver`. Whole implementation:
`D:\dsh-English-study-workplace\.dsh-asar\dsh-host-webserver\lib\index.js` (366 lines).
Inject name is exactly `"webServer"` (`:157-162`).
Exports (`:366`): `export { WebServer, WebServer as default, renderIndexInjections };`

### 3.1 API

```js
register(route)        // :177-184
registerUpgrade(route) // :191-197
registerFallback(handler) // :206-212 — ONE seat only; second registration throws; none ⇒ 404
tapIndex(transform)    // :220-226 — pure html => html
get port()             // :164 — OS-assigned value when config.port === 0
get host()             // :168
```

Route object (verbatim from `:177-184`):

```ts
type Route = {
  kind: "exact" | "prefix";
  path: string;                                     // the URL path, verbatim
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
};
```

- `register` returns a **disposer** (`:182-184` `return () => { table.delete(route.path) }`).
- Duplicate registration throws: ``webserver: duplicate ${route.kind} route "${route.path}"`` (`:180`).
- Matching order (`match`, `:323-332`): **exact table first**, then **longest prefix** where
  `pathname === prefix || pathname.startsWith(prefix + "/")`, then the fallback.
- Dispatch (`:229-245`): `new URL(req.url ?? "/", "http://x").pathname` → handler, else `404`.
- Handler failure policy (`:246-259`): a throw is logged with `ctx.logger.warn(err)`, then **400** if
  headers were not sent, else `res.destroy()`. A route handler can never crash the process.
- Config (`:141-147`): `{ host: "127.0.0.1" | "0.0.0.0", port, compression: "none"|"gzip", compressionLevel, compressionThresholdBytes }`.

### 3.2 URL formation and same-origin

**The host adds no prefix — your `path` string *is* the URL.** The convention is to self-namespace:

```js
const IMAGE_ROUTE = "/plugins/dsh-image-gen/image";
```

`dsh-image-gen\lib\index.js:5586-5604` declares eleven such constants (`/plugins/dsh-image-gen/{image,
import,delete,studio,inspiration,save-workspace,test,canvas-state,canvas-asset,subscription-login,subscription-status}`);
the client half re-declares the identical literals (`dsh-image-gen\lib\client.js:77-95`) and calls them
with relative `fetch(...)` (`lib/client.js:1732, 116145, 116388, 119423, …`).

**Same-origin: yes.** The webserver is `node:http` with no TLS/auth/origin policy of its own
(`dsh-host-webserver\README.md:12,113`), and the web GUI is served by the same server's SPA owner; the
client's relative fetches resolve against it. Route owners enforce their own request policy — every
real plugin copies a guard rather than relying on the host. `dsh-image-gen\lib\index.js:28216-28220`:

```js
function sameOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  return origin === void 0 || host === void 0 || origin === `http://${host}` || origin === `https://${host}`;
}
```

plus helpers `:28235-28246`:

```js
function json(res, status, value) {
  /* … */
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}
function jsonError(res, status, code) { json(res, status, { error: code }); }
```

and a capped body reader `:28224-28234` that accumulates `for await (const chunk of req)` up to
`MAX_BODY_BYTES`.

The shipped GUI port value is **`UNKNOWN`** (this session's GUI is `http://127.0.0.1:19387`, given in
runtime context, not read from config).

### 3.3 A `prefix` route

```js
ctx.effect(() => ctx.webServer.register({
  kind: "prefix",
  path: "/plugins/dsh-image-gen/studio",
  async handler(req, res) {
    const path = new URL(req.url ?? "/", "http://x").pathname
      .slice("/plugins/dsh-image-gen/studio".length);   // strip your OWN prefix
    // …
  },
}), "dsh-image-gen: studio route");
```

Modelled verbatim on `dsh-image-gen\lib\index.js:28392-28400`.

### 3.4 Index injection (advanced)

`webserver/index-inject` (`:350-354`) emits a table you can add rows to; `renderRow` (`:24-52`)
understands `{kind}` ∈ `global` | `script` | `script-src` | `script-preload` | `style` | `html`, each
with `placement: "head" | "body"`. You can also `tapIndex(html => html)` for a pure transform.
The boot-readiness tail is `READY_MARKUP` (`:65`):
`<script>(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()</script>`.
Most plugins never need this — it is how `dsh-client-modules` installs `window.__ModuleLoader__`.

---

## 4. Registering an agent tool

`@deepseek-ai/dsh-tools`. Inject name `"tools"` (`super(ctx, "tools")`, `dsh-tools\lib\index.js:2704`).
Relevant exports (`dsh-tools\lib\index.js:3714`):
`defineTool`, `ToolRuntime` (default), `validateArgs`, `assertSupportedJsonSchema`,
`parameterSchemaSpecToJsonSchema`, `valueSchemaSpecToJsonSchema`, `ToolArgsError`, `ToolOutputError`,
`ToolNotFoundError`, `CodeRunFailedError`, `JsonSchemaError`, `TOOL_ABORTED`, `TOOL_RUNTIME_SCHEDULER`,
`RUN_CODE_NAME`, `jsonSchemaToTs`, `jsonSchemaToPy`.

### 4.1 Real registration — `dsh-image-gen\lib\index.js:28488-28557`

```js
ctx.tools.register(defineTool({
  name: "generate_image",
  description: "Generate a new image with the configured provider. …",
  parameters: {
    prompt:  { type: "string", required: true, description: "Complete description of the image to generate." },
    provider:{ type: "string", enum: ["google","openai","openai-compat","seedream","dashscope","xai","zhipu","comfyui","chatgpt-sub","grok-sub","google-sub"], description: "…" },
    model:   { type: "string", description: "…" },
    aspect_ratio: { type: "string", enum: ["1:1","3:2","2:3","4:3","3:4","4:5","5:4","16:9","9:16","21:9"], description: "…" },
    image_size:   { type: "string", enum: ["1K","2K","4K"], description: "…" },
    size:    { type: "string", description: "…" },
    workflow:{ type: "string", description: "…" }
  },
  output: imageOutput("Generated"),
  async execute(args, exec) { return generateSingle(args, exec); },
  presentResult: (_args, result) => imagePresentation(result)
}));
```

Array parameters, `:28561-28567`:

```js
prompts: { type: "array", items: { type: "string" }, required: true, description: "…" }
```

### 4.2 `register(definition)` contract

`dsh-tools\lib\index.js:2878-2887` (verbatim behaviour):

- `definition.output` **must** be `{ schema, render, presentationMeta? }` with
  `typeof output.render === "function"`; otherwise
  ``TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`)``.
- `output.schema` is validated by `assertSupportedJsonSchema`.
- `timeoutMs`, if present, must be a positive finite number.
- The name `"run_code"` is reserved and rejected.
- Returns a **disposer**; `register` installs its own effect, so **do not** wrap it in `ctx.effect`.

Other service methods: `restrict({allow, deny})` (`:2895-2909`, scoped contexts only, unknown names
throw), `guard(fn)` (`:2921-2926`, return a reason string to deny), `guardReason(exec)` (`:2928`),
`schemas(scope)` (`:3023`), `get(name, scope)`.

### 4.3 `defineTool` — the parameter schema DSL

Implementation: `dsh-tools\lib\types\schema.js:274` ff. It reads
`options.execute | options.finalizeContent | options.projectContent | options.output.render |
options.output.presentationMeta | options.presentCall | options.presentResult |
options.isConcurrencySafe`, converts `options.parameters` with `parameterSchemaSpecToJsonSchema` and
`options.output.schema` with `valueSchemaSpecToJsonSchema`, and produces a definition whose `execute`
validates arguments first and throws `ToolArgsError` on violation.

`parameters` is an **implicit object** of per-property value schemas. Allowed author keys per node:

| Node type | Allowed keys |
|---|---|
| any | `description`, `title`, `default`, `examples` + the node's own keys |
| any, **only** inside a parameter map or an object's `properties` | `required` (must be `true` when present) |
| `string`/`number`/`integer`/`boolean`/`null` | `type`, `enum`, `const` |
| `array` | `type`, `items` |
| `object` | `type`, `properties`, `additionalProperties` — **`additionalProperties` is mandatory and must be `true` or `false`** |
| `json` | annotation-only; no validation |
| `oneOf` | ≥ 2 branches; cannot combine with `type` |

Any other key ⇒ `JsonSchemaError` with ``${path}.${key} is not supported by the value schema DSL``
(`:21-26`). `parameterSchemaSpecToJsonSchema` returns `{ type: "object", properties, required? }`
(`:238-247`).

### 4.4 The `exec` object

Properties observed by frequency across `dsh-tools\lib\index.js`:
`agent` (23), `name` (14), `signal` (10), `parent` (6), `callId` (6), `arguments` (5), `rootCallId` (4),
`token` (3), `schema` (2), `deferContext` (2), `concludeTurn` (1).

**`exec.signal` is a caller-owned `AbortSignal` your tool body MUST observe** (`dsh-tools\README.md:123`).

### 4.5 Registration side-effects and pipeline

- Registering a tool feeds its schema into system-prompt assembly automatically (`README.md:28`).
- Presentation `mode` config: `native | ptc | both`, default `native` (`README.md:72-75`).
- Pipeline order (`README.md:105`):
  `tools/pre-execute` → guards → `tools/execute` → `tools/post-execute` → `finalizeContent` → `tools/result`.

---

## 5. Calling an LLM

`@deepseek-ai/dsh-llm`. Service `LlmRuntime`; inject `"llm"`.
The adapter side defines it with `super(ctx, "llm")` (`dsh-image-gen\lib\index.js:1287`).

### 5.1 Streaming — primary API (`dsh-llm\README.md:49-59`, verbatim)

```js
for await (const chunk of ctx.llm.stream({
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
})) {
  // chunks: block-start, text-delta, ..., usage, finish
}
```

- `ctx.llm.listProviders()` — registered routes in registration order (`README.md:59`).
- `ctx.llm.listModels(provider)` — `dsh-llm\lib\types\index.js:556`.
- `ctx.llm.prepareCall(config, signal)` — `:731`.
- Terminal chunk is always `finish`: `{ kind: 'error', failure }` on failure,
  `{ kind: 'aborted', failure }` on cancellation (`README.md:74`).
- **Route on `failure.code`, never on message text.** Stable codes: `NO_ADAPTER`,
  `MISSING_CREDENTIAL`, `AUTH`, `RATE_LIMIT`, `CONTEXT_WINDOW_EXCEEDED`, `QUOTA`, `ACCOUNT_QUOTA`,
  `INVALID_CREDENTIAL`, `IMAGE_OFFLOAD_REQUIRED`, `INVALID_PREPARED_CALL`.
- `GenerateOptions` sampling is `temperature` / `maxTokens` / `stop` **only** — no `tool_choice`,
  `top_p`, or penalties (`README.md:158`). Other observed fields: `provider`, `model`, `messages`,
  `signal`, `tools`, `toolHistory`, `sessionId`.
- This service **never retries**; `@deepseek-ai/dsh-llm-retry` is a separate package.
- Adapters are separate packages: `dsh-llm-deepseek`, `dsh-llm-pi-ai`, `dsh-llm-deepseek-api-key`
  (config `apiKeyEnv`).

### 5.2 Multimodal — how an image reaches a model

**Do not hand-roll base64.** Save bytes through the attachments service, then put the returned durable
reference into an image content block.

`dsh-attachment\README.md:69` (verbatim): *"The `ImageBlock` content block in `dsh-llm` carries an
`ImageAttachmentRef`; provider adapters resolve it into deterministic request versions at an explicit
route-chosen target size and byte target."*

Block shape, proven in `dsh-llm\lib\types\content.js`:

```js
{ type: "image", attachment: <ImageAttachmentRef>, offloaded?: true }   // :151, :159
{ type: "file",  attachment: <FileAttachmentRef> }                      // :123
```

`ImageAttachmentRef` fields seen: `attachmentId` (`sha256:…`), `mediaType`
(`image/png|jpeg|webp|gif`), `width`, `height`, `name`, `bytes` (`content.js:23-38, 113`).

Attachments service — inject `"attachments"` (`@deepseek-ai/dsh-attachment`, `README.md:75`):

```
admitPromptContent(…)  admitEncodedFile()  saveFile(bytes)  saveFileStream(chunks)
readFileStream(ref)    readImage(ref)      readImageRequest(ref)   imageHostPath(ref)
fileHostPath(ref)      isAttachmentError(e)
```

Usage in `dsh-image-gen\lib\index.js:28282-28290, 28365-28369`:

```js
const image = await ctx.attachments.readImage(ref);
const limits = ctx.attachments.imageLimits;   // { maxImageBytes, mediaTypes }
const ref2 = await ctx.attachments.saveImage({ data, mediaType, name });
```

Then:

```js
for await (const chunk of ctx.llm.stream({
  provider: "deepseek-official",
  model: "deepseek-v4-flash",
  messages: [{
    role: "user",
    content: [
      { type: "text",  text: "What is in this image?" },
      { type: "image", attachment: ref2 },
    ],
  }],
})) { /* … */ }
```

Text-only models degrade automatically: `textOnlyImageText(ref)` =
`[image omitted because this model accepts text only; attachment sha256:<8 hex>]`
(`content.js:47-49`). Offloaded images get `offloadedImageText(ref)`. Files never reach a provider —
`projectFilesToText` converts each to one deterministic handle line
(`dsh-llm\lib\types\index.js:857-859`). Errors are `AttachmentError` with a stable `code`; check with
`isAttachmentError` (and `isImageAdmissionError` for the admission subset, `README.md:70,84`).

Images are normalized to 8-bit sRGB/sRGBA and saved under the harness home **before** the message
publishes; generic files are stored byte-for-byte read-only.

---

## 6. Persistence

Three host-side packages. A domain change emits `domain/changed`; nothing is model-visible.

| Package | Service | Role |
|---|---|---|
| `@deepseek-ai/dsh-storage` | `ctx.storage` | hub: a pure registration/mount table |
| `@deepseek-ai/dsh-storage-json` | backend named `"json"` | the on-disk backend |
| `@deepseek-ai/dsh-storage-domain` | `ctx.storageDomain` | validated, schema-checked, in-memory-read domains |

### 6.1 Hub — `dsh-storage\README.md:12,51`

`register()` and `mount()` return disposers. A mounted data form resolves as `ctx.storage.<form>`; the
domain form is **additionally** served as `ctx.storageDomain`. Error codes: `backend-not-found`,
`form-not-mounted`, `duplicate-backend`, `duplicate-mount`. `kv` is the only data-shape facet (`:131`).
Unit/table names must match `UNIT_NAME_RE`; record keys are arbitrary strings that **never** reach file
paths (`:79`).

### 6.2 Backend — `dsh-storage-json\README.md`

Config: **`root` is required**, with no `process.cwd()` fallback; created mode `0o700` on demand
(`:36,48-50`). Layouts:

- `single` — one pretty-printed `<root>/<unit>.json` per unit (`:80-86`):

```json
{ "unit": { "name": "workspace", "version": 1 }, "global": null,
  "tables": { "workspaces": { "<key>": { "path": "/work/demo" } } } }
```

- `per-record` — one `<root>/<unit>/<table>/<key>.json` = `{ "version": 1, "record": <value> }`, plus
  optional `<root>/<unit>/global.json` (`:73-88`).

Record keys must match `[a-zA-Z0-9_-]+`; an unsafe key is rejected **before any file op** (`:56`).
Publish is atomic: temp file → fsync → `rename()` → POSIX parent-dir fsync (`:74`). Errors:
`malformed-medium`, `version-mismatch`, `closed`. Writes are last-completion-wins across processes;
there is **no cross-process locking** (`:142`).

**Where storage physically lands on this install: `UNKNOWN`** — it is whatever `root` the active
composition passes; that value was not located in the read material.

### 6.3 Domain API — `dsh-storage-domain\README.md:38-56` (verbatim)

```js
// Owning package, once:
const workspaceSpec = defineDomain({
  name: 'workspace',
  version: 1,
  tables: { workspaces: domainTable(workspaceRecordSchema) },
})

// Consumer:
const domain = await ctx.storageDomain.open(workspaceSpec)
await domain.table('workspaces').put(id, { path: '/work/demo' })
const record = domain.table('workspaces').get(id)          // synchronous, from memory
domain.table('workspaces').update(id, (r) => ({ ...r, path: newPath }))
```

- `defineDomain` takes **zod** record schemas (so `z.infer` gives consumer types), while plugin
  `Config` stays schemastery.
- Reads are synchronous from validated in-memory state. Writes are durable before they resolve and emit
  `domain/changed` in order.
- **Release the domain**: call `domain.close()` inside your own `ctx.effect`.
- Backend-agnostic errors: `already-open`, `facet-unsupported`, `invalid-record`, `missing-key`,
  `closed`; backend failures such as `version-mismatch` pass through.
- No migration, no cross-table transactions, single-process change visibility.
- `dsh-storage-domain` config: `{ backend: <name> (required), routes: {domainName: backendName} = {} }`
  (`:62-68`).

---

## 7. Client half — `lib/client.js`

### 7.1 Module contract

The bundle is loaded through `window.__ModuleLoader__`. Executing it **only registers a factory**;
every module-body side effect (CSS injection included) lives inside the factory closure and runs at
first materialization (`dsh-client-modules\README.md:68`).

The factory's return value is the plugin's **module face** — a Cordis plugin. Proven from the source
tail of `dsh-cordis-client-runner\lib\client.js:6691-6702`:

```js
exports.apply = apply;
exports.inject = inject;
exports.name = name;
return module.exports;
```

and from `dsh-context\lib\client.js` (last line, verbatim):
`return t.exports={name:`dsh-context`,inject:[`slots`,`locale`],apply:tc},t.exports}});`

In ESM terms:

```js
export const name = "my-plugin";          // stable plugin name (string)
export const inject = ["slots", "locale"]; // CLIENT SERVICE names — see §8.1
export function apply(ctx) { /* … */ }
```

**Two accepted forms.** `evaluateClientHalf` (`dsh-cordis-client-runner\lib\client.js:183`) throws:

```
client half returned `undefined` — did you forget `return`?
  ✓ return (ctx) => { … }
  ✓ return { name: '…', inject: ['slots'], apply(ctx) { … } }
```

⇒ either a bare `(ctx) => {...}` function, or the object form. **Use the object form**: without an
`inject` declaration site, service access is blocked (see §7.2).

A plugin's client bundle is served at `/plugins/<id>/client.js` with a sibling
`/plugins/<id>/client.js.map` (`dsh-client-modules\lib\index.js:204, 293`), grouped into combo routes
(`/plugins/??<id>/client.js,…&rev=<rev>`).

### 7.2 Service access is gated by `inject`

`dsh-cordis-client-runner\lib\client.js:323-332` — `ctx.serviceName` access is checked against
`Object.keys(ctx.fiber.inject)`. Failure messages (verbatim):

- ``service "${prop}" is not declared by your plugin. Declare it on the plugin you return: { inject: ['${prop}', …], apply(ctx) { … } } — a plain `function` has no declaration site, so use the object form. The runtime then parks the package if the provider unloads.``
- ``dynamic ctx does not expose "${prop}". Available: ctx.on / ctx.provide / timer helpers after injecting timer, and any service your returned plugin declared in inject (slots and theme are the usual UI seats). Framework internals are withheld by design.``

Activation gating (`:590`):
`waitingFor: Object.keys(fiber.inject).filter((name) => this.env.ctx.get(name) === void 0)`.

Browser timers are also gated (`:41`, verbatim): *"browser timer globals are unavailable in dynamic
packages. Declare `inject: ['timer']` … In React, create timers from an event handler or
`React.useEffect` and return callback-form disposers from the effect cleanup."*

### 7.3 The smallest real client registration

Canonical catalogue example, `dsh-cordis-client-runner\lib\client.js:2394-2401` (verbatim):

```js
return {
  inject: ['slots'],
  apply(ctx) {
    ctx.slots.inject('conversation.approval.detail', () => ctx.slots.register(
      { name: 'conversation.approval.detail' },
      () => React.createElement('div', null, 'hello'),
    ))
  },
}
```

### 7.4 (a) Register a full page / route reachable in the GUI

The GUI has no URL router for plugins: a "page" is a **keyed slot entry** in `main`.

From `dsh-context\lib\client.js`: `e.slots.inject('main', () => e.slots.register({ name: 'main', key: '<your-key>' }, Component))`.

Catalogue example for `main` (`dsh-cordis-client-runner\lib\client.js:3912-3919`):

```js
ctx.slots.inject('main', () => ctx.slots.register(
  { name: 'main', key: '<one key the owner dispatches>' },
  () => React.createElement('div', null, 'hello'),
))
```

A full-frame page with no sidebar/chat chrome — use the list slot `conversation.view`, exactly as
`dsh-context` does:

```js
ctx.slots.inject('conversation.view', () => ctx.slots.register(
  { name: 'conversation.view', id: 'my-plugin', order: 20, locale: 'my-plugin', label: () => t('tab') },
  (props) => React.createElement(MyView, props),
))
```

Note the `id` (list slots require it), `order` (sort key = `priority` then `order`), `label` (tab text),
and `locale` (namespace used to translate the label). Source: `dsh-context\lib\client.js` bundle
(slot registrations for `conversation.view`, `main`, `conversation.chat.assistant-actions`).

### 7.5 (b) Register a sidebar tab

Two coupled registrations. From `dsh-context\lib\client.js` (the `xs(...)` helper):

```js
// 1. announce the tab to the right-sidebar service
ctx.sidebarRightTabs.register({
  id: TAB_ID,
  kind: KIND,
  title: () => t('tab'),
  guide: [{ order: 20, title: () => t('tab'), description: () => t('sidebar.guideDescription'), icon: Icon }],
})

// 2. occupy the keyed slot that renders the pane body
ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
  { name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS },
  (props) => React.createElement(MyPane, { ...props, host }),
))
```

`ctx.sidebarRightTabs` is a service provided by `@deepseek-ai/dsh-client-ui-sidebar-right` (a
plugin-provided service, so it is not in the core service catalogue). The keyed slot
`sidebar.right.pane.tab` is declared by the same package; `sidebar.right.pane.tab.title` is the
companion keyed slot for the tab's title node.

For a **left-sidebar** tab use the list slot `sidebar.panellist` (`id` + `order`).

### 7.6 (c) Register a settings form

The settings base is `@deepseek-ai/dsh-client-ui-settings` (inject `remote`, `configForms`,
`settingsSchema`).

- A whole feature page → list slot **`settings.section`** (register with `id`, `order`, `label`).
- A page inside the **Plugins** section → `settings.plugins.tab`.
- A single preference row inside General → `settings.general.item` (no props are passed by the owner —
  copy, current value and write path are all yours).
- Onboarding step → `settings.onboarding`; optional launcher → `settings.launcher`.
- The shell itself occupies `sidebar.settings`.

Wiring a **config form** to your host `Config` (`dsh-context\lib\client.js`):

```js
ctx.inject(['configForms'], (configForms) => {
  ctx.effect(() => {
    const form = configForms.get(ENTRY_ID);   // ENTRY_ID = your loader row id
    return form.attach(controller);
  }, 'my-plugin: config forms')
})
```

`ctx.configForms` API (`dsh-client-ui-settings\README.md:32-70`):

- `get(entryId)` → one shared controller per Host entry. Snapshot =
  `{ value, base, user, revision, writable, persistence }`. Writes: `set`, `unset`, `mutate`
  (one atomic operation list). Staged editors pass the revision they read before editing; conflicts
  preserve drafts.
- `whileServed(namespaces, register)` → `register` runs once any listed namespace is in the shared
  mirror, receives the served namespace set, and returns its own disposer. **The caller owns that
  disposer and wraps it in `ctx.effect`.**
- `describe()` → read/fold face `{ getSnapshot, subscribe, ensure, acceptView }`.
- `ctx.settingsSchema` rehydrates schemas, validates drafts, edits nested values.
- `ctx.configForms.developerTools` owns the Coding Tools switch and `ui-settings.enabled`
  (default `true`) with an `enabled` observable and `setEnabled`.

Transport (`README.md:62`): the client injects `remote` with its `settings` namespace, resolves Host
persistence once from `remote.$host` facts, and owns the single `settings.describe` reader — a shared
mirror refreshed on each forwarded `settings/document-updated` event and on `connection/reset`.

**Limitation (`README.md:106`):** *"Non-loopback pages get no durable settings"* — Host persistence is
disabled there and a form starts `unavailable`. This profile currently **disables** the settings base
via the profile patch (`- id: ui-settings` … `config: { enabled: false }`), so settings slots may not
exist on this machine until it is re-enabled.

### 7.7 Locale

```js
const NS = 'my-plugin';
ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'my-plugin: dictionaries');
const t = ctx.locale.bind(NS);
```

- `register<N extends keyof LocaleNamespaceMap>(ns, dicts: Record<BuiltInLocaleId, LocaleDictOf<N>>)` and
  `register(ns, locale, dict)`; both return disposers (`dsh-cordis-client-runner\lib\client.js:1175-1226`).
- `bind(namespace)` is stable per namespace, so it can ride `inject` surfaces without breaking
  memoization (`:1247`).
- Lookup walks the active language's fallback chain in the entry namespace, then the shared `common`
  namespace, before showing the key (`:1172`).
- Dictionaries may also ship as `locale/*.json` and be referenced by the manifest `files` array.

---

## 8. Client UI services and the slot catalogue

### 8.1 The complete client SERVICE list

From `CLIENT_SERVICE_API` in `dsh-cordis-client-runner\lib\client.js:1127-1592` (machine-generated,
authoritative). Exactly eight **core** client services:

| Service | Key methods (verbatim signatures) |
|---|---|
| `layout` | `selectPanel(panelId: MainPanelId \| null): void`, `beginNavigation(): AbortSignal`, `toggleSidebar(): void`, `openRightbar(track: boolean, fullscreen: boolean): void`, `closeRightbar(): void` |
| `locale` | `getLocale()`, `getSnapshot()`, `subscribe(fn)`, `setLocale(id)`, `addLanguage(input)`, `register(ns, dicts)` |
| `sessions` | session list/selection face |
| `slots` | `register`, `registerFactory`, `inject(key, callback): () => void` |
| `theme` | `register(definition): () => void` |
| `timer` | browser-safe timer face (must be injected explicitly) |
| `uiWorkspace` | workspace UI face |
| `workspaces` | workspace data face |

`ThemeDefinition = { id: string; colorScheme: 'light' | 'dark'; tokens: ThemeTokens }`;
`ThemeSnapshot = { preference, fontSize, active, themes, revision }`; events `theme/change`,
`locale/change`.

Non-core services a plugin may inject, seen in real code: `loader`, `modules`, `remote`,
`configForms`, `settingsSchema`, `sidebarRightTabs`, `dynamicCordisRunner` (last one is a
`dynamicCordisRunner` Remote namespace, injected as `"remote.dynamicCordisRunner"`).

### 8.2 The `slots` service

`dsh-cordis-client-runner\lib/client.js:1362-1396` (verbatim):

```ts
readonly register: SlotCore['register']
readonly registerFactory: RegisterFactory
inject(key: keyof SlotMap & string, callback: () => SlotInjectionEffect): () => void
```

`inject` doc (`:1384`): *"Install an effect for each declaration lifetime of a slot. The callback runs
synchronously when the declaration already exists; otherwise it runs inside the declaring `register()`
call after the declaration is committed. Collapse disposes the effect and a later declaration runs it
again. … The controller belongs to the caller's fiber, so plugin unload cancels a pending wait and
removes any active contribution."*

**Always register through `ctx.slots.inject(key, () => ctx.slots.register(...))`** — that is what makes
your entry appear whenever the declaring owner mounts, not only when it happens to be mounted first.

### 8.3 Slot kinds and option vocabulary

`SlotCore.register(options, component)` — `dsh-client-ui-slots\lib\index.js:163-243`;
exports at `:575`: `SlotCore`, `SlotOwnershipError`, `StaleAuthorizationError`,
`resolveSlotLabel`, `standardHookPropName`.

| Kind | Occupancy | Required option |
|---|---|---|
| `single` | exactly one entrant | — |
| `list` | ordered entries, sorted by `priority` then `order` | `id` |
| `keyed` | dispatch by key | `key` |
| `chain` | entries elect themselves via `select` | `select` |

Other options: `priority` (default 0; for `single`/`keyed`/`list` two entrants at the same priority
throw), `label`, `inject`, `children` (child-key → slot-spec table; declaring an already-declared child
throws), `store: defineStore(...)`, `locale`, `registrant`.

`register` returns a **disposer** that removes the entry and recursively collapses its declared
children. Registering an undeclared name throws:
``slot "${options.name}" is not declared (a parent entry's children table must declare it)``.

`SlotKind = 'single' | 'list' | 'keyed' | 'chain'`;
`SlotScope = 'root' | 'session-maybe' | 'session'` (`:2159-2163`).

Standard props every occupant receives (`:2364-2398`, always these six first):
`useResource`, `useWorkspaces`, `usePanelInfo`, `useSessions`, `useSessionStatus`, `useSessionRetainInfo`.

### 8.4 The 89 slot ids (complete)

```
conversation.approval.detail                    single / session
conversation.chat.assistant-actions             list
conversation.chat.commandview                   keyed
conversation.chat.node                          keyed
conversation.chat.turnTail                      list
conversation.composer                           chain
conversation.composer.bar                       single
conversation.composer.dock                      list
conversation.header                             single
conversation.header.leading                     single
conversation.hero.agentPreset                   single
conversation.hero.brand.mark                    single
conversation.hero.workspace                     single
conversation.hero.workspace.directoryFlow       single
conversation.input.activity                     single
conversation.input.attachments                  single
conversation.input.dock                         list
conversation.input.left                         list
conversation.input.model                        single
conversation.input.overlay                      list
conversation.input.permission                   single
conversation.input.plan                         single
conversation.input.right                        list
conversation.message.images                     single
conversation.plan-review.actions                list
conversation.session                            single
conversation.session.header                     single
conversation.session.header.actions             list
conversation.session.header.corner              single
conversation.session.header.lineage             single
conversation.session.header.utilities           list
conversation.trajectory.images                  single
conversation.view                               list
deliverables.file.actions                       list
deliverables.review.file.actions                list
main                                            keyed   ← full-page seat
main.conversation                               single
plugins.bundle.activation                       keyed
plugins.bundle.config                           keyed
plugins.detail.actions                          list
plugins.detail.badge                            list
plugins.detail.section                          list
plugins.item                                    list
plugins.row.config                              keyed
rightbar                                        single
rightbar.session                                single
root                                            single
settings.action                                 list
settings.close                                  single
settings.general.item                           list
settings.header                                 single
settings.launcher                               single
settings.models.footer                          list
settings.models.provider-card                   keyed
settings.models.sign-in                         single
settings.onboarding                             list
settings.plugins.tab                            list
settings.section                                list
settings.trigger                                single
shell.leading                                   single / root
shell.overlay                                   list / root
shell.quota-notice                              chain
sidebar                                         single
sidebar.brand.mark                              single
sidebar.brand.name                              single
sidebar.chat.conversation                       single
sidebar.footer.action                           list
sidebar.panellist                               list
sidebar.right.pane.tab                          keyed
sidebar.right.pane.tab.title                    keyed
sidebar.right.tab.document                      keyed
sidebar.right.tab.document.action               keyed
sidebar.right.tab.document.actions              list
sidebar.right.tab.document.office.pdf           keyed
sidebar.right.tab.document.unpreviewable        list
sidebar.right.tab.files.actions                 list
sidebar.right.tab.guide                         chain
sidebar.right.tab.guide.entry                   keyed
sidebar.right.tab.menu.item                     list
sidebar.session.row.hover                       list
sidebar.session.row.leading                     list
sidebar.settings                                single
sidebar.toggle.badge                            single
sidebar.workspaces                              single
sidebar.workspaces.directoryFlow                single
sidebar.workspaces.session.menu.item            list
sidebar.workspaces.session.row.action           list
tool.call.images                                single
tool.call.toolview                              keyed
tool.view.cordis                                keyed
```

Two docs worth quoting verbatim:

- `shell.overlay` registerOptions (`:4826`): *"Your cell key. Use an id of your own: a fresh id is
  added beside the shipped entries, while reusing a shipped id puts you in THAT cell and replaces it.
  Owners that filter by id address you by it."*
- `shell.overlay` (`:4819`): *"Frame-wide floating layer, above every column and outside their scroll
  containers. Deliberately generic and unowned by any feature: a badge, a toast stack or a status pill
  all belong here… The layer itself is click-through — entries opt back into pointer events — so an
  occupant never blocks the app underneath."*
- `shell.leading` (`:4793`): *"Window-chrome seat at the frame's top-left, over every main panel.
  Mounted only while the sidebar column is fully hidden (macOS desktop collapse; other platforms keep
  the rail) … OCCUPIED by ui-sidebar's reopen/New Session controls."*

A worked list-slot example with a hook, `sidebar.workspaces.session.menu.item` (`:5883`, verbatim):

```js
return {
  inject: ['slots'],
  apply(ctx) {
    const copyLabel = 'Copy Session ID'
    ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register(
      { name: 'sidebar.workspaces.session.menu.item', id: 'copy-session-id', order: 500 },
      ({ sessionId, useMenuOpenState }) => {
        const [, setMenuOpen] = useMenuOpenState()
        return React.createElement(
          'button',
          { type: 'button', role: 'menuitem', onClick: () => { setMenuOpen(false); void navigator.clipboard.writeText(sessionId) } },
          copyLabel,
        )
      },
    ))
  },
}
```

### 8.5 `@deepseek-ai/dsh-client-ui-primitives`

`D:\dsh-English-study-workplace\.dsh-asar\dsh-client-ui-primitives\lib\index.js` (530 533 B). The
single `export { … }` statement starts at offset 523 883 and is 6 650 chars long. Import specifier:
`@deepseek-ai/dsh-client-ui-primitives`.

Verified non-icon named exports (head, verbatim):

```
BrandWordmark, Button, CODE_HIGHLIGHT_EXTENSIONS, Checkbox, CodeBlock, ConnectionIndicator,
DEFAULT_DIFF_MAX_LINES, DEFAULT_READ_MAX_LINES, DEFAULT_SEARCH_MAX_LINES, DEFAULT_TERMINAL_MAX_LINES,
DiffBlock, DisclosureRow, FISH_LOGO_PATH, FISH_LOGO_VIEWBOX, FileTypeIcon, FishLogo,
GuideArtworkBrowser, GuideArtworkFiles, HoverCard, ICON_MEDIUM_STROKE, ICON_REGULAR_STROKE,
IconAgentPresetOutlineMedium, IconAgentPresetOutlineRegular, IconAlarmClockOutlineMedium, …
```

Verified tail (verbatim):
`… useAnchoredPosition, useCodeHighlighter, useDismissOnOutsidePointer, useModalLayer, writeClipboard`.

Also seen: `Input`, `JsonTree`, `Menu`, `MenuGroup`, `MenuSurface`, `Modal`, `Markdown`, `MarkdownText`,
`MenuItemButton`, `Pill`, `ReadBlock`, `RiskConfirmation`, `SearchBlock`, `SegmentedControl`,
`SegmentedTabs`, `SettingsForm`, `ShortcutKeys`, `StateDot`, `Switch`, `Tag`, `TerminalBlock`,
`TextShimmer`, `Toast`, `Tooltip`, `WebBlock`, `PathLabel`.

The bulk is a large `Icon*OutlineMedium` / `Icon*OutlineRegular` set (e.g. `IconPlusOutlineMedium`,
`IconPluginPinwheelOutlineRegular`, `IconPersonalizationOutlineRegular`, `IconPlanOutlineRegular`,
`IconPlayOutlineRegular`, `IconGlobeOutlineRegular`, `IconDatabaseOutlineRegular`,
`IconCordisPluginOutlineRegular`, `IconDeliverDocRegular`, `IconPinFillMedium`).

CSS modules ship per component (`lib/Button.module.css`, `lib/settings-form/fields.module.css`,
`lib/settings-form/SettingsForm.module.css`, `lib/markdown/MarkdownText.module.css`, …).

> The complete untruncated 6 650-char export list was not captured in full ⇒ the **exhaustive
> inventory is partially UNKNOWN**. The names above are safe to import.

### 8.6 `@deepseek-ai/dsh-client-ui-slots`

Pure, React-free registry. Exports (`lib/index.js:575`):
`SlotCore`, `SlotOwnershipError`, `StaleAuthorizationError`, `resolveSlotLabel`,
`standardHookPropName`. Full `SlotCore` type surface at
`dsh-cordis-client-runner\lib\client.js:2159-2225` — `register`, `registerFactory`, `factory(name)`,
`factoryVersion(name)`, `subscribeFactory(name, listener)`, `isFactoryLive(definition)`, `isLive(entry)`,
`entries(key)`, `entriesOfSlot(key)`, `spec(key)`, `specDynamic(key)`, plus `getSnapshot`/`subscribe`.
Companion service surface: `inject`, `renderSlot`, `renderSlotChain`, `renderFactorySlot`,
`useFactorySlot(name, fallback)`, `registerFactory()`, `factory(name)`, `factoryVersion(name)`,
`subscribeFactory(name, listener)`, `isFactoryLive(definition)`, `getSnapshot`, `subscribe`.

A **factory** is a lazily-materialized component registered once and stamped per entry
(`dsh-client-ui-slots\README.md`); use `slotInject`/`RegisterFactoryOptions` when you need
per-entry handles.

---

## 9. Client → host RPC

Three mechanisms exist. Pick by need.

### 9.1 Your own HTTP route (simplest, fully documented)

Declare the same literal constants in both halves; call with a **relative** `fetch`.

```js
// host: lib/index.js
const STATE_ROUTE = "/plugins/my-plugin/state";
ctx.effect(() => ctx.webServer.register({
  kind: "exact",
  path: STATE_ROUTE,
  async handler(req, res) {
    if (!sameOrigin(req)) return jsonError(res, 403, "forbidden");
    json(res, 200, { ok: true, value: await loadState() });
  },
}), "my-plugin: state route");

// client: lib/client.js
const STATE_ROUTE = "/plugins/my-plugin/state";
const res = await fetch(STATE_ROUTE, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});
```

Proven pattern: `dsh-image-gen\lib\index.js:5586-5604` (host constants) vs
`dsh-image-gen\lib\client.js:77-95` (client constants) and 28 relative `fetch(...)` call sites.
Same origin — no base URL, no CORS, no token. Add your own `sameOrigin` guard (§3.2).

### 9.2 `ctx.remote.<namespace>.<method>(...)` — the shared Remote facade

`@deepseek-ai/dsh-api-remotes` (`README.md`). The client mounts each generated `/remote` contributor
via `ctx.remote.$mount()`. Remotes mounted by this application (`:32, :92`): Office conversion,
Commands, credentials, settings, Goal, Schedule, dynamic Cordis, file and Session references,
read-only Host plugin inventory, plugin-installation registry, message feedback, permission presets,
Session Controller, subagents, Workspace Controller, account.

Result shape (`dsh-cordis-client-runner\lib/client.js:6585-6610`):

```js
const answered = await ctx.remote.settings.describe();
if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`);
const value = answered.value;

// types (client.js:1755-1759, 2039-2059):
interface ClientRemote extends TypertClientRemote {
  $stream<Item>(options: RemoteStreamOptions<Item>): RemoteStream<Item>
  readonly $host: RemoteHostFacts
}
interface RemoteHostFacts { readonly home: string | undefined; readonly isLoopback: boolean }
type ConnectionRpcResult<T> = { ok: true; value: T } | { ok: false; error: ConnectionRpcFailure }
interface ConnectionRpcFailure { code: string; message: string; details: object }
```

Forwarded events: `ctx.remote.$on("connection/reset", handler)`,
`ctx.remote.$on("cordis/request-run", handler)` etc. The legal key set is the
`API_REMOTE_FORWARDED_EVENTS` allowlist (`dsh-api-remotes\README.md:43`). Events are either ordinary
one-way (best-effort, **not replayed**) or Agent-scoped waterfall (pending ones replayed after
reconnect). A `connection/reset` refresh is mandatory for any cached mirror.

**A plugin defining its own Remote namespace was not found in any installed example ⇒ UNKNOWN.**
Use mechanism 9.1 instead.

### 9.3 Raw connection RPC

`ClientConnectionRpc` (`dsh-cordis-client-runner\lib/client.js:1755-1759`):

```ts
call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<ConnectionRpcResult<unknown>>
readonly open?: (channel, endpoint, payload, signal, uplink?: AsyncIterable<unknown>) => AsyncIterable<unknown>
```

Low-level; `dsh-client-connection` owns the transport. `connection/reset` fires on reconnect.

---

## 10. Dev loop

### 10.1 Does HMR exist? Yes — two independent systems.

**Client half — `@deepseek-ai/dsh-client-hmr`** (`README.md`, 128 lines).

* `:12` verbatim: *"`dsh-client-hmr` keeps open Web pages in sync with the Host plugin graph and reloads
  rebuilt browser bundles. Ordinary plugin enable/disable changes take effect without reloading the
  page or restarting the Host. Code rebuilds replace the affected plugin with fresh component state."*
* `:32` verbatim: *"Run `pnpm run dev:web`, which starts the host and the rebuild watchers together
  (`--no-serve` attaches only the watchers to a host started elsewhere, as does any watch process using
  the shared Client tsdown preset); rebuilt plugins are then swapped into the running browser
  automatically, one at a time. The preset stamps `lib/client.js` after all package-local chunks are
  written, so a chunk-only rebuild also advances the package revision without Host-side chunk
  scanning."*
* Config: one field `pollIntervalMs`, default `500` (`:40-44`).
* Host half watches each package's stamped entry artifact and serves SSE **`/plugins/events`** with
  `graph` and `rebuilt` frames. Revision identity = entry **mtime + ctime + size**, not a hash. Every
  new connection receives the current full graph (`:62`).
* Cascade (`:69`): *"A fiber's activation epoch strings its service providers' uids, so replacing a
  provider's fiber re-cascades every dependent through Cordis itself with zero HMR-side bookkeeping."*
* Failure policy (`:74`): a download failure leaves the running plugin active; after old-fiber teardown
  an import/activation failure does **not** restore the previous bundle; Settings → Plugins → Plugin
  list retries the latest graph.
* Limitations (`:116-118`): reload is coarse — a fresh fiber and fresh components; **React state inside
  the reloaded plugin is lost** while the data layer (connection/runtime fibers, Session objects) is
  untouched. No failure rollback. **Web transport only** — Electron install and backend restart do not
  use this SSE path.

**Host half — `@deepseek-ai/dsh-hmr`** (`README.md`, 96 lines) — a different package.
`:12` verbatim: *"Reload plugin source and configuration while an application is running. Module
replacements, Include refreshes and profile configuration changes share one queue. Package installation
runs outside that queue."* Enable source-module watching with:

```yaml
- id: hmr
  disabled: false
  config:
    root: ["."]
```

Config `:40-45`: `base`, `root` (`["."]`), `ignored` (`["**/node_modules","**/.*","cache","data"]`),
`debounce` (`100`). Uses Chokidar `awaitWriteFinish: true` (2 s stability window). `:88`: *"HMR itself
does not restart the process."* `:89`: *"Replacing installed package versions still requires a restart
through Plugin Manager."*

### 10.2 Rebuild matrix

| Change | What must happen | Evidence |
|---|---|---|
| **Plugin enable / disable** | nothing — applies live | `dsh-client-hmr\README.md:12`; `dsh-plugin-manager\README.md:14` ("With HMR enabled in YAML, configuration changes apply immediately") |
| **Profile / home `cordis.patch.yml` config edit** | nothing, with host HMR on (`root` configured); otherwise **restart** | `dsh-hmr\README.md:14,57` |
| **Host half source (`lib/index.js`)** | host HMR replaces the module if `root` watching is enabled; otherwise **restart the app** | `dsh-hmr\README.md:27,88` |
| **Client bundle (`lib/client.js`)** | rebuilt by the tsdown preset, then hot-swapped — requires the watcher to be running (`pnpm run dev:web` from the checkout); otherwise rebuild + **page refresh** | `dsh-client-hmr\README.md:32`; runtime context |
| **Brand-new plugin install (new package)** | `dsh plugin --profile desktop add <pkg>`, then **restart** — a new package's bundle must be served and its graph row inserted | `dsh-client-modules\README.md:50` ("`pnpm run build` must have produced each `lib/client.js` before launch"); `dsh-plugin-manager\README.md:130`; `dsh-hmr\README.md:89` |
| **Replace an installed package version** | **restart** | `dsh-plugin-manager\README.md:130`; `dsh-hmr\README.md:89` |

**For this machine specifically:** the GUI at `http://127.0.0.1:19387` will hot-reload client plugins
only while `pnpm run dev:web` (or an equivalent shared-preset watcher) is running from the DSH
checkout. Every other change requires rebuilding the Web artifacts and refreshing the page. Do not
start a second server.

### 10.3 Install / remove commands

`dsh plugin` forwards everything it does not own to pnpm (`dsh-cli\BGnVfe_D.js:13` — *"Parse only
DSH-owned commands; all other arguments remain pnpm's responsibility"*), with
`context = { profile, dir, installAnchor: INSTALL_ANCHOR, cwd: process.cwd() }`.

```powershell
& "D:\deepseek harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add dsh-my-plugin
& "D:\deepseek harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop remove dsh-my-plugin
& "D:\deepseek harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop version-exemptions
& "D:\deepseek harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop allow-version <pkg>@<ver> --dsh-version <exact> --accept-risk
```

DSH-owned subcommands are only `allow-version`, `revoke-version`, `version-exemptions`
(`dsh-cli\BGnVfe_D.js:13-56`). The `desktop` profile is reserved and requires the app to have
initialised it and be **fully quit** (`:10-12`):

```
Open DeepSeek Harness Desktop once to initialize its profile, then fully quit it before running dsh plugin --profile desktop.
```

Diagnostics land at `<profile>/.plugin-manager/logs` (`dsh-plugin-manager\README.md:133`).
Git-hosted plugins build via `prepare`, blocked by pnpm until allowed under `allowBuilds` in
`<profileDir>/pnpm-workspace.yaml` (`:97`).

> **Environment limit (this machine, this session):** `dsh plugin --profile desktop --help` fails with
> `EPERM: operation not permitted, open '%USERPROFILE%\.dsh\profiles\desktop\package.json.lock'`
> (`dsh-atomic-write\lib\index.js:195` `withFileLock`, reached via `dsh-plugin-manager`). The profile
> directory is outside the workspace sandbox. Run these commands from an unrestricted terminal. The
> live `--help` text is therefore **UNKNOWN**; the subcommands above are read from the implementation.

---

## 11. Complete minimal plugin

### `package.json`

```json
{
  "name": "dsh-hello",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js", "./package.json": "./package.json" },
  "files": ["lib/index.js", "lib/client.js", "cordis.patch.yml", "package.json"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-primitives"] }
  },
  "dependencies": { "@deepseek-ai/dsh-tools": "*" },
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.4", "@deepseek-ai/schemastery": "^3.18.2", "react": "^18.3.1" },
  "peerDependenciesMeta": { "react": { "optional": true } }
}
```

### `cordis.patch.yml`

```yaml
- insert:
    - id: dsh-hello
      name: dsh-hello
```

### `lib/index.js` — route + tool + LLM-with-image + storage

```js
import { z } from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

const name = "dsh-hello";
const inject = ["webServer", "tools", "llm", "attachments", "storageDomain"];

const ROUTE = "/plugins/dsh-hello/state";

const Config = z.object({ greeting: z.string().default("hello") });

function sameOrigin(req) {
  const origin = req.headers.origin, host = req.headers.host;
  return origin === void 0 || host === void 0 || origin === `http://${host}` || origin === `https://${host}`;
}
function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}
async function readJson(req, cap = 1 << 20) {
  let size = 0, text = "";
  for await (const chunk of req) {
    size += chunk.length;
    if (size > cap) throw new Error("payload too large");
    text += chunk;
  }
  return text.length === 0 ? null : JSON.parse(text);
}

function apply(ctx, config) {
  const cfg = Config(config ?? {});

  // ---- HTTP route (same-origin with the GUI) -------------------------------
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: ROUTE,
    async handler(req, res) {
      if (!sameOrigin(req)) return json(res, 403, { error: "forbidden" });
      if (req.method !== "POST") return json(res, 405, { error: "method" });
      try {
        const body = await readJson(req);
        json(res, 200, { ok: true, greeting: cfg.greeting, echo: body });
      } catch (error) {
        ctx.logger.warn(error);
        json(res, 400, { error: "bad-request" });
      }
    },
  }), "dsh-hello: state route");

  // ---- Agent tool ---------------------------------------------------------
  ctx.tools.register(defineTool({
    name: "hello_lookup",
    description: "Look something up and return a short text answer.",
    parameters: {
      query: { type: "string", required: true, description: "What to look up." },
      limit: { type: "number", default: 5, description: "Maximum results." },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => value,
    },
    async execute(args, exec) {
      if (exec.signal.aborted) throw new Error("aborted");
      return `queried ${args.query}`;
    },
  }));

  // ---- LLM call carrying an image ----------------------------------------
  async function describe(bytes) {
    const ref = await ctx.attachments.saveImage({ data: bytes, mediaType: "image/png", name: "shot.png" });
    let text = "";
    for await (const chunk of ctx.llm.stream({
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe this image in one sentence." },
          { type: "image", attachment: ref },
        ],
      }],
    })) {
      if (chunk.kind === "text-delta") text += chunk.text ?? "";
      // the stream ALWAYS ends with one terminal chunk: {kind:'finish'} or {kind:'error',failure}
      else if (chunk.kind === "error") ctx.logger.error(chunk.failure?.code, chunk.failure?.message);
      else if (chunk.kind === "aborted") ctx.logger.warn("aborted", chunk.failure?.code);
    }
    return text;
  }
  // expose it to the rest of the plugin's closures; to provide it as a SERVICE to other
  // plugins, return a `Service` subclass from a separate loader row instead (see §2.4).
  void describe;
}

export { Config, apply, inject, name };
```

### `lib/client.js`

```js
import * as React from "react";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";

const ROUTE = "/plugins/dsh-hello/state";
const name = "dsh-hello";
const inject = ["slots"];

function HelloPage() {
  const [answer, setAnswer] = React.useState(null);
  return React.createElement("div", { style: { padding: 24 } }, [
    React.createElement("h1", { key: "h" }, "Hello"),
    React.createElement(Button, {
      key: "b",
      onClick: async () => {
        const res = await fetch(ROUTE, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ from: "client" }),
        });
        setAnswer(await res.json());
      },
    }, "Ping host"),
    answer === null ? null : React.createElement("pre", { key: "p" }, JSON.stringify(answer, null, 2)),
  ]);
}

function apply(ctx) {
  ctx.effect(() => ctx.slots.inject("main", () => ctx.slots.register(
    { name: "main", key: "dsh-hello" },
    HelloPage,
  )), "dsh-hello: page");
}

export { apply, inject, name };
```

### Install

```powershell
# copy the package into %USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-hello
& "D:\deepseek harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add dsh-hello
# then restart the app
```

---

## 12. UNKNOWN — do not guess

| # | Item | Why it is unknown |
|---|---|---|
| 1 | `manifestVersion` in the `dsh` field | Appears in **no** extracted package, no `dsh-app-boot` source, no installed example. The manifest contract appears to be complete without it. |
| 2 | "market temp entry" load channel | The term was found in no source. Two real channels exist (bundle, manual entry) plus a market-only hot-mount restricted to plain insert rows. |
| 3 | Concrete GUI port / webserver `port` config value for this install | Not located in read material. (This session's GUI is `http://127.0.0.1:19387`, given out-of-band.) |
| 4 | On-disk location of `dsh-storage-json` data on this install | It is the configured `root`; that value was not located. |
| 5 | Exhaustive `dsh-client-ui-primitives` export list | The 6 650-char export statement was not captured in full; only head, tail and spot-checked middle names. |
| 6 | Whether a plugin can define its **own** `Remote` namespace | No installed example does; only shared namespaces (`settings`, `credentials`, `commands`, …) were observed. Use your own HTTP route instead. |
| 7 | Whether `watch.sh` / `web.sh` / `register.sh` exist in a DSH source checkout | `dsh-context\package.json` references them, but they are **not shipped** in any tarball on this machine. |
| 8 | Live `dsh plugin --help` text | Command fails with `EPERM` on `%USERPROFILE%\.dsh\profiles\desktop\package.json.lock` under this session's sandbox. |
| 9 | Exact return contract of `output.render(args, value)` | Only that it must be a function (validated in `dsh-tools\lib\index.js:2878-2887`). |
| 10 | Exact semantics of `dsh.client.inject` beyond "the bundle graph row's inject list (other client plugin package names)" | The row field is read at `dsh-client-modules\lib\index.js:400`, but its consumer semantics were not traced further. |

Everything else in this document was read from source at the cited path.

---

## 13. Source index

| Concern | Read this |
|---|---|
| Bundle/loader, profile resolution, plugin metadata | `D:\dsh-English-study-workplace\.dsh-asar\dsh-app-boot\lib\index.js` |
| `dsh.client` validation, bundle routes, module graph, combo URLs | `.dsh-asar\dsh-client-modules\lib\index.js` + `README.md` |
| Client service/event/type catalogue **and all 89 slot ids + examples** | `.dsh-asar\dsh-cordis-client-runner\lib\client.js` |
| Slot registry core | `.dsh-asar\dsh-client-ui-slots\lib\index.js` + `README.md` |
| Client UI components | `.dsh-asar\dsh-client-ui-primitives\lib\index.js` |
| Right sidebar slots + `sidebarRightTabs` | `.dsh-asar\dsh-client-ui-sidebar-right\README.md` |
| Settings base, `configForms`, `settingsSchema` | `.dsh-asar\dsh-client-ui-settings\README.md` |
| HTTP routes | `.dsh-asar\dsh-host-webserver\lib\index.js` (+ `README.md`) |
| Tools registry + schema DSL | `.dsh-asar\dsh-tools\lib\index.js`, `lib\types\schema.js`, `README.md` |
| LLM streaming + content blocks | `.dsh-asar\dsh-llm\lib\types\index.js`, `lib\types\content.js`, `README.md` |
| Attachments | `.dsh-asar\dsh-attachment\README.md` |
| Storage hub / json backend / domains | `.dsh-asar\dsh-storage{,-json,-domain}\README.md` |
| Remote facade | `.dsh-asar\dsh-api-remotes\README.md` |
| Client HMR | `.dsh-asar\dsh-client-hmr\README.md` |
| Host HMR | `.dsh-asar\dsh-hmr\README.md` |
| Plugin manager, disable form, version exemptions | `.dsh-asar\dsh-plugin-manager\README.md` |
| CLI | `.dsh-asar\dsh-cli\BGnVfe_D.js` |
| Market bundle ordering / hot-mount / patch parsing | `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dshmarket\lib\{order,hot,patch,check}.js` |
| Real host+client plugin | `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-context\` |
| Real plugin with HTTP routes + tools + LLM images | `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-image-gen\` |
| Real plugin with TypeScript sources + install scripts | `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-better-sidebar\` |
