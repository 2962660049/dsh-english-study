/**
 * 提交前的密钥安全检查 —— 在 `git add` 之后、`git commit` 之前运行。
 *
 *     tools\node.cmd tools\check-secrets.mjs
 *
 * 它做三件事：
 *   1. 用 `git ls-files --cached --others --exclude-standard` 取出「这次提交真正会
 *      包含的文件清单」——也就是遵守 .gitignore 之后的结果，而不是全盘扫描；
 *   2. 拿 data\store.json 里那把真实的 Key（以及它的头 12 / 尾 12 个字符、常见
 *      密钥形态）去这些文件里搜；顺便检查有没有非空的 "apiKey": "..."；
 *   3. 确认 data\store.json 本身、打包副本、第三方文档没有被提交进去。
 *
 * 只要命中任何一条就以退出码 1 结束，并中止提交。
 *
 * 这个脚本**从不打印密钥本身**，只打印路径、命中的种类和「前 4 位 + 长度」这种
 * 无法还原的指纹。所以你贴运行日志给别人看是安全的。
 *
 * 用法细节：Node 在这个沙箱里无法用管道捕获子进程输出（stdio: 'pipe' 会 EPERM），
 * 所以下面把 git 的 stdout 重定向到一个临时文件再读回来。
 */

import { readFileSync, existsSync, openSync, closeSync, unlinkSync, statSync, readdirSync } from "node:fs";
import { join, resolve, relative, extname } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dirname, "..");
const STORE = join(ROOT, "data", "store.json");

/** 绝对不能出现在提交清单里的路径（相对仓库根，正斜杠）。 */
const FORBIDDEN = [
  "data/store.json",
  "version1.0",
  "docs/dsh-api",
  ".dsh-asar",
  "node_modules",
  ".pnpm-store",
];

const TEXT_EXT = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".json", ".md", ".txt", ".yml", ".yaml",
  ".html", ".css", ".csv", ".sh", ".ps1", ".cmd", ".bat", ".py",
]);

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const problems = [];

// ---------------------------------------------------------------- 收集密钥
const keys = [];
if (existsSync(STORE)) {
  try {
    const store = JSON.parse(readFileSync(STORE, "utf8"));
    const k = store?.settings?.credentials?.glm?.apiKey;
    if (typeof k === "string" && k.length >= 16) keys.push({ where: "data/store.json", value: k });
  } catch (error) {
    console.log(`note: could not parse data/store.json (${error.message}) — skipping live-key checks`);
  }
}
for (const name of ["GLM_API_KEY", "ZHIPU_API_KEY", "ZHIPUAI_API_KEY"]) {
  const v = process.env[name];
  if (typeof v === "string" && v.length >= 16) keys.push({ where: `env:${name}`, value: v });
}

console.log("=== 1. 待检查的密钥（只显示指纹） ===");
if (keys.length === 0) {
  console.log("  没有找到可用的密钥 —— 只会做「密钥形态」扫描。");
} else {
  for (const k of keys) {
    console.log(`  ${k.where}: length=${k.value.length} sha256:${sha(k.value)} head4=${k.value.slice(0, 4)}*** tail4=***${k.value.slice(-4)}`);
  }
}

// ------------------------------------------------- 取出「真正会被提交」的文件
function listWithGit() {
  const out = join(tmpdir(), `check-secrets-${process.pid}.txt`);
  const fd = openSync(out, "w");
  try {
    execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: ROOT,
      stdio: ["ignore", fd, "ignore"], // 关键：stdout 直接写文件，不走管道
    });
  } finally {
    closeSync(fd);
  }
  const raw = readFileSync(out, "utf8");
  unlinkSync(out);
  return raw.split("\0").map((s) => s.trim()).filter(Boolean);
}

let files = [];
let mode = "";
try {
  execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: ROOT, stdio: "ignore" });
  files = listWithGit();
  mode = "git（遵守 .gitignore 后的提交清单）";
} catch {
  mode = "文件系统遍历（还没有 git 仓库）";
  const SKIP = new Set(["node_modules", ".git", ".pnpm-store", ".dsh-asar"]);
  const walk = (dir, acc = []) => {
    for (const name of readdirSafe(dir)) {
      if (SKIP.has(name)) continue;
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, acc);
      else acc.push(relative(ROOT, p).replaceAll("\\", "/"));
    }
    return acc;
  };
  files = walk(ROOT);
}

