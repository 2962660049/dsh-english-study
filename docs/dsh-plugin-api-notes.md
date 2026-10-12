# DSH Plugin API — raw research notes

Companion to `dsh-plugin-api.md`. This file records **how** the findings were obtained, so a later
reader can re-run or extend the research. Facts and conclusions live in `dsh-plugin-api.md`.

Target: DeepSeek Harness **`0.2.0-rc.2`**, desktop install `D:\deepseek harness\`.
Research performed from workspace `D:\dsh-English-study-workplace` (file policy: `workspace-write`).

---

## 1. Environment handles used

| Handle | Value |
|---|---|
| Bundled Node (v24.21.0) | `%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe` |
| asar reader | `D:\dsh-English-study-workplace\tools\asar-list.mjs` |
| DSH archive | `D:\deepseek harness\resources\app.asar` (~122 MB) |
| archive package prefix | `dsh/node_modules/@deepseek-ai/<pkg>/` |
| unpacked natives | `D:\deepseek harness\resources\app.asar.unpacked\` |
| CLI shim | `D:\deepseek harness\resources\runtime\cli\bin\dsh.cmd` |
| active profile | `%USERPROFILE%\.dsh\profiles\desktop\` |
| extraction root | `D:\dsh-English-study-workplace\.dsh-asar\` |

`node` is **not** on `PATH`. Always use the absolute path above.

`asar-list.mjs` behaviour (verified by reading the tool):

- `list <regex-on-path> <limit>` — regex is matched against the entry path.
- `extract <prefix> <outDir> <limit>` — filters `f.path.startsWith(arg)` and writes to
  `path.join(outDir, f.path.slice(arg.length).replace(/^\//,''))`.
  **It strips the prefix**, so every package needs its **own** `outDir` or files overwrite each other.
- Entries marked `unpacked` are counted but skipped.

---

## 2. Exact commands run

### 2.1 Earlier: dump every `@deepseek-ai/*/package.json` path (discovery pass)

```powershell
$node="%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node "D:\dsh-English-study-workplace\tools\asar-list.mjs" `
    "D:\deepseek harness\resources\app.asar" list "dsh/node_modules/@deepseek-ai/.*/package\.json$" 400
```

Result: **289 packages** matched. This is what identified the client-UI, storage, HMR, remote and
runner packages worth extracting.

### 2.2 Bulk extraction (one directory per package)

```powershell
$node="%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$tool="D:\dsh-English-study-workplace\tools\asar-list.mjs"
$asar="D:\deepseek harness\resources\app.asar"
$out="D:\dsh-English-study-workplace\.dsh-asar"
Remove-Item -Recurse -Force $out -ErrorAction SilentlyContinue
$pkgs=@(
 "dsh-host-webserver","dsh-tools","dsh-llm","dsh-storage","dsh-storage-json","dsh-storage-domain",
 "dsh-client-ui-primitives","dsh-client-ui-slots","dsh-client-ui-sidebar-right","dsh-client-ui-settings",
 "dsh-api-remotes","dsh-client-hmr","dsh-hmr","dsh-client-modules","dsh-cordis-client-runner",
 "dsh-cordis-host-runner","dsh-plugin-manager","dsh-session","dsh-client-ui-settings-plugins",
 "dsh-client-connection","dsh-client-locale","dsh-session-projection","dsh-client-ui-chat",
 "dsh-client-ui-sidebar","dsh-client-ui-settings-shell","dsh-host-plugin-inventory","dsh-attachment",
 "dsh-commands","dsh-brand","dsh-util-workspace-path","dsh-client-ui-conversation",
 "dsh-client-ui-renderer","dsh-web-app","dsh-base","dsh-client-store","dsh-client-ui-plugin-manager",
 "dsh-host-frontend-static"
)
foreach($p in $pkgs){ & $node $tool $asar extract "dsh/node_modules/@deepseek-ai/$p/" "$out\$p" 500 2>&1 | Select-Object -Last 1 }
```

### 2.3 Later extractions (found while following leads)

```powershell
& $node $tool $asar extract "dsh/node_modules/@deepseek-ai/dsh-app-boot/"     "$out\dsh-app-boot"     500
& $node $tool $asar extract "dsh/node_modules/@deepseek-ai/dsh-cli/"          "$out\dsh-cli"          500
```

`dsh-app-boot` had to be extracted twice — the first pass returned **zero files** (limit too small for
the package's entry ordering); re-running with limit 500 succeeded and produced 7 files.

---

## 3. What was extracted, and where

Root: `D:\dsh-English-study-workplace\.dsh-asar\`

| Package dir | Notable contents |
|---|---|
| `dsh-app-boot` | `lib/index.js` (181 850 B, 4137 lines), `README.md` 33 KB, `README.i18n.yaml`, `README.zh.md`, `lib/worker/profile-resolution-bootstrap.js` |
| `dsh-host-webserver` | `lib/index.js` (366 lines), `README.md` 8 KB |
| `dsh-tools` | `lib/index.js` (3714 lines), `lib/types/schema.js`, `README.md` 19 KB |
| `dsh-llm` | `lib/types/index.js`, `lib/types/content.js`, `README.md` 17.9 KB |
| `dsh-attachment` | `README.md`; `ImageBlock` / `ImageAttachmentRef` documented here |
| `dsh-storage` | `README.md` 8.3 KB |
| `dsh-storage-json` | `README.md` 8.6 KB |
| `dsh-storage-domain` | `README.md` 9.8 KB |
| `dsh-client-modules` | `lib/index.js` (981 lines), `lib/client.js`, `README.md` 15.2 KB |
| `dsh-cordis-client-runner` | **`lib/client.js` — 6706 lines, machine-generated API catalogue** |
| `dsh-cordis-host-runner` | host-side counterpart |
| `dsh-client-ui-primitives` | `lib/index.js` (530 533 B), per-component `.module.css` |
| `dsh-client-ui-slots` | `lib/index.js` (575+ lines), `README.md` 7.8 KB |
| `dsh-client-ui-sidebar-right` | `README.md` 26 KB |
| `dsh-client-ui-settings` | `README.md` 8.5 KB (118 lines) |
| `dsh-client-ui-settings-shell` | `README.md` 8.5 KB |
| `dsh-client-hmr` | `README.md` 128 lines |
| `dsh-hmr` | `README.md` 96 lines |
| `dsh-api-remotes` | `README.md` 9.6 KB |
| `dsh-plugin-manager` | `README.md`, `lib/operations` |
| `dsh-cli` | `BGnVfe_D.js` (5928 B, 101 lines) — the `dsh plugin` command implementation |
| `dsh-web-app`, `dsh-base` | package.json (9.5 KB for web-app), bundle composition |
| plus | `dsh-host-frontend-static`, `dsh-host-plugin-inventory`, `dsh-client-ui-plugin-manager`, `dsh-client-ui-conversation`, `dsh-client-ui-chat`, `dsh-client-ui-renderer`, `dsh-client-store`, `dsh-client-connection`, `dsh-client-locale`, `dsh-session`, `dsh-session-projection`, `dsh-commands`, `dsh-brand`, `dsh-util-workspace-path` |

### 3.1 Key structural discovery

**Archive packages ship NO `.d.ts`.** They ship:

- a large, authoritative **`README.md`** (the de-facto API documentation), and
- type-erased runtime under `lib/` plus `lib/types/*.js`.

The only fully type-annotated material in the archive is the **generated catalogue** in
`dsh-cordis-client-runner\lib\client.js`, which embeds verbatim TypeScript declarations as strings.

---

## 4. Most useful type/interface files for future reference

### 4.1 Inside the archive (type-erased, but the catalogue carries TS as data)

| File | Why |
|---|---|
| `D:\dsh-English-study-workplace\.dsh-asar\dsh-cordis-client-runner\lib\client.js` | `SERVICE_API` (`:1125`), `EVENT_API` (`:1668`), `TYPE_API` (`:1712`), `CLIENT_SLOT_API` (`:2363`), `CLIENT_BUILTIN_INSPECTION` (`:6141`). Contains every client service signature, every event, and **all 89 slot ids with `ownerProps`/`standardProps`/`registerOptions`/`example`** as literal TS strings. |
| `.dsh-asar\dsh-client-ui-slots\lib\index.js` | `SlotCore` implementation: `register` option validation, disposers, children collapse. |
| `.dsh-asar\dsh-tools\lib\types\schema.js` | The parameter/value schema DSL and its exact error strings. |
| `.dsh-asar\dsh-llm\lib\types\content.js` | `ImageBlock` / `FileBlock` / `ImageAttachmentRef` handling, text-only and offloaded degradations. |
| `.dsh-asar\dsh-llm\lib\types\index.js` | `LlmRuntime` methods: `stream`, `listProviders`, `listModels`, `prepareCall`, `fileReadPath`, `fileRequestText`, `imageRequestPricing`, `resolveCallWithInfo`, `adapterStream`. |
| `.dsh-asar\dsh-client-modules\lib\index.js` | `parseDshClient` (the closed `dsh.client` field set), `clientExportOf`, combo URL builder, graph ordering. |
| `.dsh-asar\dsh-host-webserver\lib\index.js` | Route table, matching, dispatch, failure policy, index-injection row kinds. |

### 4.2 Inside the installed example plugins (real `.d.ts`, hand-written/published)

`%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-context\lib\index.d.ts` — **48 KB**, the smaller
and more readable published type surface for a complete plugin (host + client + config).

`%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-better-sidebar\lib\types\**\*.d.ts` — **178 files**,
the richest published surface on this machine. Most valuable entries:

| File | Why |
|---|---|
| `lib\types\index.d.ts` | host-half public API |
| `lib\types\client\index.d.ts` | client-half public API |
| `lib\types\client\api.d.ts` | the client↔host RPC surface used by this plugin |
| `lib\types\config.d.ts` | real schemastery `Config` shape |
| `lib\types\bundle-route.d.ts`, `archive-route.d.ts`, `html-route.d.ts` | real route module patterns |
| `lib\types\client\sidebar\bottom-toggle.d.ts`, `lib\types\client\center-column.d.ts`, `lib\types\client\chats\*.d.ts` | real sidebar slot occupants |
| `lib\types\client\editor-load.d.ts`, `chunk-loader.d.ts`, `lazy-chunk.d.ts`, `frame-batcher.d.ts` | lazy-loading / chunk strategy for a big client bundle |
| `lib\types\client\layout-push.d.ts` | interacting with the `layout` client service |
| `lib\types\client\desktop-env.d.ts`, `open-in-app.d.ts` | desktop (Electron) detection |
| `lib\types\client\locales*.d.ts` | the full locale-dictionary typing pattern (22 language files) |
| `lib\types\client\ui\kit.d.ts`, `ui\index.d.ts`, `builtins\index.d.ts` | local UI kit layered on `dsh-client-ui-primitives` |

`dsh-better-sidebar\src\client\**` — the **only** readable TypeScript sources of a real client plugin on
this machine; useful for seeing the authoring form before compilation.

`%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-image-gen\lib\types\**\*.d.ts` — the type surface
for the HTTP-route-heavy example.

---

## 5. Files read in full or near-full

| File | Extent |
|---|---|
| `...\node_modules\dsh-context\package.json` | 158 lines, full |
| `...\node_modules\dsh-context\cordis.patch.yml` | 6 lines, full |
| `...\profiles\desktop\package.json` | 29 lines, full |
| `...\profiles\desktop\cordis.patch.yml` | 22 lines, full |
| `.dsh-asar\dsh-host-webserver\lib\index.js` | full |
| `.dsh-asar\dsh-client-hmr\README.md` | 128 lines, full |
| `.dsh-asar\dsh-hmr\README.md` | 96 lines, full |
| `.dsh-asar\dsh-client-ui-settings\README.md` | 118 lines, full |
| `.dsh-asar\dsh-client-ui-slots\lib\index.js` | key regions |
| `.dsh-asar\dsh-tools\lib\index.js` | export list, `register`, service methods |
| `.dsh-asar\dsh-tools\lib\types\schema.js` | DSL validation |
| `.dsh-asar\dsh-client-modules\lib\index.js` | `parseDshClient`, graph, routes |
| `.dsh-asar\dsh-cordis-client-runner\lib\client.js` | service catalogue, slot catalogue head/tail, module face |
| `.dsh-asar\dsh-cordis-client-runner\lib\client.js` (tail 6556-6706) | the client bundle's own `{name, inject, apply}` export face |
| `.dsh-asar\dsh-cli\BGnVfe_D.js` | full (101 lines) |
| `...\node_modules\dsh-better-sidebar\scripts\install.ps1` | header comment |
| `...\node_modules\dshmarket\lib\*.js` | grepped for `insert\|bundles\|dsh\.bundle\|profile\.bundles` |

---

## 6. Commands that were run for discovery (grep/scan patterns)

Recovering the complete slot id list (89 ids):

```powershell
# inside .dsh-asar\dsh-cordis-client-runner\lib\client.js
# pattern: ^\t\t\t\tkey: "     (4 tabs, then key: ") — matched lines 2365..6074
```

Recovering real slot usage in an installed plugin:

```
grep -o "slots.inject(['\"][a-z.]+"  ...\dsh-context\lib\client.js
grep -o "slots.register({ *name: *['\"][a-z.]+"  ...\dsh-context\lib\client.js
```

Recovering route constants and their client-side counterparts:

```powershell
Select-String -Path "...\dsh-image-gen\lib\index.js"  -Pattern '/plugins/dsh-image-gen/[a-z-]+'
Select-String -Path "...\dsh-image-gen\lib\client.js" -Pattern '/plugins/dsh-image-gen/[a-z-]+'
Select-String -Path "...\dsh-image-gen\lib\client.js" -Pattern 'fetch\([^)]{0,40}'
```

Recovering the bundle/market load model:

```powershell
Select-String -Path "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dshmarket\**\*.js" `
    -Pattern 'insert|bundles|dsh\.bundle|profile\.bundles'
```

---

## 7. Dead ends and environment limits (do not repeat)

1. **`Get-ChildItem -Recurse` over plugin `node_modules` returns nothing under the sandbox.**
   Non-recursive listing works. Enumerate **one directory level at a time**, or use the `glob` tool.
2. **`dsh plugin --profile desktop --help` fails** with
   `Error: EPERM: operation not permitted, open '%USERPROFILE%\.dsh\profiles\desktop\package.json.lock'`
   at `withFileLock` (`D:/deepseek harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-atomic-write/lib/index.js:195`)
   ← `runPlugin` (`.../dsh/lib/plugin-BGnVfe_D.js:90`) ← `runCli` (`.../dsh/lib/bin.js:236`)
   ← `runDesktopCli` (`.../dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js:93`).
   `[sandbox: file access denied under workspace-write mode]`. The profile dir is outside the workspace.
   Approval prompts are disabled in this session, so the live help text could not be captured —
   the implementation file was read instead.
3. **`subagent` / `subagent_fork` are unavailable from this session**:
   `Error: subagent depth 2 exceeds maxDepth 1`. This research session is itself a delegated
   subagent; all work had to be done inline.
4. **The asar tool matches PATHS, not content.** There is no way to full-text-search the archive; every
   content question required extracting the package first. This is why `manifestVersion` could not be
   conclusively excluded across all 289 packages — only across the ~40 relevant ones.
5. **`dsh-context`'s `watch` / `web` / `register` npm scripts point at files not shipped** in its
   tarball. `dsh-better-sidebar` is the only installed example with a `scripts/` dir
   (`install.ps1`, `install.sh`) — also not shipped inside `dsh-context` / `dsh-image-gen`.
6. **`dsh-image-gen`, `dsh-better-sidebar` and `dsh-pet` are installed dependencies but are NOT in
   `dsh.profile.bundles`.** They must load through the manual-entry / market channel. Do not assume
   "installed" implies "in the bundle list".

---

## 8. Environment notes worth carrying forward

- This session's web GUI: `http://127.0.0.1:19387` (given in runtime context, not read from config).
- The client-plugin HMR receiver is active in the running GUI, but automatic reload only happens while
  a dev watcher (`pnpm run dev:web`) is running from the DSH checkout.
- The profile currently **disables** the settings base plugin:
  `- id: ui-settings` + `name: "@deepseek-ai/dsh-client-ui-settings"` + `config: { enabled: false }`
  in `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`. Settings slots may therefore be absent until
  it is re-enabled.
- Profile-level `config` overrides observed in the same file, useful as real syntax examples:
  `- id: ui-settings-account` + `config: { version: 1, step: done, purpose: null, process: standard, completion: skipped, usage: compact, developerTools: false }`,
  `- id: ui-chat` + `config: { transcriptView: standard, performanceUsage: compact }`.
- `dsh-better-sidebar/install.ps1` documents the bundle-channel behaviour in its header: declaring
  `dsh.bundle.patch` makes the CLI's bundle reconciliation add the package to the profile's
  `dsh.profile.bundles` automatically, and it mounts on the next start. Versions before 0.10.2 used a
  manual mount row which must be **removed** once the bundle channel is active, or the plugin mounts
  twice. It also pre-writes `minimumReleaseAgeExclude` into the profile's `pnpm-workspace.yaml` because
  pnpm 11's `minimumReleaseAge` rejects versions published less than 24 h ago. Env vars honoured:
  `DSH_HOME`, `REGISTRY`, `DSH_CMD`; `--restart` runs `pm2 restart dsh-web`.

---

## 9. Grep spill files (raw, if a detail above is insufficient)

| Content | Path |
|---|---|
| 250 of 331 `dshmarket` lines matching `insert\|bundles\|dsh\.bundle\|profile\.bundles` | `%TEMP%\dsh-spill-GWbKqQ\session-8c5125fdd266\09509ccd4299-grep-results.txt` |
| `dsh-context\lib\client.js` matches for `/plugins/\|fetch(\|host.call\|remote.` | `%TEMP%\dsh-spill-GWbKqQ\session-8c5125fdd266\7b6ed6c2a62b-grep.txt` |
| `dsh-client-modules\README.md` matches for `export\|default\|module face\|apply\|name` | `%TEMP%\dsh-spill-GWbKqQ\session-8c5125fdd266\e109937ffeb2-grep.txt` |
| full `dsh-better-sidebar` `**/*.d.ts` listing (178 paths) | `%TEMP%\dsh-spill-GWbKqQ\session-8c5125fdd266\18b6b31b7569-glob-results.txt` |

These are session-temp files and may be cleaned up; every fact drawn from them is already recorded in
`dsh-plugin-api.md` or above.
