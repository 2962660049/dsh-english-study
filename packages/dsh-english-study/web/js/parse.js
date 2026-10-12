/**
 * Local text parsing — the zero-cost fallback for the text area.
 *
 * The normal path is the 智谱 GLM-4V-Flash adapter in the host. This module exists
 * for the cases where that call cannot run at all (offline, or a result that could
 * not be parsed), so the user can still paste `英文 ||| 中文` by hand and reach the
 * reader screen without spending anything.
 *
 * `parseBilingual` accepts every shape such pasted output realistically takes:
 *   - explicit pairs:  `English sentence ||| 中文句子` (also `|`, TAB, `→`)
 *   - alternating lines: English line, Chinese line, English line, …
 *   - two blocks: a run of English followed by a run of Chinese
 *   - English only, or Chinese only
 * and reports which one it matched so the confirm step can say so out loud.
 */

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const LATIN_RE = /[A-Za-z]/;

/** Common abbreviations whose full stop does not end a sentence. */
const ABBREVIATIONS = [
  "Mr", "Mrs", "Ms", "Dr", "Prof", "St", "Jr", "Sr", "vs", "etc",
  "e.g", "i.e", "a.m", "p.m", "No", "Fig", "vol", "ch", "pp",
  "Jan", "Feb", "Mar", "Apr", "Jun", "Jul", "Aug", "Sep", "Sept", "Oct", "Nov", "Dec",
];

/** Strip a leading list marker: `1.`, `2)`, `3、`, `-`, `*`, `•`. */
function stripMarker(line) {
  return line.replace(/^\s*(?:\d+\s*[.)、:：]|[-*•·])\s*/, "").trim();
}

export function hasChinese(text) {
  return CJK_RE.test(String(text ?? ""));
}

export function hasLatin(text) {
  return LATIN_RE.test(String(text ?? ""));
}

/** Chinese-dominant line? Used to decide which side of a pair a line belongs to. */
export function looksChinese(text) {
  const value = String(text ?? "");
  const cjk = (value.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const latin = (value.match(/[A-Za-z]/g) ?? []).length;
  return cjk > 0 && cjk >= latin;
}

/**
 * Split English text into sentences, keeping abbreviations and decimals intact.
 * The naive `(?<=[.!?])\s+` split turns "Mr. Smith" and "3.5" into fake breaks.
 */
export function splitEnglish(text) {
  let guarded = String(text ?? "");
  for (const abbreviation of ABBREVIATIONS) {
    guarded = guarded.replace(
      new RegExp(`\\b(${abbreviation.replace(/\./g, "\\.")})\\.`, "g"),
      "$1\u0001",
    );
  }
  // Protect decimals and ellipses too.
  guarded = guarded.replace(/(\d)\.(\d)/g, "$1\u0001$2").replace(/\.{3}/g, "\u0001\u0001\u0001");

  return guarded
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.replace(/\u0001/g, ".").replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 0);
}

/** Split Chinese text into sentences on the full-width terminators. */
export function splitChinese(text) {
  return String(text ?? "")
    .split(/(?<=[。！？!?…])/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 0);
}

