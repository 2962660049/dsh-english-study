/**
 * Shared acceptance checks for the diary vision path.
 *
 * Both probes drive the SAME study contract against the real GLM-4V-Flash and
 * differ only in how they reach it:
 *   · tools\probe-study.mjs        — through the running DSH (needs a restart)
 *   · tools\probe-study-direct.mjs — straight through the plugin's own modules
 *
 * The checks live here so the two can never drift apart.
 */

export const CIRCLED = [
  "uneasy", "accomplish", "track", "tackle", "issues", "postponed", "till",
  "confusion", "retrain", "excessive", "blank", "insufficient", "sampled",
  "decent", "beverages", "precisely", "considerable",
];
// Words the user did NOT circle — a good extraction must leave them alone.
export const NOT_CIRCLED = ["routine", "devoted", "tasks", "forthcoming", "dormitory", "review", "budget", "customers"];

/**
 * Print one study result and score it.
 *
 * @param {Record<string, any>} body the shaped /llm/study envelope
 * @param {number} elapsed milliseconds spent
 * @returns {number} the number of failed checks
 */
export function reportStudy(body, elapsed) {
  console.log(`degraded=${body.degraded} partial=${body.partial ?? false} adapter=${body.adapter} parseError=${body.parseError ?? null} in ${elapsed} ms`);
  console.log(`raw reply: ${String(body.rawText ?? "").length} chars`);
  if (body.usage !== undefined && body.usage !== null) {
    console.log(`usage: ${JSON.stringify(body.usage)}`);
  }
  if (body.degraded === true) {
    console.log("raw model output (first 1200 chars):");
    console.log(String(body.rawText ?? "").slice(0, 1200));
    return 1;
  }

  const data = body.data ?? {};
  const text = String(data.text ?? "");
  const words = Array.isArray(data.words) ? data.words : [];
  console.log(`\ntext: ${text.length} chars, ${(data.sentences ?? []).length} sentence(s)`);
  console.log(`words: ${words.length}`);
  for (const word of words) {
    const infl = (word.inflections ?? []).map((item) => `${item.label}=${item.form}`).join(" ");
    const coll = (word.collocations ?? []).join(" / ");
    console.log(`  · ${word.word} [${word.partOfSpeech ?? ""}] ${word.glossZh ?? ""}  {${infl}}${coll.length > 0 ? `  colloc: ${coll}` : ""}`);
  }

  // A circled form may come back as its lemma ("postponed" → "postpone"), so a
  // hit counts when EITHER the surface form or the lemma matches.
  const found = new Set();
  for (const word of words) {
    for (const key of [word.word, word.lemma]) {
      const value = String(key ?? "").toLowerCase();
      if (value.length > 0) found.add(value);
    }
  }
  const hit = CIRCLED.filter((word) => found.has(word));
  const missed = CIRCLED.filter((word) => !found.has(word));
  const noise = NOT_CIRCLED.filter((word) => found.has(word));

  console.log(`\ncircled words recovered: ${hit.length}/${CIRCLED.length}`);
  if (missed.length > 0) console.log(`  missed: ${missed.join(", ")}`);
  if (noise.length > 0) console.log(`  NOT circled but returned: ${noise.join(", ")}`);

  let failures = 0;
  const expect = (label, ok, detail = "") => {
    console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail.length > 0 ? ` — ${detail}` : ""}`);
    if (!ok) failures += 1;
  };

  const lower = text.toLowerCase();
  expect(
    "the English page was extracted verbatim",
    lower.includes("my daily routine") && lower.includes("terrible experience"),
    `${text.length} chars`,
  );
  expect("the ellipses were recognised as the target words", hit.length >= 14, `${hit.length}/${CIRCLED.length}`);
  expect("the single most obvious circle is present", found.has("uneasy"));
  expect("at least one word carries a real inflection set", words.some((word) => (word.inflections ?? []).length >= 2));
  expect("every returned word carries a Chinese gloss", words.every((word) => String(word.glossZh ?? "").length > 0));
  expect("uncircled ordinary words were not swallowed", noise.length === 0, noise.join(", "));
  // The 1024-token ceiling is real, so a reply may legitimately be salvaged as
  // partial — but it must never lose the page, and every word must still carry
  // the sentence the host located for it.
  expect("the page was not lost to the token ceiling", words.length >= 14, `${words.length} word(s)`);
  expect("every returned word has its containing sentence", words.every((word) => String(word.sentence ?? "").length > 0));
  expect("the local dictionary described the words", words.filter((word) => word.source === "ecdict").length >= 14);

  console.log(`\n${failures === 0 ? "all vision checks clean" : `${failures} vision check(s) need attention`}`);
  return failures;
}
