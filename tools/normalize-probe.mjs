#!/usr/bin/env node
/**
 * Text-area acceptance probe for the 其它文本处理区 path.
 *
 * Runs the REAL production pipeline — `__internals.runNormalize`, the same function
 * the `/llm/normalize` route calls (per-line contract + host-side composition + one
 * repair pass) — against 智谱 GLM-4V-Flash directly, so no DSH restart is needed.
 *
 * It exists to hold the three reported bugs down:
 *   1. a blank line between two paragraphs  -> only the first paragraph came back
 *   2. a paragraph-leading number ("1.")    -> the number jumped to the previous line
 *   3. Chinese + English mixed input        -> 同人 survived inside English output
 *
 * Nothing is written to the store. The model is free, so a run costs nothing.
 *
 *   tools\node.cmd tools\normalize-probe.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LlmRegistry, splitSourceLines } from "../packages/dsh-english-study/lib/llm.js";
import { __internals } from "../packages/dsh-english-study/lib/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const store = JSON.parse(readFileSync(resolve(here, "..", "data", "store.json"), "utf8"));
const credentials = store?.settings?.credentials ?? {};
const glm = credentials.glm ?? credentials.zhipu ?? null;
const apiKey = String(glm?.apiKey ?? "").trim();
if (apiKey.length === 0) {
  console.error("no glm apiKey in data/store.json");
  process.exit(2);
}

const WITH_BLANK = [
  "这个阶段大概是我一生中最忙碌的时期。",
  "我发现付出越多，就越忙碌。为充分利用时间，我需要写下短期目标与长期方向。",
  "",
  "1. 给葛经理发消息，启动项目下一阶段。",
  "2. 准备一个月后第一堂课的教学计划。",
  "3. 完善并蒸馏 dsh-agent 相关技能，加快项目进度。",
  "4. 学习借助 Blender、dsh、updream 制作同人视频。",
  "5. 在学习与休息之间找到平衡。",
  "",
  "这确实是充满挑战的人生阶段，但我不会放弃。我所学习的东西，正是我所热爱的",
].join("\n");

const NO_BLANK = WITH_BLANK.split("\n")
  .filter((line) => line.trim().length > 0)
  .join("\n");

const MIXED = [
  "这个阶段大概是我一生中最忙碌的时期。",
  "I found that the more I pay, the busier I am. 为充分利用时间，我需要写下短期目标与长期方向。",
].join("\n");

const CASES = [
  { name: "A 空行分隔（原样）", text: WITH_BLANK },
  { name: "B 去掉空行", text: NO_BLANK },
  { name: "C 中英混合", text: MIXED },
];

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;

/** The list marker a source line starts with, or "" — "1. " → "1". */
function listMarker(line) {
  const match = /^\s*(\d+)\s*[.、)）]/.exec(line);
  return match === null ? "" : match[1];
}

const registry = new LlmRegistry();
const settings = {
  activeProvider: "glm",
  credentials: { glm: { apiKey, model: "glm-4v-flash", baseUrl: glm?.baseUrl } },
};

let failures = 0;
for (const item of CASES) {
  const sourceLines = splitSourceLines(item.text);
  const started = Date.now();
  let envelope = null;
  let error = null;
  try {
    envelope = await __internals.runNormalize({
      registry,
      settings,
      text: item.text,
      timeoutMs: 120_000,
    });
  } catch (caught) {
    error = caught;
  }
  const elapsed = Date.now() - started;
  console.log(`\n=== ${item.name} (${item.text.length} chars, ${elapsed} ms) ===`);
  if (error !== null) {
    console.log(`  ERROR ${error?.message ?? error}`);
    failures += 1;
    continue;
  }

  const data = envelope.data ?? {};
  const corrected = String(data.corrected ?? "");
  const outLines = splitSourceLines(corrected);
  console.log(
    `  degraded=${envelope.degraded} repaired=${data.repaired} missing=[${(data.missing ?? []).join(",")}] impure=[${(data.impure ?? []).join(",")}] segments=${(data.segments ?? []).length}`,
  );
  console.log(`  usage=${JSON.stringify(envelope.usage)}`);
  console.log("  --- corrected ---");
  for (const line of outLines) console.log(`  | ${line}`);

  const problems = [];
  if (envelope.degraded === true) problems.push("degraded");
  if (corrected.length === 0) problems.push("corrected is EMPTY");
  if (CJK.test(corrected)) problems.push("corrected still contains Chinese");
  if ((data.missing ?? []).length > 0) problems.push("lines kept verbatim: " + data.missing.join(","));
  if ((data.impure ?? []).length > 0) problems.push("untranslated lines: " + data.impure.join(","));
  // Structure: the reader's line count and every list number must survive.
  if (outLines.length !== sourceLines.length) {
    problems.push(`line count ${outLines.length} != source ${sourceLines.length}`);
  } else {
    for (const [index, line] of sourceLines.entries()) {
      const marker = listMarker(line);
      if (marker.length === 0) continue;
      if (listMarker(outLines[index]) !== marker) {
        problems.push(`line ${index + 1} lost its "${marker}." marker`);
      }
    }
  }
  if (CJK.test(JSON.stringify((data.segments ?? []).map((segment) => segment.en)))) {
    problems.push("a segment still contains Chinese");
  }

  if (problems.length === 0) {
    console.log("  OK");
  } else {
    for (const problem of problems) console.log(`  !! ${problem}`);
    failures += 1;
  }
}

console.log(`\nnormalize-probe: ${CASES.length - failures}/${CASES.length} cases clean`);
process.exit(failures === 0 ? 0 : 1);
