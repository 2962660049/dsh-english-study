/**
 * probe-api.mjs — assert REAL behaviour of the live plugin routes on a running DSH.
 *
 *   tools\node.cmd tools\probe-api.mjs [baseUrl]
 *
 * "Not a 5xx" is too weak: it would pass the SPA fallback serving HTML with
 * `content-type: application/octet-stream`, and it would not notice an export
 * endpoint that answers 200 with an empty body. Every probe below therefore
 * states what the response must actually be.
 */

const base = (process.argv[2] ?? "http://127.0.0.1:19387").replace(/\/$/, "");
const prefix = "/english-study";

const JS = "javascript";
const HTML = "text/html";

/** Static assets: must be 200 with the right content type. */
const assets = [
  ["/styles.css", "text/css"],
  ["/js/app.js", JS],
  ["/js/ui.js", JS],
  ["/js/api.js", JS],
  ["/js/db.js", JS],
  ["/js/tts.js", JS],
  ["/js/store.js", JS],
  ["/js/router.js", JS],
  ["/js/components.js", JS],
  ["/js/parse.js", JS],
  ["/js/views/home.js", JS],
  ["/js/views/diary.js", JS],
  ["/js/views/webtest.js", JS],
  ["/js/views/vocab.js", JS],
  ["/js/views/settings.js", JS],
];

const probes = [
  { path: prefix, want: { status: 302, location: `${prefix}/` }, note: "bare prefix redirects" },
  { path: `${prefix}/`, want: { status: 200, type: HTML }, note: "entry page" },
  ...assets.map(([path, type]) => ({ path: `${prefix}${path}`, want: { status: 200, type }, note: "asset" })),

  {
    path: `${prefix}/api/health`,
    want: {
      status: 200,
      type: "application/json",
      check: (body) =>
        body.ok === true &&
        body.plugin === "dsh-english-study" &&
        // THE post-restart signal: the free vision model is the only real provider.
        body.activeProvider === "glm" &&
        Array.isArray(body.providers) &&
        body.providers.length === 1 &&
        body.providers[0].id === "glm" &&
        typeof body.dictionary?.state === "string" &&
        typeof body.dataDir === "string",
      detail: (body) => `provider=${body.activeProvider} providers=${(body.providers ?? []).map((p) => p.id).join(",")} dictionary=${body.dictionary?.state}/${body.dictionary?.size ?? 0}`,
    },
  },
  {
    path: `${prefix}/api/state`,
    want: {
      status: 200,
      type: "application/json",
      check: (body) => body.ok === true && Array.isArray(body.diary) && Array.isArray(body.vocabWords) && Array.isArray(body.vocabEvents),
      detail: (body) => `diary=${body.diary?.length} words=${body.vocabWords?.length} events=${body.vocabEvents?.length}`,
    },
  },
  {
    path: `${prefix}/api/settings`,
    want: {
      status: 200,
      type: "application/json",
      check: (body) =>
        body.ok === true &&
        body.settings?.activeProvider === "glm" &&
        Array.isArray(body.settings?.availableProviders) &&
        // Only the free vision model may be advertised; the hidden test double
        // and the removed metered providers must never reach a browser.
        body.settings.availableProviders.length === 1 &&
        body.settings.availableProviders[0].id === "glm" &&
        body.settings.availableProviders[0].capabilities?.vision === true &&
        !body.settings.availableProviders.some((p) => ["doubao", "deepseek", "manual", "mock"].includes(p.id)) &&
        // All four prompts ship as defaults so 设置 can offer 恢复默认 for each.
        ["pageText", "pageWords", "collocations", "normalize"].every(
          (key) => typeof body.settings.prompts?.[key] === "string" && typeof body.settings.defaultPrompts?.[key] === "string",
        ) &&
        body.settings.prompts.pageText.includes("提取出其中的英文") &&
        body.settings.prompts.pageWords.includes("椭圆") &&
        body.settings.prompts.collocations.includes("固定搭配") &&
        // The old combined prompt is gone: it measurably lost ringed words.
        !JSON.stringify(body.settings.prompts).includes("现在进行时") &&
        // The paste-a-diary path must not have survived anywhere in the settings view.
        typeof body.settings.correction === "undefined" &&
        // No response may ever carry a raw key.
        !/"apiKey"\s*:\s*"[^"]/.test(JSON.stringify(body)),
      detail: (body) => `active=${body.settings?.activeProvider} providers=${(body.settings?.availableProviders ?? []).map((p) => p.id).join(",")}`,
    },
  },
  {
    // The regression this guards: `handler()` dropped its 3rd/4th arguments, so
    // every export answered 500 on `query.get`.
    path: `${prefix}/api/vocab/export?format=json`,
    want: {
      status: 200,
      check: (raw) => {
        const body = JSON.parse(raw);
        return body.ok === true && Array.isArray(body.words) && Array.isArray(body.events);
      },
      detail: (raw) => `json export, ${JSON.parse(raw).words.length} word(s), ${raw.length}B`,
      json: false,
    },
  },
  {
    // Assert the header, not the rows: a fresh install legitimately has an empty
    // vocabulary bank, and this probe must not write test data into the user's.
    path: `${prefix}/api/vocab/export?format=csv`,
    want: {
      status: 200,
      check: (raw) => raw.includes("lemma") && raw.includes("glossZh") && raw.startsWith("\ufeff"),
      detail: (raw) => `csv export, ${raw.length}B`,
      json: false,
    },
  },
  {
    path: `${prefix}/api/vocab/export?format=anki`,
    want: {
      status: 200,
      type: "tab-separated-values",
      check: (raw) => typeof raw === "string",
      detail: (raw) => `anki export, ${raw.length}B`,
      json: false,
    },
  },
  {
    // The other dropped-argument regression.
    path: `${prefix}/api/images`,
    want: { status: 404, type: "application/json", check: (body) => body.ok === false && body.error?.code === "not-found" },
    note: "bare images key must be a clean 404, not a 500",
  },
  {
    path: `${prefix}/api/images/${"a".repeat(32)}.jpg`,
    want: { status: 404, type: "application/json", check: (body) => body.ok === false },
    note: "missing image is a 404",
  },
  {
    path: `${prefix}/api/images/${"Z".repeat(32)}.jpg`,
    want: { status: 404, type: "application/json", check: (body) => body.ok === false },
    note: "illegal image id is rejected",
  },
  {
    path: `${prefix}/api/definitely-missing`,
    want: { status: 404, type: "application/json", check: (body) => body.error?.code === "not-found" },
  },
  { path: `${prefix}/js/definitely-missing.js`, want: { status: 404 } },
  {
    // The octet-stream regression: the SPA history fallback serves index.html but
    // must keep a text/html content type.
    path: `${prefix}/some/spa/route`,
    want: { status: 200, type: HTML, check: (raw) => raw.includes("<div id=\"root\""), json: false },
    note: "SPA fallback must be HTML",
  },
  {
    // Regression guard for the overlay bug: the UA rule `[hidden] {display:none}`
    // loses to any author `display`, and .modal-layer declares `display: grid`, so
    // a missing `[hidden]` rule paints a fixed full-viewport dark film over the
    // whole app. A DOM stub cannot see CSS, so it must be asserted on the wire.
    path: `${prefix}/styles.css`,
    want: {
      status: 200,
      type: "text/css",
      check: (raw) => /\[hidden\]\s*\{[^}]*display:\s*none/.test(raw),
      json: false,
    },
    note: "[hidden] must force display:none",
  },
  {
    // The two live bugs this guards, end to end through the real model:
    //   1. a Chinese paste produced a BLANK preview (`corrected` empty);
    //   2. a Chinese-only result reached the reader screen, where the speech
    //      engine cannot pronounce it.
    // Cost: one short free GLM call.
    path: `${prefix}/api/llm/normalize`,
    post: { text: "我昨天去了公园。" },
    want: {
      status: 200,
      type: "application/json",
      check: (body) =>
        body.ok === true &&
        body.degraded === false &&
        typeof body.data?.corrected === "string" &&
        body.data.corrected.trim().length > 0 &&
        /[A-Za-z]/.test(body.data.corrected) &&
        !/[\u4e00-\u9fff]/.test(body.data.corrected) &&
        Array.isArray(body.data.segments) &&
        body.data.segments.length >= 1 &&
        body.data.segments.every((segment) => typeof segment.en === "string" && /[A-Za-z]/.test(segment.en)),
      detail: (body) => `${body.data?.segments?.length ?? 0} segment(s) · ${String(body.data?.corrected ?? "").slice(0, 46)}`,
    },
    note: "corrected must be non-empty ENGLISH",
  },
];