/** Split a sentence into clickable word tokens and the glue between them. */
export function tokenize(sentence) {
  return String(sentence ?? "")
    .split(/([A-Za-z][A-Za-z'’-]*)/g)
    .filter((part) => part.length > 0);
}

/**
 * Best-effort base form of a word, so `recorded` can find `record`.
 * Deliberately conservative: a wrong stem only costs a redundant lookup.
 */
export function stemOf(word) {
  const lower = String(word ?? "").toLowerCase();
  const rules = [
    [/ies$/, "y"],
    [/(ss|sh|ch|x|z)es$/, "$1"],
    [/([^aeiou])es$/, "$1"],
    [/s$/, ""],
    [/ied$/, "y"],
    [/([^aeiou])\1ed$/, "$1"],
    [/([^aeiou])ed$/, "$1"],
    [/ed$/, ""],
    // The doubled-consonant rule must precede the bare `ing` rule, or "running"
    // is reduced to "runn" instead of "run".
    [/([^aeiou])\1ing$/, "$1"],
    [/ing$/, ""],
  ];
  for (const [pattern, replacement] of rules) {
    if (pattern.test(lower)) {
      const candidate = lower.replace(pattern, replacement);
      if (candidate.length >= 2 && candidate !== lower) return candidate;
    }
  }
  return lower;
}

const PAIR_SEPARATORS = [/\s*\|\|\|\s*/, /\s*\|\s*/, /\t+/, /\s*→\s*/, /\s*⇒\s*/, /\s*=>\s*/];

function splitPairLine(line) {
  for (const separator of PAIR_SEPARATORS) {
    if (separator.test(line)) {
      const parts = line.split(separator).map((part) => part.trim()).filter((part) => part.length > 0);
      if (parts.length === 2) {
        const [left, right] = parts;
        return looksChinese(left) && !looksChinese(right)
          ? { en: right, zh: left }
          : { en: left, zh: right };
      }
    }
  }
  return null;
}

/**
 * @param {string} text raw pasted text (a model reply, or anything similar)
 * @returns {{ mode: "pairs"|"lines"|"blocks"|"english"|"chinese"|"empty",
 *             pairs: { en: string, zh: string }[],
 *             note: string }}
 */
export function parseBilingual(text) {
  const raw = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (raw.length === 0) {
    return { mode: "empty", pairs: [], note: "没有内容" };
  }

  const lines = raw
    .split("\n")
    .map((line) => stripMarker(line))
    .filter((line) => line.length > 0);

  const bilingual = hasChinese(raw) && hasLatin(raw);

  /* 1. Explicit pair separators — the most reliable signal, so it wins. */
  if (bilingual) {
    const explicit = lines.map(splitPairLine).filter(Boolean);
    if (explicit.length > 0 && explicit.length >= Math.ceil(lines.length / 2)) {
      return {
        mode: "pairs",
        pairs: explicit,
        note: `识别到 ${explicit.length} 组「英文 | 中文」对照行。`,
      };
    }
  }

  /* 2. Alternating or block lines: classify, then zip in order. */
  const enLines = lines.filter((line) => !looksChinese(line) && hasLatin(line));
  const zhLines = lines.filter((line) => looksChinese(line));

  if (enLines.length > 0 && zhLines.length > 0) {
    if (enLines.length === zhLines.length) {
      // A block layout (all English, then all Chinese) has the same line counts as
      // an alternating one, so only claim "lines" when the scripts really do
      // alternate at *every* step — differing once is not enough.
      const interleaved = lines.every(
        (line, index) => index === 0 || looksChinese(line) !== looksChinese(lines[index - 1]),
      );
      const pairs = enLines.map((en, index) => ({ en, zh: zhLines[index] ?? "" }));
      return {
        mode: interleaved ? "lines" : "blocks",
        pairs,
        note: interleaved
          ? `识别到 ${pairs.length} 组英中交替行。`
          : `识别到 ${pairs.length} 组英中对照（整段英文 + 整段中文）。`,
      };
    }
    // Counts disagree — fall back to sentence-level alignment and say so.
    const enSentences = enLines.flatMap((line) => splitEnglish(line));
    const zhSentences = zhLines.flatMap((line) => splitChinese(line));
    if (enSentences.length === zhSentences.length && enSentences.length > 0) {
      return {
        mode: "blocks",
        pairs: enSentences.map((en, index) => ({ en, zh: zhSentences[index] ?? "" })),
        note: `按句子对齐了 ${enSentences.length} 组（原文行数不一致，请核对）。`,
      };
    }
    return {
      mode: "blocks",
      pairs: enSentences.map((en, index) => ({ en, zh: zhSentences[index] ?? "" })),
      note: `英中数量不一致（英文 ${enSentences.length} 句 / 中文 ${zhSentences.length} 句），已尽力对齐，请逐句核对。`,
    };
  }

  /* 3. One language only. */
  if (enLines.length > 0) {
    return {
      mode: "english",
      pairs: splitEnglish(enLines.join(" ")).map((en) => ({ en, zh: "" })),
      note: "只有英文，中文翻译留空，稍后可以手动补。",
    };
  }
  if (zhLines.length > 0) {
    return {
      mode: "chinese",
      pairs: splitChinese(zhLines.join("")).map((zh) => ({ en: "", zh })),
      note: "只有中文，需要你自己补英文。",
    };
  }

  return {
    mode: "english",
    pairs: splitEnglish(raw).map((en) => ({ en, zh: "" })),
    note: "未能判断语言，按英文处理。",
  };
}