function readdirSafe(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

console.log(`\n=== 2. 扫描范围：${files.length} 个文件 —— ${mode} ===`);

// -------------------------------------------------------------- 禁止清单
console.log("\n=== 3. 禁止提交的路径 ===");
for (const bad of FORBIDDEN) {
  const hit = files.filter((f) => f === bad || f.startsWith(`${bad}/`));
  if (hit.length > 0) {
    problems.push(`禁止提交的路径混进来了：${bad}（${hit.length} 个文件）`);
    console.log(`  ✗ ${bad}  —— ${hit.length} 个文件`);
    for (const f of hit.slice(0, 5)) console.log(`      ${f}`);
  } else {
    console.log(`  ✓ ${bad}  —— 不在清单里`);
  }
}
if (files.length > 0 && !existsSync(join(ROOT, ".gitignore"))) {
  problems.push("没有找到 .gitignore");
}

// ------------------------------------------------------------------ 内容扫描
const GENERIC = [
  { name: "智谱形态 id.secret", re: /[0-9a-zA-Z]{16,}\.[0-9a-zA-Z]{16,}/g },
  { name: "OpenAI 形态 sk-", re: /sk-[A-Za-z0-9_-]{20,}/g },
  { name: "Google 形态 AIza", re: /AIza[0-9A-Za-z_-]{30,}/g },
  { name: "AWS 形态 AKIA", re: /AKIA[0-9A-Z]{16}/g },
  { name: "GitHub token", re: /gh[pousr]_[A-Za-z0-9]{30,}/g },
];

console.log("\n=== 4. 逐文件内容扫描 ===");
let scanned = 0;
for (const rel of files) {
  if (!TEXT_EXT.has(extname(rel).toLowerCase())) continue;
  const abs = join(ROOT, rel);
  let text;
  try {
    if (statSync(abs).size > 8 * 1024 * 1024) continue;
    text = readFileSync(abs, "utf8");
  } catch { continue; }
  scanned += 1;

  for (const k of keys) {
    if (text.includes(k.value)) {
      problems.push(`${rel} 包含完整密钥（来自 ${k.where}）`);
      console.log(`  ✗ ${rel} —— 包含完整密钥！`);
    } else if (text.includes(k.value.slice(0, 12)) || text.includes(k.value.slice(-12))) {
      problems.push(`${rel} 包含密钥的一部分`);
      console.log(`  ✗ ${rel} —— 包含密钥的头/尾片段！`);
    }
  }

  for (const g of GENERIC) {
    g.re.lastIndex = 0;
    const m = text.match(g.re);
    if (m) {
      problems.push(`${rel} 出现疑似密钥（${g.name}）`);
      console.log(`  ✗ ${rel} —— ${g.name} x${m.length}：${m[0].slice(0, 4)}…(${m[0].length})`);
    }
  }

  const apiKeys = text.match(/"apiKey"\s*:\s*"([^"]{8,})"/g);
  if (apiKeys) {
    problems.push(`${rel} 里有非空的 "apiKey"`);
    console.log(`  ✗ ${rel} —— 有非空 apiKey：${apiKeys.length} 处`);
  }
}
console.log(`  已扫描 ${scanned} 个文本文件`);

// -------------------------------------------------------------------- 结论
console.log("\n=== 结论 ===");
if (problems.length === 0) {
  console.log("  ✅ 通过：没有发现密钥，也没有发现不该提交的路径。可以 commit / push。");
  process.exit(0);
}
console.log(`  ❌ 发现 ${problems.length} 个问题，已阻止提交：`);
for (const p of problems) console.log(`     - ${p}`);
console.log("\n  修正办法：把对应路径加进 .gitignore，然后执行");
console.log("     git rm --cached <路径>     （只从 Git 移除，不删本地文件）");
process.exit(1);
