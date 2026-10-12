/**
 * Check the offline bilingual parser against the shapes Doubao realistically
 * returns, so the manual (no-API) path is trustworthy.
 *
 *   tools\node.cmd tools\smoke-parse.mjs
 */

import { parseBilingual, splitEnglish, splitChinese, stemOf, tokenize } from "../packages/dsh-english-study/web/js/parse.js";

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}`);
    console.log(`       expected ${JSON.stringify(expected)}`);
    console.log(`       actual   ${JSON.stringify(actual)}`);
  }
}

function show(label, text) {
  const result = parseBilingual(text);
  console.log(`\n[${label}] mode=${result.mode} pairs=${result.pairs.length}`);
  console.log(`  note: ${result.note}`);
  for (const pair of result.pairs) console.log(`   en=${JSON.stringify(pair.en)}\n   zh=${JSON.stringify(pair.zh)}`);
  return result;
}

console.log("--- explicit separators ---");
let r = show("pipe pairs", "I went to the park. ||| 我去了公园。\nIt was sunny. ||| 天气晴朗。");
check("pipe mode", r.mode, "pairs");
check("pipe count", r.pairs.length, 2);
check("pipe first zh", r.pairs[0].zh, "我去了公园。");

r = show("reversed order", "我去了公园。 | I went to the park.");
check("reversed detects zh first", r.pairs[0].en, "I went to the park.");

console.log("\n--- alternating lines ---");
r = show(
  "alternating",
  "今天我去公园散步了。\nI went for a walk in the park today.\n那里有很多花。\nThere were many flowers there.",
);
check("alternating mode", r.mode, "lines");
check("alternating count", r.pairs.length, 2);

console.log("\n--- block layout (English paragraph then Chinese paragraph) ---");
r = show(
  "blocks",
  "I went for a walk in the park today.\nThere were many flowers there.\n今天我去公园散步了。\n那里有很多花。",
);
check("block mode", r.mode, "blocks");
check("block count", r.pairs.length, 2);

console.log("\n--- numbered bilingual ---");
r = show(
  "numbered",
  "1. I read a book yesterday.\n1. 我昨天读了一本书。\n2. It was interesting.\n2. 它很有趣。",
);
check("numbered mode", r.mode, "lines");
check("numbered count", r.pairs.length, 2);
check("numbered marker stripped", r.pairs[0].en, "I read a book yesterday.");

console.log("\n--- English only ---");
r = show("english only", "I went to the park. It was sunny. I saw Mr. Smith there.");
check("english mode", r.mode, "english");
check("english sentences", r.pairs.length, 3);
check("english zh blank", r.pairs[0].zh, "");

console.log("\n--- Chinese only ---");
r = show("chinese only", "今天我去公园散步了。那里有很多花。");
check("chinese mode", r.mode, "chinese");
check("chinese count", r.pairs.length, 2);
check("chinese en blank", r.pairs[0].en, "");

console.log("\n--- uneven counts ---");
r = show("uneven", "I went to the park.\nIt was sunny.\n我去了公园。");
check("uneven notes mismatch", r.note.includes("不一致"), true);
r = show("multi-sentence single lines", "I went to the park. It was sunny.\n我去了公园，天气晴朗。");
check("1:1 lines zip as one pair", r.pairs.length, 1);

console.log("\n--- empty ---");
r = show("empty", "   \n  ");
check("empty mode", r.mode, "empty");

console.log("\n--- sentence splitting ---");
check("abbreviation kept", splitEnglish("I met Mr. Smith. He was kind."), ["I met Mr. Smith.", "He was kind."]);
check("decimal kept", splitEnglish("It costs 3.5 dollars. That is cheap."), ["It costs 3.5 dollars.", "That is cheap."]);
check("question split", splitEnglish("Are you ok? Yes I am!"), ["Are you ok?", "Yes I am!"]);
check("ellipsis stays one sentence", splitEnglish("Wait... what?"), ["Wait... what?"]);
check("chinese split", splitChinese("今天很好。你呢？我很好！"), ["今天很好。", "你呢？", "我很好！"]);

console.log("\n--- stemming ---");
check("recorded", stemOf("recorded"), "record");
check("studies", stemOf("studies"), "study");
check("running", stemOf("running"), "run");
check("walked", stemOf("walked"), "walk");
check("boxes", stemOf("boxes"), "box");
check("plain", stemOf("park"), "park");

console.log("\n--- tokenize ---");
check("tokenize keeps glue", tokenize("I went, then left."), ["I", " ", "went", ", ", "then", " ", "left", "."]);

console.log("");
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