let failures = 0;

for (const { path, want, note, post } of probes) {
  const url = `${base}${path}`;
  const problems = [];
  let line = "";
  try {
    const init = { redirect: "manual" };
    if (post !== undefined) {
      init.method = "POST";
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(post);
    }
    const response = await fetch(url, init);
    // Decode with ignoreBOM so a leading U+FEFF stays visible: Response.text()
    // silently strips it, which would make the CSV BOM unassertable.
    const raw = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await response.arrayBuffer());
    const type = response.headers.get("content-type") ?? "";
    const expectedStatus = want.status ?? 200;

    line = `${String(response.status).padEnd(3)} ${String(raw.length).padStart(6)}B  ${type.padEnd(30)} ${path}`;

    if (response.status !== expectedStatus) problems.push(`status ${response.status}, expected ${expectedStatus}`);
    if (want.location !== undefined && (response.headers.get("location") ?? "") !== want.location) {
      problems.push(`location ${response.headers.get("location")}, expected ${want.location}`);
    }
    if (want.type !== undefined && !type.includes(want.type)) problems.push(`content-type ${type}, expected ${want.type}`);

    if (problems.length === 0 && want.check) {
      let body = raw;
      if (want.json !== false) {
        try {
          body = JSON.parse(raw);
        } catch (error) {
          problems.push(`body is not JSON: ${error.message}`);
        }
      }
      if (problems.length === 0) {
        let ok = false;
        try {
          ok = want.check(body) === true;
        } catch (error) {
          problems.push(`assertion threw: ${error.message}`);
        }
        if (!ok && problems.length === 0) problems.push("body assertion failed");
      }
    }

    if (problems.length === 0 && want.detail) {
      let body = want.json === false ? raw : JSON.parse(raw);
      line += `  ${want.detail(body)}`;
    }
    if (note) line += `   [${note}]`;
  } catch (error) {
    problems.push(`request failed: ${error?.message ?? error}`);
    line = `ERR ${path}`;
  }

  if (problems.length > 0) {
    failures += 1;
    for (const problem of problems) line += `\n      !! ${problem}`;
  }
  console.log(line);
}

console.log("");
console.log(failures === 0 ? `all ${probes.length} probes clean` : `${failures} of ${probes.length} probe(s) need attention`);
process.exit(failures === 0 ? 0 : 1);
