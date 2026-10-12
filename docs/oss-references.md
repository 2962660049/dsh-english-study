# Open-source references for 英语学习小助手

Research date: single session. **Verification method / caveat:** from this environment `github.com`,
`api.github.com` and `raw.githubusercontent.com` were unreachable (DNS resolves to a non-public IP),
and `npmjs.com` returned HTTP 403. Repository facts below therefore come from proxy sources that
**do** serve GitHub metadata (`repos.ecosyste.ms`) and GitHub file content (`cdn.jsdelivr.net/gh/...`),
plus npm/PyPI registry JSON. Star counts and dates are the values in those proxies' snapshots, so
treat them as approximately right rather than live. Anything I could not confirm is marked
`UNVERIFIED`.

---

## 1. wangzhanchao883/dsh-word-vault — **highest priority**

- **Repo:** https://github.com/wangzhanchao883/dsh-word-vault
- **Metadata:** 1 star, 0 forks, 1 open issue, **MIT**, JavaScript, 1.27 MB, created 26 days before the
  snapshot, last push 10 days before the snapshot
  ([repos.ecosyste.ms](https://repos.ecosyste.ms/hosts/GitHub/repositories/wangzhanchao883%2Fdsh-word-vault))
- **Tags:** `v1.0.1`, `v1.0`, `v0.5.3`, `v0.5.2`, `v0.5.0-p5`, `v0.4.0-p4`, `v0.3.0-p3`, `v0.2.0-p2`, `v0.1.0-p1`
- **Topics:** clipboard, deepseek-harness, dsh, dsh-plugin, english, plugin, powershell, quiz, sqlite, study-tool, vocabulary, word-bank
- **Readme verified at:** https://cdn.jsdelivr.net/gh/wangzhanchao883/dsh-word-vault@main/README.md

**What it does:** a DSH plugin providing a **multi-user English vocabulary bank**. Version 1.10.0 adapts to
DSH 0.2+ (tested against `0.2.0-rc.1`/`rc.2`, backwards compatible with 0.1.7); the plugin's
`peerDependencies` upper bound was raised from `<0.2.0-0` to `<0.3.0-0`.

**Three-layer architecture** (directly maps onto the target app's "helper process + host + tool" split):
1. **Resident helper** `scripts/capture.ps1` — PowerShell + WinForms, pure-ASCII source; polls the
   clipboard sequence number, reads text/images, appends to a queue.
2. **Host** `index.mjs` / `capture.mjs` — incremental read of the queue every 250 ms; commits if
   attributed to a user, otherwise tokenizes and writes a "pending pick" prompt; reads a command file
   (`commit`/`dismiss`) and writes a receipt.
3. **Tool layer** `wordvault_*` — callable from chat, independent of the helper process.

**Specifically reusable — the file-based IPC protocol.** Everything is file-based because local
PowerShell pipe return values proved unreliable. Files, with their exact shapes:
- `capture-queue.jsonl` (helper→host): per line `{ts, kind:'text'|'image', text, imagePath, via, user}`
- `capture-prompt.json` (host→helper): `{id, at, wordCount, words[], preview}`
- `capture-commands.jsonl` (helper→host): `{ts, action:'commit'|'dismiss', id, user}`
- `capture-result.json` (host→helper): `{at, ok, message, todayCount, user, kind, id}`
- `capture-status.json` (helper→host): includes `dialog.visible/title`
- `capture-trigger.txt` (host→helper): writing a username means "capture clipboard now"
- `capture-debug.log`; runtime files live in `<dbPath dir>\word-vault-runtime\` and chip position
  persists to `word-vault-runtime\chip-pos.json`

**Specifically reusable — the confirm-before-store UX.** Ctrl+C → helper detects the clipboard change →
host tokenizes (~0.3 s) → popup appears at the mouse position (following the mouse's monitor on
multi-display) listing recognized words plus per-user buttons `[用户1][用户2][忽略]` → the same window
becomes 2.6 s of feedback → 20 s timeout. **Non-storage cases are explicit: nobody clicks, "忽略" is
clicked, or timeout.** An `autoCommit` setting restores plain copy-to-store. This is exactly the
"preview/confirm step before committing words" the target app needs.

**Specifically reusable — the tool surface** (good naming template for the target's own tools):
`wordvault_add`, `wordvault_query`, `wordvault_status`, `wordvault_capture_clipboard`,
`wordvault_fix_last`, `wordvault_make_cards`, `wordvault_export_cards`, `wordvault_exam_start`,
`wordvault_exam_answer`, `wordvault_exam_result`, `wordvault_exam_paper`, `wordvault_scan_photo`,
`wordvault_photo_status`.

**Specifically reusable — hard-won robustness lessons** (these are the highest-value transferable content):
- **Foreign-key delete ordering bug.** Old `deleteWord` deleted only `events + words`, so any word with
  cards or exam history could not be deleted — SQLite raised `FOREIGN KEY constraint failed`. Fix:
  delete in dependency order **`exam_answers → exam_questions → cards → events → words`**, with a
  dedicated regression test. The DB runs `PRAGMA foreign_keys = ON`.
- **Silent LLM failure.** During bulk photo entry, two batches totalling **51 words all lacked
  definitions** because `ctx.llm` threw and the exception was swallowed — which also blocked card
  generation. Fix: `translateWords` batches (default **12 words/request**), retries the words that
  were not returned for one more round, and **logs the failed words**. 46 of the 51 were patched on a
  later pass (dictionary grew 45 → 91).
- **Never make feedback wait on a slow call.** Translation used to run before the DB insert, so the
  popup sat at "处理中…". Now: insert + receipt first, translate after.
- **Config keys:** `autoCommit=false`, `promptTimeoutMs=20000` (0 = wait forever), `showDialog=true`.
- **Why not a global hotkey + simulated Ctrl+C:** modifier keys are scancode side-specific
  (left Ctrl = `0xA2`), a simulated copy must write the clipboard and cross-process OLE clipboard
  writes deadlock (measured 95 s), and injected keys need the target program's message pump.
  Clipboard listening removes all three problems.
- **PowerShell encoding traps:** PS 5.1 reads BOM-less UTF-8 `.ps1` as ANSI/GBK → keep `.ps1` pure
  ASCII and inject Chinese text from a UTF-8 JSON file; `Set-Content`/`Add-Content -Encoding UTF8`
  writes a BOM → use `[System.IO.File]::WriteAllText`/`AppendAllText` with `UTF8Encoding($false)`;
  single-element arrays unwrap on function return; atomic replace via temp file + `Move-Item` needs
  retry on both sides.
- **WinForms dialog traps:** the popup must set `WS_EX_NOACTIVATE` and override `ShowWithoutActivation`
  to avoid stealing focus; multi-monitor placement uses `Screen::FromPoint(Cursor.Position)`; DPI —
  call `SetProcessDPIAware()` **before** creating windows or coordinates are virtualized (a dragged
  window was "flung" to x=1394); drag uses cursor offset with `Capture=$true`.
- **Visual self-check must not guess coordinates** — have the helper report real window rects;
  `test/helper-visual.ps1` uses `CopyFromScreen` and pixel-compares colors.
- **Test discipline worth copying:** 172 Node tests across `test/{words,db,capture,index,cards,exam,photos,translate,web,client}.test.mjs`,
  plus 17 PowerShell clipboard assertions (`test/helper-clipboard.ps1` uses `EnumChildWindows` +
  `SendMessage(BM_CLICK)` for a real click) and 14 visual pixel assertions.

**Other transferable product decisions:**
- **Cards** exported as HTML (A4 paginated, browser-printable), PDF (Edge headless), Word (pandoc →
  `.docx`), plus a PNG first-page preview for layout self-check. Card blocks carry per-word IPA
  (top row real phonetic, bottom row a Chinese homophone + pattern note), 拆词 word-splitting, an
  absurd mnemonic, and a 7th-grade-level example sentence. Old cards lacking example/IPA are
  backfilled incrementally via a `limit`, guarded by a **故事锁 (story lock)** so finalized mnemonics
  are never replaced.
- **TTS:** Windows built-in SAPI voice only — offline, no network or model call; a 🔊 button sits
  next to both the word and the example sentence on cards and quiz pages, prewarmed in the background
  at card/paper generation. PDF/Word have no buttons.
- **Quiz:** EN→CN single choice, sentence containing the word plus the word alone, distractors
  preferred from the same library and same POS; a local web quiz page scores instantly; **3 consecutive
  correct → marked 已学会**, wrong → unlearned; learned words get a 10 % sampling recheck; printable
  exam paper + answer key.
- **Photo channel:** saturated-colour mask + shape criteria locate "marked printed words" on a contact
  sheet (联络图), then the model reads. Real homework photos yielded p1 22 words / p2 23 words. **It
  reads printed text, not handwriting, and emits a contact sheet rather than full transcription.**
- **Data-rollback design:** the repo is a standalone source repo whose purpose is rollback; the DB and
  runtime files live **outside** the repo (`D:\workout\AI助理\英语趣味单词\单词库\`) so rolling back code
  never touches recorded words.
- **DSH platform traps:** `dsh plugin add <path>` only adds a dependency line and does **not** change
  bundles; a link install does not install plugin deps, so the plugin must ship `node_modules`;
  host-shared packages declared as `dependencies` get flagged by the marketplace (use peer + dev);
  the marketplace hot-mounts with a `mkt-` id prefix so the settings namespace mismatches until DSH
  restarts.

**NOT reusable / caveats:** it is PowerShell + Windows-only, and its UI is a WinForms dialog, not a
web UI — only the protocol, data model and lessons transfer. It is very new (1 star, weeks old) and
effectively a single-author project, so treat it as a *design* precedent, not a maintained dependency.
Its lemmatization ("切词/词形还原", incl. `-ing` nouns and a "plural is the entry" whitelist) is
hand-rolled rather than dictionary-backed — ECDICT (below) is the stronger source.

---

## 2. ChanMo/LexiBridge

- **Repo:** https://github.com/ChanMo/LexiBridge
- **Metadata:** 11 stars, 4 forks, 0 open issues, **MIT**, JavaScript, 2.5 MB, created ~3 years before
  the snapshot, **last push 6 days before the snapshot** (actively maintained), tags up to `v1.2.8`
  ([repos.ecosyste.ms](https://repos.ecosyste.ms/hosts/GitHub/repositories/ChanMo%2FLexiBridge))
- **Homepage:** https://chanmo.github.io/LexiBridge/
- An older fan-out copy is indexed at
  [awesome.ecosyste.ms](https://awesome.ecosyste.ms/projects/github.com%2FChanMo%2FLexiBridge) (stale:
  it still reports 6 stars / last push 2025-03-01, size 2.39 MB) — do not trust that snapshot.

**What it does:** 开源、无服务器的英语学习应用 — an open-source **serverless** English-learning app
shipped as a browser extension. It automatically marks unknown words on web pages and offers Chinese or
English definitions, backed by a **local vocabulary bank**.

**Specifically reusable:**
- The **no-backend architecture**: the whole app is client-side, so the vocabulary bank lives with the
  user — the same shape as the target app's "IndexedDB cache + sync" requirement, minus the sync.
- The stated roadmap is a checklist of exactly the features the target app also needs, in the author's
  own priority order: `[ ] CSV import/export support`, `[ ] more highlight styles`,
  `[ ] word-bank one-click switching`, with `[X] search and pagination`, `[X] use Material/web`,
  `[X] options page optimization`, `[X] use Highlight instead of span tags`,
  `[X] add delete-word in popup` already done.
- **"use Highlight instead of span tags"** is a directly transferable DOM decision for the target's
  clickable-token rendering: wrapping tokens in custom `<span>`s breaks page styling; the CSS Custom
  Highlight API does not.
- The **popup + options page** split is a reasonable template for the target's word-detail card vs.
  settings/bank-management screens.
- Topics: chrome-extension, dictionary, language-learning, learning.

**NOT reusable:** it is a Chrome extension, not a web app — its storage and permission model
(`chrome.storage`, content scripts) does not transfer to a browser-hosted SPA. It has no OCR, no
photo/diary channel, no TTS pipeline, no sentence-alignment or bilingual parallel-text model, and no
adapter pattern. Its exact internal storage mechanism was **UNVERIFIED** (the `README.org` content type
could not be fetched by this environment's fetcher). At 11 stars it is a small single-author project.

---

## 3. Ongiei/obsidian-lexibridge

- **Repo:** https://github.com/Ongiei/obsidian-lexibridge
- **Metadata:** 3 stars, 0 forks, 0 open issues, **0BSD** license, TypeScript, 24.8 MB, created
  9 months before the snapshot, last push 3 months before the snapshot
  ([repos.ecosyste.ms](https://repos.ecosyste.ms/hosts/GitHub/repositories/Ongiei%2Fobsidian-lexibridge))
- Tags are mixed: `0.3.10`–`0.3.19` alongside `3.0.1`, `3.0.2`, `2.0.0`, `1.0.x`
- **Readme verified at:** https://cdn.jsdelivr.net/gh/Ongiei/obsidian-lexibridge@master/README.md

**What it does (from its own README):** "Local-first dictionary tools for Obsidian, with offline
English-Chinese definitions, optional online enrichment, safe vocabulary-note linking, wordbook
synchronization, and one-way Anki export." Requires Obsidian 1.8.7+; still 0.x, data structures may
change.

**Specifically reusable — this is the strongest *web*-stack precedent in the whole list:**
- **ECDICT shipped into IndexedDB.** Its default definition source is **ECDICT**: it downloads
  `ecdict.csv` from [skywind3000/ECDICT](https://github.com/skywind3000/ECDICT), converts locally, and
  **imports it into IndexedDB — the dictionary data is deliberately NOT written into the vault.** That
  is precisely the target app's "IndexedDB cache + offline" design, already proven against the same
  dictionary.
- **Multi-mirror dataset download with integrity gating.** Settings can test/select download endpoints:
  GitHub, ghproxy.net, gh-proxy.com, jsDelivr, Statically. Installs pin an **upstream commit** and
  validate the downloaded file, the imported entry count, and representative entries **before**
  replacing the active DB; a failed update leaves the existing DB usable. Copy this wholesale for the
  target's dictionary download.
- **Lemmatization via `wink-lemmatizer`** (MIT): "Resolve inflected words to lemma notes while
  preserving proper capitalization and aliases."
- **Note templates with protected user sections.** Vocabulary notes come from editable Markdown +
  frontmatter templates, and user content below protected headings (e.g. `## Notes`) is retained by
  heading level on refresh — a clean way to regenerate annotation detail without destroying user edits.
- **Non-destructive virtual links**: highlighting that does not modify Markdown, inherits the
  surrounding text colour, renders only in the foreground window and only in the note body in Reading
  view/Live Preview; a hover delay prevents accidental previews; configurable click action; and an
  option to convert matching occurrences to real links.
- **Exactly the throttling policy the target app needs.** Youdao enrichment is optional,
  user-initiated, one word at a time: *"Requests are serialized, use randomized spacing and limited
  retries, and pause after HTTP 403 or 429 responses."* Endpoint: `dict.youdao.com/jsonapi`.
- **Wordbook sync with a divergence-safe merge.** Each remote wordbook maps to a subfolder; one word can
  belong to multiple wordbooks; remote renames update local folders. Deletion, a missing baseline, or
  divergence after long inactivity **pauses** auto-sync. Manual sync shows the full difference list and
  offers three alignment strategies — *"Preserve both sides"* (restore missing, never delete),
  *"Local wins"* (upload local, remove remote-absent-locally), *"Cloud wins"* (download remote, move
  unmatched local files to trash). Destructive plans are subject to a configured deletion limit; sync
  history is bounded; recorded local deletions can be restored; long operations take checkpoints.
- **Anki export that preserves review history.** One-way: the app is the source of card content, Anki
  owns scheduling. It creates/updates a `LexiBridge Vocabulary` note type and identifies managed notes
  via a stable `LexiBridgeId` field. Crucially: *"Updates use AnkiConnect field updates instead of
  deleting and recreating notes, preserving note IDs, card IDs, and review history."* Full export starts
  with a read-only preview; missing Markdown sources leave Anki notes unchanged by default; a zero-source
  scan refuses destructive actions; and it **never writes Anki IDs back into Markdown**.
  AnkiConnect default endpoint `http://127.0.0.1:8765`.
- Commands worth mirroring: query selected or cursor word, create a lemma note, automatically link
  current document/section/selection, inspect and remove vocabulary links, discover missing vocabulary
  notes, migrate legacy notes with ECDICT, synchronize wordbooks, test AnkiConnect connection,
  synchronize notes to Anki.
- **Privacy posture:** no telemetry; the Eudic token is stored as plain text in plugin `data.json`;
  vault access is limited to the configured folder. Dev loop: `npm ci`, `npm test`, `npm run lint`,
  `npm run check:community`, plus `npm run test:anki-manual` for real AnkiConnect acceptance. Install
  via BRAT `Ongiei/obsidian-lexibridge` or by copying `main.js`/`manifest.json`/`styles.css` into
  `<vault>/.obsidian/plugins/lexibridge/`.

**NOT reusable:** it is an Obsidian plugin, so the vault/`data.json`/BRAT shell and the Markdown-note
data model do not transfer to a standalone web app — only the *strategies* above do. It is 0.x with
3 stars and warns that data structures may change. Its Eudic sync depends on Eudic's official Open API
(a hosted service with a token). **0BSD** is maximally permissive, so license is not a problem.

---

## 4. lingkuma/LingKuma

- **Repo:** https://github.com/lingkuma/LingKuma
- **Metadata:** 70 stars, 3 forks, 3 watchers, 5 open issues, **MIT** (`LICENSE.txt`), JavaScript,
  56.8 MB, created 2025-03-16, last push 2026-03-18
  ([repos.ecosyste.ms](https://repos.ecosyste.ms/hosts/GitHub/repositories/lingkuma%2FLingKuma))
- **Homepage:** https://lingkuma.org · **Wiki:** https://docs.lingkuma.org
- **Readme verified at:** https://cdn.jsdelivr.net/gh/lingkuma/LingKuma@main/README.md

**What it does:** "Lingkuma — An open-source alternative to LingQ for learning any language on the
web." Its own tagline: *"Highlight, translate, analyse and listen to the words and sentences you meet
every day."* Built with OpenAI Codex. Ships extensions for Chrome/Edge/Firefox plus iOS/Android.
Independent ports exist: `white-ink-cell/lingkuma-calibre`, `white-ink-cell/lingkuma-zotero`.
A `server/` readme covers Docker deployment.

**Specifically reusable — this is the closest match to the target's *reading* half:**
- **Multi-word colour-state annotation** (unfamiliar = blue, familiar = yellow) is the same
  learning-status-as-visual-state model the target needs for its vocabulary flags.
- **"Sentence Explosion"** — query several new words at once and get a full-sentence AI translation in
  the same action. That is exactly the target's "web-text → correct-then-translate preview → clickable
  word tokens → confirm-to-add" flow, already designed.
- **AI example analysis + Word Notes + AI Recommended Notes + Example Records** (save important
  sentences and review them later) — a ready-made feature list for the target's vocabulary-bank detail
  panel (source sentence, its translation, example sentences).
- **Pluggable TTS**: a custom TTS URL entry alongside built-in Edge TTS and Minimax TTS. Directly
  transferable to the target's adapter pattern — TTS should be an adapter with a URL-based provider,
  not a hard-coded engine.
- **Sync via WebDAV or a free self-hosted Docker sync server** — the concrete answer to the target's
  "IndexedDB cache + sync" requirement without renting infrastructure.
- **Broad reading-surface coverage** worth imitating: browser extensions, mobile, Readest and other
  EPUB web readers, the Mozilla PDF reader, YouTube subtitle enhancement (hide/show, AI repair of
  unpunctuated English subtitles, Trancy compatibility), Bionic Reading, SimpRead mode, a Liquid Glass
  popup.
- The **Zotero/Calibre ports** show the reading layer was factored cleanly enough to re-host — a sign
  the architecture separates content ingestion from annotation.

**NOT reusable:** its UI is largely a *browser-extension overlay* experience, whereas the target is a
self-contained web app with its own pages; the extension host API and its site-injection machinery do
not transfer. It is a LingQ-clone reading tool — **no OCR, no photo/diary channel, no sentence-aligned
bilingual parallel text, no Anki export, and no LLM adapter abstraction** (multiple AI features exist,
but an adapter layer was not verified). 70 stars, single-digit contributors, and a 56.8 MB repo
suggest a heavy vendored/bundled history.

---

## 5. BlueSea — repo identity resolved

- **Canonical repo:** **https://github.com/jiangqizheng/BlueSea** — *not* `CrystalYixn/BlueSea`
- **Metadata:** 1,193 stars, 114 forks, 36 open issues, **License: None**, JavaScript, 7.74 MB, created
  ~6 years before the snapshot, last push ~4 years before the snapshot; tag `v20200103`
  ([repos.ecosyste.ms](https://repos.ecosyste.ms/hosts/GitHub/repositories/jiangqizheng%2FBlueSea))
- `CrystalYixn/BlueSea` is a **fork** of it: 0 stars, no license, created ~5 years ago, pushed 7 months
  before the snapshot — much smaller, so the canonical repo is the original.
- **Readme verified at:** https://raw.githubusercontent.com/jiangqizheng/BlueSea/master/README.md

**What it does:** 英语学习扩展程序 (an English-learning browser extension) with 划词翻译
(select-to-translate), 单词高亮, 单词弹幕 (word barrage/danmaku), 记忆曲线复习 (forgetting-curve review)
and 词频统计 (word-frequency stats). It offers page word-selection translation + pronunciation, a local
word bank, word frequency (total / daily / per-page), precise global word highlighting, review via
danmaku

**Specifically reusable:**
- **Its forgetting-curve schedule is a concrete, directly copyable default** — the config ships
  `[5, 30, 12*60, 24*60, 2*24*60, 4*24*60, 7*24*60, 15*24*60, 30*24*60]` minutes (5 min, 30 min, 12 h,
  1 d, 2 d, 4 d, 7 d, 15 d, 30 d). Each word carries a `level` field that increments by 1 on success or
  **resets to 0** on failure, and the next review time is derived from the level. For a
  learning-status-flag vocabulary bank this is a lighter alternative to full FSRS.
- **Its config JSON is a ready-made settings schema** for a vocab overlay, including an explicit
  `黑名单` (blacklist), `中文注解`, `划词默认发音`, `单词弹幕数量上限=10`, `单词弹幕速度=10`, and
  `隐藏完成复习的单词` — the last one being a nice touch the target lacks.
- **Word-frequency stats** (total, daily, per-page) is a cheap, high-value dashboard for the target's
  vocabulary bank.
- **Danmaku review** is an unusual but genuinely reusable idea: review due words as floating overlays on
  whatever page you are reading, with pronunciation, instead of a separate review screen. The README
  notes card review only appears when danmaku is off, to avoid two review surfaces at once.
- **Recorded scale/limits**, useful as a sanity bar: tested with 100+ words highlighted per page and
  5,000+ words in the bank; import/export as `.json` and `.txt`.
- Translation via the Youdao 智云 API (sentence translation is quota-limited; word/phrase lookups of
  fewer than 4 words work without a key) — a reminder to keep a keyless local dictionary as the first
  tier, which the target already plans.

**NOT reusable — blocking:** **there is no license file**, so the code is all-rights-reserved by default
and **must not be copied**; only the ideas (schedule, config shape, feature list) can be borrowed.
Additionally the project is **~4 years stale**, and its architecture is a Manifest-V2-era browser
extension with global page injection — the opposite of the target's closed, self-contained web app.

---

## 6. ReadLoops — repo identity resolved (a close analogue, not a reading app)

- **Canonical repo:** **https://github.com/pekoqq/ReadLoops** (PyPI owner is `Fangyuan2711`)
- **Package:** `readloops` — https://pypi.org/project/readloops/ · version **2.6.3**, uploaded
  2026-09-16, **MIT**, Python `>=3.10`
  (https://pypi.org/pypi/readloops/json)
- **Homepage / Repository:** https://github.com/pekoqq/ReadLoops · Issue tracker:
  https://github.com/pekoqq/ReadLoops/issues · Changelog:
  https://github.com/pekoqq/ReadLoops/blob/main/docs/CHANGELOG.md
- GitHub stars **UNVERIFIED** (github.com unreachable; the repo is not indexed by the proxy I used).

**What it is:** 自述 `AI 驱动的英语阅读训练器：可理解输入 + FSRS 间隔重复` — an AI-driven English reading
trainer built on comprehensible input (i+1) plus reading-driven FSRS spaced repetition, targeting CET-4
(and CET-6). Its framing is precisely the target app's thesis: *"背单词软件的问题是「脱离语境」…
先读文章，在语境里反复遇见生词"* — spaced-repetition vocabulary software fails because it is divorced
from context, so you should meet words repeatedly in context first. **This is the closest product
analogue found.**

**Tech stack (self-declared, deliberately minimal):** FastAPI + **SQLite with no ORM** (raw `sqlite3`);
frontend is a **native HTML/CSS/JS SPA with zero build and zero dependencies**; AI is DeepSeek
(`deepseek-flash`) with thinking mode forcibly disabled; the FSRS implementation is self-written in
`app/services/srs.py` and the TF-IDF cosine similarity in `app/services/similarity.py`. Stated design
rule: *"后端零 ORM、前端零框架、算法零第三方依赖"*.

**Specifically reusable:**
- **Filesystem + schema layout to mirror.** `app/{cli,main,config,database}.py`, `models.py`,
  `api/{articles,words,reading,stats}`, `services/{ai,srs,similarity,smart_test,scheduler,level,corpus}.py`,
  `web/` (PWA), `tools/`, `skills/`, `tests/`, `docs/`. **The DB schema is 10 tables, defined in
  `app/database.py`.**
- **The AI adapter pattern, already proven for this app class.** The default provider is DeepSeek and
  everything is driven by `AI_BASE_URL` (default `https://api.deepseek.com`), `AI_API_KEY` and
  `AI_MODEL` (default `deepseek-flash`) — i.e. an OpenAI-compatible base-URL swap is sufficient to
  change LLM. The target app's Doubao-behind-an-adapter requirement has a working precedent here, and
  the variable trio is a good settings contract.
- **The lookup-to-vocabulary promotion ladder:** *1 lookup → record, 2 → mark, 3 → auto-add to the
  vocabulary book.* An elegant, low-friction alternative to explicit "add" clicks, worth offering
  alongside the target's confirm-to-add.
- **Its word-list import contract names exactly the fields the target needs:**
  `lemma / text / meaning / phonetic / level`, with `app/services/corpus.py : import_word_list(filepath, level)`
  parsing plain-text lines in the format `word [音标] 词性.释义`. It explicitly recommends **ECDICT**
  as the open dictionary and notes the repo ships **no** dictionary or corpus data for copyright
  reasons.
- **Other reusable features:** controlled-vocabulary article generation (6–15 new words per article,
  TF-IDF similarity dedup), highlight marking that **auto-restores after re-render**, focus mode,
  smart vocabulary tests, reading stats (overview cards, vocabulary distribution, lookup hot words,
  a GitHub-style heatmap), PWA install, four themes (dark/light/paper-eye-care/pure black).
- **Cross-platform data-dir convention worth copying:** source mode `<project root>/data`; pip on
  Windows `%LOCALAPPDATA%\ReadLoops`; macOS `~/Library/Application Support/ReadLoops`; Linux
  `~/.local/share/readloops`; overridable with `READLOOPS_DATA_DIR` / `READLOOPS_DB_PATH`. Its stated
  guarantee — the DB is never written into `site-packages`, so upgrading or uninstalling the package
  never touches user data — is a good rule for the target's own storage.
- **Ops ergonomics:** CLI `readloops serve|init|doctor` with `--port/--host/--no-browser`, binding
  `127.0.0.1` by default, Docker `docker compose up -d` with a `readloops-data` volume. Note the README
  warns there is **no password protection** when binding `0.0.0.0` — so the target must not copy the
  multi-device exposure recipe naively.

**NOT reusable:** it is a **Python/FastAPI** application, so no Node/TypeScript code transfers — only
the schema ideas, feature design and config contract. It has **no OCR and no photo/diary channel**, no
sentence-aligned bilingual parallel text, no TTS, no Anki export, and no explicit IndexedDB/offline
story (SQLite server-side instead). It is a young single-author project (versions 2.3.0 → 2.6.3 all
within days of each other), and its README says it is for personal study use and that AI-generated
content should be independently judged.

---

## 7. The `doubao-free-api` family — be careful, all are reverse-engineered

### 7a. LLM-Red-Team/doubao-free-api (the flagship of the family)

- **Repo:** https://github.com/LLM-Red-Team/doubao-free-api
- **Metadata:** TypeScript, an estimated **687 stars** per
  [repoportal](https://www.repoportal.com/en/llm-red-team-doubao-free-api). Not indexed by
  repos.ecosyste.ms (404), and no `LICENSE` or `package.json` was retrievable at the `main`/`master`
  paths via jsDelivr (both 404) → **license UNVERIFIED**, and stars/recency are **UNVERIFIED** beyond
  the single third-party figure above.

**What it actually exposes** (from its README):
- An **OpenAI-compatible** `POST /v1/chat/completions` with `"model": "doubao"` and
  `Authorization: Bearer <sessionid>`; optional `conversation_id` for native multi-turn; `stream: true`
  for SSE.
- `POST /token/check` → `{"live": true}`, with the warning not to call it more often than every 10 min.
- **Auth is a Doubao *website* session cookie**, not an API key: copy `sessionid` from browser devtools
  (Application → Cookies). Multi-account = comma-joined `sessionid1,sessionid2,sessionid3`.
- Deployment: Docker image `vinlic/doubao-free-api:latest` on port 8000, docker-compose, Render, Vercel
  (the 10 s free-tier timeout risks 504s), or native Node + pm2 `dist/index.js`. It ships an Nginx SSE
  tuning snippet (`proxy_buffering off`, `chunked_transfer_encoding on`, `tcp_nopush`/`tcp_nodelay on`,
  `keepalive_timeout 120`).
- Token statistics are fake/fixed, because inference is not local.

**Why it must not be used — its own README, verbatim:**
> "**逆向API是不稳定的，建议前往火山引擎官方 https://www.volcengine.com/product/doubao 付费使用API，避免封禁的风险。**"
> "**仅限自用，禁止对外提供服务或商用，避免对官方造成服务压力，否则风险自担！**" (stated three times)
> "**本组织和个人不接受任何资金捐助和交易，此项目是纯粹研究交流学习性质！**"

And decisively for this project: its capability list marks 支持图像解析 as 「计划支持」 — **vision/OCR is
planned, not supported**, so it cannot serve the diary-photo OCR path at all.

### 7b. 1994qrq/2025doubao-free-api

- **Repo:** https://github.com/1994qrq/2025doubao-free-api
- **Metadata:** 5 stars, 1 fork, 0 open issues, **GPL-3.0**, TypeScript, 385 KB, created/updated/pushed
  **11 months** before the snapshot (stale)
  ([repos.ecosyste.ms](https://repos.ecosyste.ms/hosts/GitHub/repositories/1994qrq%2F2025doubao-free-api))
- DeepWiki pages exist: https://deepwiki.com/1994qrq/2025doubao-free-api/2-getting-started and
  https://deepwiki.com/1994qrq/2025doubao-free-api/7-development-guide
- **GPL-3.0 is a copyleft blocker** for a closed/proprietary app, on top of the reverse-engineering
  problems above.

### 7c. joeye88/doubao-free-api

- **Repo:** https://github.com/joeye88/doubao-free-api exists, but its `master` `README.md` is
  byte-for-byte the LLM-Red-Team README → it is a **fork/repost, not an independent project**.
  Not indexed by repos.ecosyste.ms (404); stars, license and last-commit **UNVERIFIED**.

### 7d. 5201213/doubao-free-api

- **Repo:** https://github.com/5201213/doubao-free-api appears in search results and is described as
  「豆包(Doubao)免费API服务 — 将豆包桌面客户端包装为OpenAI兼容API，支持流式响应、Vision图片识别、
  思考/编程/写作/翻译/解题等特殊模式」 — i.e. it claims to wrap the **Doubao desktop client** and to
  support **Vision image recognition**.
- It is **not indexed** by repos.ecosyste.ms, so stars, license and last-commit are **UNVERIFIED**, and
  the Vision claim is **UNVERIFIED**. If the claim were true this is the only free-api in the family
  that could plausibly do OCR — but a desktop-client-wrapping design is unusable from a web app.

### 7e. Family context

LLM-Red-Team also maintains `kimi-free-api`, `step-free-api`, `qwen-free-api`, `glm-free-api`,
`metaso-free-api`, `spark-free-api`, `hailuo-free-api`, `deepseek-free-api`, `emohaa-free-api` and
`jimeng-free-api`; there is also a `linuxhsj/doubao-free-api` fork. The whole family shares the same
"reverse-engineered, personal-use-only, may be banned" posture.

**Verdict: not reusable as a dependency.** Every variant is an unstable reverse-engineered wrapper that
gets accounts banned, forbids commercial/对外 use, offers no OCR you can rely on, and in one case is
GPL-3.0. The legitimate equivalent is the official Ark API below.

---

## 8. Official Volcengine Ark / Doubao — the correct Doubao integration path

### 8a. Node SDK: `@volcengine/ark-runtime`

- **npm:** https://www.npmjs.com/package/@volcengine/ark-runtime ·
  https://registry.npmjs.org/@volcengine/ark-runtime ·
  README: https://cdn.jsdelivr.net/npm/@volcengine/ark-runtime/README.md
- **Version:** `latest` = **1.0.11** at fetch time · **License: Apache-2.0** (from registry version
  metadata) · install with `npm install @volcengine/ark-runtime`

**Minimal call example (from its README):**
```ts
import { ArkRuntimeClient } from "@volcengine/ark-runtime";

const client = new ArkRuntimeClient({ apiKey: process.env.ARK_API_KEY || "your-api-key" });

const resp = await client.createChatCompletion({
  model: "doubao-seed-2-0-pro-260215",
  messages: [{ role: "user", content: "2+3=?" }],
});

// streaming
const stream = await client.createChatCompletionStream({
  model: "doubao-seed-2-0-pro-260215",
  messages: [/* ... */],
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0].delta.content || "");

// image generation
const img = await client.createImage({
  model: "doubao-seedream-5-0-260128",
  prompt: "...",
  n: 1,
  size: "1024x1024",
});
```

**Capability table (self-declared):** 聊天补全 ✅ (non-stream + stream), **多模态对话 ✅ 支持图片输入**,
函数调用 ✅ (tool calling, web search), 嵌入向量 ✅ (text + multimodal embedding), 图像生成 ✅,
视频生成 ✅, 内容生成 ✅, 批处理 ✅, 文件管理 ✅, Bot 对话 ✅, 上下文对话 ✅. Errors are typed:
`ArkAPIError` with `.message`, `.requestId`, `.httpStatusCode`, plus `ArkRequestError`. It provides a
built-in connection pool, **automatic retry and timeout control**, and is stated to be 100 % API
compatible with the Go SDK. Env convention: `ARK_API_KEY`.

**This is the answer to the OCR requirement:** Ark multimodal chat accepts image input, so "photograph a
diary page → OCR + translate" is one vision call, not a separate OCR service. Official docs:
[图片理解 — 火山方舟](https://ai.volcengine.com/docs/ark-aihub/2646937?lang=zh) and
[多模态理解](https://docs.volcengine.com/docs/ark/multimodal-understanding?lang=zh). Also relevant if a
dedicated OCR is preferred: [提交图像文字识别（OCR）任务 API](https://docs.volcengine.com/docs/Intelligentprocessing/submit-image-text-recognition-ocr-task-api?lang=zh)
and, for a real-world integration example, [pot-desktop: "fix: Can't use Volcengine OCR"](https://github.com/pot-app/pot-desktop/commit/79e153f0ded7743a4379214d1355139d9fe212f8).

- **Official product page:** https://www.volcengine.com/product/doubao — this is the sanctioned paid
  alternative that the reverse-engineered projects themselves tell users to move to.
- A dedicated **Node** OCR/visual SDK package name was **UNVERIFIED** — search surfaced the *Python*
  SDK ([`volcengine/volc-sdk-python` `VisualService.py`](https://raw.githubusercontent.com/volcengine/volc-sdk-python/master/volcengine/visual/VisualService.py),
  [Visual Processing docs](https://deepwiki.com/volcengine/volc-sdk-python/8-visual-processing)) and a
  Go SDK (`github.com/volcengine/volc-sdk-golang`), but no confirmed npm equivalent. Prefer
  `@volcengine/ark-runtime` multimodal chat instead.
- Also **UNVERIFIED:** whether Ark's OpenAI-compatible base URL
  (`https://ark.cn-beijing.volces.com/api/v3`) is officially documented — the Volcengine docs pages were
  not fetchable from this environment. Confirm against the Ark docs before relying on a plain
  OpenAI-SDK base-URL swap.

### 8b. Architectural implication for the target app

The Ark SDK's own text (`client.createChatCompletion`, `client.createChatCompletionStream`) is a
near-OpenAI shape, so the target's **adapter** should expose `chat({messages, images})` and
`chatStream(...)` as the single seam, with an **Ark adapter** and a generic OpenAI-compatible adapter as
the two implementations. Doubao being "the default LLM behind an adapter" is well supported.

---

## 9. Vocabulary data & NLP libraries (Node)

### 9a. ECDICT — the single highest-value data dependency ⭐

- **Repo:** https://github.com/skywind3000/ECDICT
- **Metadata:** **8,381 stars**, 1,359 forks, 84 open issues, **MIT**, Python, 98.9 MB, created over
  9 years before the snapshot, last push over 1 year ago, repo updated 7 days before the snapshot;
  tags `1.0.28`, `1.0.27`; 6 contributors
  ([repos.ecosyste.ms](https://repos.ecosyste.ms/hosts/GitHub/repositories/skywind3000%2FECDICT))
- **README verified at:** https://cdn.jsdelivr.net/gh/skywind3000/ECDICT@1.0.28/README.md

**What it is:** "Free English to Chinese Dictionary Database" — a 英汉双解 (bilingual) dictionary of
hundreds of thousands of words, annotated against Chinese exam syllabi and corpus frequencies. The
current `ecdict.csv` in the repo is a **base version of 76万 (760,000) entries**; the full data is
distributed compressed as `stardict.7z`; the 1.0.14 release had 222万 entries. UTF-8 CSV.

**Exact column set (verbatim from the README):**

| field | meaning |
|---|---|
| `word` | 单词名称 |
| `phonetic` | 音标 (IPA-style phonetic, predominantly British) |
| `definition` | English definitions, one per line |
| `translation` | Chinese definitions, one per line |
| `pos` | part-of-speech distribution, `/`-separated, e.g. `n:46/v:54` |
| `collins` | Collins star rating |
| `oxford` | whether it is an Oxford-3000 core word |
| `tag` | space-separated exam tags: `zk`/中考, `gk`/高考, `cet4`/四级, … |
| `bnc` | British National Corpus frequency rank |
| `frq` | contemporary-corpus frequency rank |
| `exchange` | inflections (tense/plural/comparative) — see below |
| `detail` | JSON extension blob, meant for example sentences (README says 待添加) |
| `audio` | pronunciation audio URL — README says 待添加 (**not populated**) |

**The `exchange` field is the feature that makes this library decisive for the target app.** Format is
`type:word/type:word`. Worked example from the README — `perceive` has
`exchange = d:perceived/p:perceived/3:perceives/i:perceiving`, i.e. its past participle (`d`) is
`perceived`, past tense (`p`) is `perceived`, present participle (`i`) is `perceiving`, third-person
singular (`3`) is `perceives`. The full type table:

| type | meaning |
|---|---|
| `p` | 过去式 (past tense, "did") |
| `d` | 过去分词 (past participle, "done") |
| `i` | 现在分词 (present participle, "doing") |
| `3` | 第三人称单数 ("does") |
| `r` | 形容词比较级 (`-er`) |
| `t` | 形容词最高级 (`-est`) |
| `s` | 名词复数 |
| `0` | Lemma — e.g. `perceived`'s lemma is `perceive` |
| `1` | the lemma's transformation types, e.g. `s` marks `apples` as a plural of its lemma |

These were generated from the BNC corpus with NodeBox/WordNet, and the README highlights the `exchange`
field as 「本词典一大特色之一」.

**Also shipped: a lemma database, which is better than any rule-based lemmatizer.**
`lemma.en.txt` was produced by scanning all 100 million words of the BNC; stardict.py's `LemmaDB` class
loads it. README claim: it covers BNC inflections and 「95%的情况下你可以查到你想要的」. Example:
`['gave', 'taken', 'looked', 'teeth']` → `['give', 'take', 'look', 'tooth']`; it can also enumerate a
lemma's variants. The README's guidance is explicit: **database lookup first, suffix rules
(`-ed`, `-ing`) only as a fallback** — 「最可靠的是数据库，算法次之」 (the most reliable is the database,
algorithms second). This is a direct, expert-endorsed answer to the target's lemmatization question.

**Tooling shipped:** `stardict.py` (Python 2/3 compatible) with three interchangeable classes —
`DictCsv` (reads/writes `ecdict.csv`), `StarDict` (SQLite dictionary file), `DictMySQL` — all exposing
the same interface: `query`, `match`, `query_batch`, `count`, `register`, `update`, `remove`, `commit`;
plus converters between csv / SQLite / MySQL, and exporters to StarDict and mdict `.mdx` source.
`stardict.tools` adds dictionary diffing/merging helpers. `linguist.py` wraps some WordNet/NodeBox.

**A hidden fuzzy-match field worth copying.** A computed `sw` ("strip-word") column stores
`stripword(word) = (''.join([n for n in word if n.isalnum()])).lower()` — so `match(..., True)` finds
`long-time`, `longtime`, `long time`, `long-time base` alike. The README's rationale: a phrase gradually
loses its hyphen over time, so exact-match misses legitimate variants. This is a cheap win for the
target's word lookup.

**Reusable for the target app, concretely:** it supplies, in one 76万-entry file, nearly the entire
vocabulary-annotation payload the spec asks for — **lemma** (`exchange` type `0`), **Chinese gloss**
(`translation`), **inflections** (all of `p/d/i/3/r/t/s`), **IPA** (`phonetic`), plus two extras the
spec does not even require: part-of-speech distribution (`pos`), Collins star rating, Oxford-3000 flag,
exam-syllabus tags (`cet4`/`gk`/…) and two corpus frequency ranks (`bnc`, `frq`). Those extras are a
free difficulty-levelling signal for the learning-status flags and for choosing example sentences.
It is **MIT**, so bundling or converting it is fine.

**Caveats — this is what you must NOT expect from ECDICT:**
- **No TTS.** The `audio` field exists but is documented as 待添加, so pronunciation audio must come from
  the target app's own TTS adapter.
- **No example sentences.** `detail` is described as a JSON extension blob 「待添加」 — example sentences
  must come from the LLM or the user's own source sentences (which the target already captures).
- The `sentence`-level context the spec needs is inherently absent — ECDICT is a word-level resource.
- It is a **99 MB data repo in Python**, last pushed over a year ago; it is a data asset, not a live
  library. Budget for a one-time download + local conversion (and note both LexiBridge and ReadLoops do
  exactly this).

### 9b. wink-lemmatizer — inflected → base (analysis)

- **Repo / npm:** https://github.com/winkjs/wink-lemmatizer · https://www.npmjs.com/package/wink-lemmatizer
- **Metadata:** v3.0.4, latest release **Jun 4, 2023**, **MIT**, **66 stars**, 6 forks, 2 contributors,
  2 dependencies ([libraries.io](https://libraries.io/npm/wink-lemmatizer))
- **API (zero config):** `require('wink-lemmatizer')` then `lemmatize.adjective('farthest') // 'far'`,
  `lemmatize.noun('knives') // 'knife'`, `lemmatize.verb('eaten') // 'eat'`,
  `lemmatize.verb('suggesting') // 'suggest'`.
- **Reusable:** a tiny, MIT, dependency-light lemmatizer that is **proven in this exact application
  class** — obsidian-lexibridge uses it for lemma resolution. Use it as the *fallback* when a word is
  not in ECDICT's `lemma.en.txt`.
- **NOT reusable for:** generating inflections (it only reduces inflected → base), and it is not
  Chinese-aware. Last release 2023, so it is stable-but-frozen.

### 9c. en-inflectors — base → inflections (generation)

- **Repo / npm:** https://github.com/finnlp/en-inflectors (homepage per its npm metadata; a mirror/repo
  copy also appears at https://github.com/kswedberg/en-inflectors) ·
  https://www.npmjs.com/package/en-inflectors
- **Metadata:** v1.0.12, **MIT**, TypeScript; releases end **Mar 2017** — effectively unmaintained, but
  it is rule-based with an exceptions list and has no runtime dependencies
  ([libraries.io](https://libraries.io/npm/en-inflectors))
- **API:** `const Inflectors = require("en-inflectors").Inflectors;`
  `new Inflectors("big").comparative() // bigger` · `.superlative() // biggest` ·
  `new Inflectors("fly").conjugate("VBD") // flew` · `new Inflectors("throw").conjugate("VBN") // thrown` ·
  `new Inflectors("rally").conjugate("VBS") // rallies` · `new Inflectors("die").conjugate("VBP") // dying`
  — note the `VBP` example yields a gerund, so Penn Treebank tag semantics here need care. Aliases:
  `.toPresent()`, `.toPast()`, `.toPastParticiple()`, `.toPresentS()`, `.toGerund()`; nouns also get
  `.isCountable()` and plural↔singular. Tags used: `VBP/VBD/VBN/VBS`. Demo: http://en-inflectors.surge.sh/
- **Reusable:** **this is the inflection *generator*** — the exact need in the target's
  "inflections" vocabulary field (past tense / past participle / plural / comparative). README notes it
  combines "a set of rules … in combination with an exceptions list".
- **NOT reusable / caveat:** dead since 2017 (a small, frozen rule set with known irregular-verb gaps),
  and it is the *inverse* direction from wink-lemmatizer. **For the target app, prefer ECDICT's
  `exchange` field as the primary source and keep en-inflectors only as a fallback for words ECDICT
  lacks** — ECDICT's forms were corpus-validated, whereas this is rule-plus-exceptions.

### 9d. IPA phonetics

- **cmu-pronouncing-dictionary** — https://github.com/words/cmu-pronouncing-dictionary ·
  https://www.npmjs.com/package/cmu-pronouncing-dictionary · v3.0.0 (latest release **Jul 13, 2021**),
  **ISC**, 77 stars, 13 forks, **0 dependencies**, 6 releases, repo size 2.72 MB, originates from
  https://github.com/cmusphinx/cmudict (CMU Pronouncing Dictionary, public domain)
  ([libraries.io](https://libraries.io/npm/cmu-pronouncing-dictionary)).
  **ESM-only, Node 12+**: `import { dictionary } from 'cmu-pronouncing-dictionary'`. 134,000+ words to
  **ARPABET**, not IPA — `{ a: 'AH0', aachen: 'AA1 K AH0 N' }`; alternate pronunciations are keyed
  `word(2)`, `word(3)`, …
  **Blocker:** the target spec stores **IPA**, and this gives ARPABET, so it needs an ARPAbet→IPA
  conversion — **no converter library was verified in this session (UNVERIFIED)**. North-American
  pronunciations only.
- **ipa-dict** — https://github.com/open-dict-data/ipa-dict · **642 stars**, 95 forks, 34 open issues,
  **MIT**, no primary language (data repo), 36.9 MB, created ~10 years ago, pushed over 1 year ago
  ([repos.ecosyste.ms](https://repos.ecosyste.ms/hosts/GitHub/repositories/open-dict-data%2Fipa-dict)).
  "Monolingual wordlists with pronunciation information in **IPA**" — topics include ipa, ipa-data,
  ipa-dictionary, phonemic-transcription, grapheme-to-phoneme, g2p, wordlist. **This is the direct IPA
  source and avoids the ARPABET conversion problem entirely.**
- **Practical recommendation:** take IPA from **ECDICT's `phonetic` field** (already in the same file as
  the gloss and inflections) as the primary, and use **ipa-dict** to fill gaps. Keep
  cmu-pronouncing-dictionary in reserve only for stress-pattern or syllable work where ARPABET's
  explicit stress digits (`AH0` vs `AH1`) are genuinely useful.

---

## 10. Sentence alignment for bilingual parallel text

- **bertalign** — canonical repo https://github.com/bfsujason/bertalign, "Multilingual sentence
  alignment using sentence embeddings", **GPL-3.0**, Python. A fork exists at
  https://github.com/ruben-tsui/bertalign (1 star, 296 MB). Also referenced as a factor in improved
  sentence-alignment accuracy, especially for literary text:
  https://www.nature.com/articles/s41598-023-47479-w.pdf
  **Blocker:** GPL-3.0 is copyleft, and a 296 MB embedding-model dependency is disproportionate.
- **Bleualign** is singled out in an EMNLP 2023 demo paper as the exception that allows reordering:
  *"none of the aligners used, with the exception of Bleualign, allow reordering of sentences in cases
  of possible crossing alignments"* — https://preview.aclanthology.org/ingest-acl-2023-videos/2023.emnlp-demo.22.pdf
- **Named but NOT verified in this session (all UNVERIFIED, licenses unconfirmed):** `hunalign`,
  `Bleualign` (rsennrich/Bleualign), `vecalign`, `simalign`, `Lingua-Align`, `eflomal`,
  `awesome-align`, `m2v-align` (https://pypi.org/project/m2v-align/), and the index at
  https://github.com/topics/sentence-alignment
- **Not OSS, but the strongest practical answer for this stack (my synthesis, not a sourced claim):** for
  the target app the alignment problem is unusually easy — the two sides are already known to be
  parallel (the diary's English and its translation), the sentence count is small, and the LLM is
  **already in the loop**. The cheapest robust approach is to have the Doubao/Ark adapter return the
  translation **already segmented to match the source sentences** (ask for a JSON array of
  `{source, translation}` pairs), which removes the alignment problem instead of solving it. Fall back
  to a dependency-free length-ratio + punctuation dynamic-programming aligner (the classic Gale–Church
  style N/M matching) only when the LLM's pairing is rejected in the confirm step. Do **not** pull in
  embedding-based aligners for a handful of sentences per diary entry.

---

## 11. Could not find / could not verify

- **No `BlueSea` ambiguity remains:** the canonical repo is `jiangqizheng/BlueSea`
  (https://github.com/jiangqizheng/BlueSea); `CrystalYixn/BlueSea` is only a fork. Original task framing
  was uncertain — resolved.
- **`ReadLoops` identity resolved** to `pekoqq/ReadLoops` (https://github.com/pekoqq/ReadLoops) via the
  PyPI JSON API; it is a FastAPI CET-4 reading trainer, **not** a generic "reading-loop" app. Its GitHub
  star count is **UNVERIFIED**. (Unrelated: https://readloop.net is a different product, and `readloop`
  inside `numaproj/numaflow` is an unrelated package.)
- **`joeye88/doubao-free-api`** is a fork/repost of `LLM-Red-Team/doubao-free-api` (identical README);
  `5201213/doubao-free-api` exists but is unindexed — stars/license/recency **UNVERIFIED**, and its
  claimed Vision support is **UNVERIFIED**.
- **`LLM-Red-Team/doubao-free-api` license UNVERIFIED** (no `LICENSE` retrievable at `main`/`master`).
- **Official Volcengine Node OCR/visual SDK package name UNVERIFIED** — only Python and Go SDKs were
  confirmed. Use `@volcengine/ark-runtime` multimodal chat instead.
- **Ark OpenAI-compatible base URL `https://ark.cn-beijing.volces.com/api/v3` UNVERIFIED** as officially
  documented (Volcengine docs pages were not fetchable here).
- **An ARPAbet→IPA converter library was not found/verified.**
- **LexiBridge's internal vocabulary-bank storage mechanism UNVERIFIED** (its `README.org` content type
  was unfetchable).
- **ECDICT `exchange` coverage is asserted by its README (~95 % for lemmas), not independently
  measured** — validate against a real sample before depending on it.

---

## Recommended reuse plan

1. **ECDICT as the vocabulary annotation backbone** — https://github.com/skywind3000/ECDICT (MIT,
   8,381★). One MIT CSV supplies lemma (`exchange` type `0`), Chinese gloss (`translation`), **all
   inflections** (`p`/`d`/`i`/`3`/`r`/`t`/`s`), IPA (`phonetic`), plus free extras: POS distribution
   (`pos`), Collins rating, Oxford-3000 flag, exam tags (`cet4`/`gk`) and two frequency ranks
   (`bnc`/`frq`). Its `lemma.en.txt` + `LemmaDB` is a corpus-derived lemma index the README rates above
   any algorithm (「最可靠的是数据库，算法次之」). Also copy its computed `sw` strip-word fuzzy-match
   column: `stripword(word) = (''.join([n for n in word if n.isalnum()])).lower()`.
   **Provision for what it lacks:** no TTS (`audio` is 待添加) and no example sentences (`detail` is
   待添加) — those come from your TTS adapter and your own captured source sentences.

2. **The ECDICT→IndexedDB pipeline, multi-mirror download and integrity gating from
   obsidian-lexibridge** — https://github.com/Ongiei/obsidian-lexibridge (0BSD, TypeScript). It already
   downloads `ecdict.csv`, converts it locally, imports into **IndexedDB** and keeps dictionary data
   *out* of user content; installs pin an upstream commit and validate file, entry count and
   representative entries **before** swapping the active DB, so a failed update never bricks the app.
   Mirror list to reuse: GitHub, ghproxy.net, gh-proxy.com, jsDelivr, Statically. Same source gives you
   the request-throttling policy your spec demands — *"Requests are serialized, use randomized spacing
   and limited retries, and pause after HTTP 403 or 429 responses"* — and the Anki rule that keeps
   review history intact: update fields via AnkiConnect **instead of deleting and recreating notes**,
   keyed on a stable `LexiBridgeId` field.

3. **`@volcengine/ark-runtime` as the one and only Doubao adapter** —
   https://www.npmjs.com/package/@volcengine/ark-runtime (Apache-2.0). `ArkRuntimeClient` gives
   `createChatCompletion`, `createChatCompletionStream` and typed `ArkAPIError` (with `.requestId`,
   `.httpStatusCode`), plus built-in connection pool, automatic retry and timeout control. Its
   capability table confirms **多模态对话 ✅ 支持图片输入** — i.e. the diary-photo OCR *and* translation
   are one vision call, no second provider needed
   ([图片理解](https://ai.volcengine.com/docs/ark-aihub/2646937?lang=zh)). Expose exactly two adapter
   methods, `chat({messages, images})` and `chatStream(...)`, with an Ark implementation plus a generic
   OpenAI-compatible one. **Avoid the `doubao-free-api` family entirely:** reverse-engineered, forbids
   commercial use, marks image parsing 「计划支持」 (not supported), one variant is GPL-3.0, and the
   projects' own READMEs tell you to use https://www.volcengine.com/product/doubao instead.

4. **The file-based confirm-before-commit protocol from wangzhanchao883/dsh-word-vault** —
   https://github.com/wangzhanchao883/dsh-word-vault (MIT). It is a working DSH-plugin vocabulary app,
   and its transferable core is the **preview → user picks → commit** flow with **explicit
   non-storage outcomes** (no click, explicit dismiss, 20 s timeout → nothing is saved), plus a
   file-based IPC contract (`capture-queue.jsonl` → `capture-prompt.json` → `capture-commands.jsonl` →
   `capture-result.json`) that survives unreliable transports. Copy its two hard-won robustness rules
   verbatim: (a) delete in FK-dependency order
   **`exam_answers → exam_questions → cards → events → words`** with `PRAGMA foreign_keys = ON` and a
   regression test, or row deletion fails with `FOREIGN KEY constraint failed`; (b) `translateWords`
   must **batch (default 12/request), retry un-returned words once and log the failures**, because a
   swallowed `ctx.llm` exception silently left **51 words** without definitions and blocked card
   generation. Also copy: DB insert + receipt **before** the slow LLM call, `promptTimeoutMs=20000`,
   `autoCommit=false`, and the rule that user data lives outside the code repo so code rollback never
   touches recorded words.

5. **ReadLoops for the product/feature contract and the AI-adapter settings shape** —
   https://github.com/pekoqq/ReadLoops (MIT, PyPI `readloops` 2.6.3). Same product thesis (context-first
   vocabulary, not isolated word lists) and a proven `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` triple
   for swapping LLMs (its default is DeepSeek). Steal its **lookup-promotion ladder — 1 lookup → record,
   2 → mark, 3 → auto-add to the vocabulary book** — as a low-friction alternative to explicit add
   clicks; its word-import field contract `lemma / text / meaning / phonetic / level` via
   `app/services/corpus.py : import_word_list(filepath, level)`; its feature list (highlight marking
   that auto-restores after re-render, GitHub-style lookup heatmap, PWA, four themes); and its
   cross-platform data-dir convention with the guarantee that the DB is never written into the package
   directory. Complement it with **LingKuma** (https://github.com/lingkuma/LingKuma, MIT) for three
   concrete UI/architecture patterns: multi-word colour-state annotation, "Sentence Explosion"
   (multi-word query + whole-sentence AI translation in one action), and TTS/sync as adapters
   (custom TTS URL, WebDAV or self-hosted Docker sync).

**Cleared for use (licenses):** ECDICT MIT · obsidian-lexibridge 0BSD · dsh-word-vault MIT ·
LexiBridge MIT · LingKuma MIT · ReadLoops MIT · wink-lemmatizer MIT · en-inflectors MIT ·
cmu-pronouncing-dictionary ISC · ipa-dict MIT · `@volcengine/ark-runtime` Apache-2.0.
**Do not copy code from:** `jiangqizheng/BlueSea` (no license), `1994qrq/2025doubao-free-api` (GPL-3.0),
`bfsujason/bertalign` (GPL-3.0).
