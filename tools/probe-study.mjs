/**
 * LIVE vision probe: the diary path, end to end, against the running DSH.
 *
 *   tools\node.cmd tools\probe-study.mjs [baseUrl] [imagePath]
 *
 * This is the acceptance test for the user's actual requirement: a handwritten
 * page of ALREADY-TRANSLATED English with ellipses around the unknown words.
 * It calls the real GLM-4V-Flash through /llm/study and reports what came back
 * — nothing is written to the store (that is /diary/import's job).
 *
 * Host-side changes need a DSH restart before this reflects them; when no
 * restart is possible, tools\probe-study-direct.mjs runs the same checks
 * against the same modules without going through the server.
 */

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { reportStudy } from "./study-check.mjs";

const base = (process.argv[2] ?? "http://127.0.0.1:19387").replace(/\/$/, "");
const imagePath = process.argv[3] ?? "tools/fixtures/handwriting-01.png";

const bytes = readFileSync(imagePath);
const started = Date.now();

const response = await fetch(`${base}/english-study/api/llm/study`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    images: [{ base64: bytes.toString("base64"), mimeType: "image/png" }],
    requestId: randomUUID(),
  }),
});

const body = await response.json().catch(() => null);
const elapsed = Date.now() - started;
console.log(`POST /api/llm/study -> ${response.status}`);

if (body === null || body.ok !== true) {
  console.log("FAILED:", JSON.stringify(body)?.slice(0, 600));
  process.exit(1);
}

process.exit(reportStudy(body, elapsed) === 0 ? 0 : 1);
