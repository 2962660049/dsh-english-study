/**
 * Live check of the multi-page guard against the RUNNING host.
 *
 *   node tools/seq-probe.mjs [baseUrl]
 *
 * Page 1 of a brand-new date is created; page 3 is then refused because page 2
 * was never opened (「未打开第二篇的时候不会建立下一页」). The entry it creates is
 * deleted again, so the store is left exactly as it was found.
 */

const base = (process.argv[2] ?? "http://127.0.0.1:19387/english-study").replace(/\/+$/, "");
const date = "2099-12-31";

async function post(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  return { status: response.status, payload };
}

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const page1 = await post("/api/diary", { date, seq: 1, corrected: "seq-probe placeholder" });
check("page 1 of a fresh date is created", page1.status === 200 && page1.payload?.entry?.seq === 1, `status=${page1.status} seq=${page1.payload?.entry?.seq}`);

const page3 = await post("/api/diary", { date, seq: 3, corrected: "must not be written" });
check(
  "page 3 is refused while page 2 does not exist",
  page3.status === 400 && page3.payload?.code === "page-order",
  `status=${page3.status} code=${page3.payload?.code} msg=${page3.payload?.error ?? page3.payload?.message ?? ""}`,
);

const page2 = await post("/api/diary", { date, seq: 2, corrected: "second sheet" });
check("page 2 is accepted once page 1 exists", page2.status === 200 && page2.payload?.entry?.seq === 2, `status=${page2.status}`);

const page3b = await post("/api/diary", { date, seq: 3, corrected: "third sheet" });
check("page 3 is accepted once page 2 exists", page3b.status === 200 && page3b.payload?.entry?.seq === 3, `status=${page3b.status}`);

const state = await fetch(`${base}/api/state`).then((response) => response.json());
const pages = (state.diary ?? []).filter((entry) => entry.date === date).map((entry) => entry.seq);
check("the day holds exactly its three pages, in order", pages.join(",") === "1,2,3", `seq=${pages.join(",")}`);

for (const entry of (state.diary ?? []).filter((item) => item.date === date)) {
  await post("/api/diary/delete", { id: entry.id });
}
const after = await fetch(`${base}/api/state`).then((response) => response.json());
check("the probe cleaned up after itself", (after.diary ?? []).every((entry) => entry.date !== date));

console.log(failures === 0 ? "\nseq-probe: all checks clean" : `\nseq-probe: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
