/**
 * 安装一个 Git 钩子：每次 `git commit` 之前自动运行密钥检查。
 * 装好之后，就算你忘了手动检查，也推不出密钥。
 *
 *     tools\node.cmd tools\install-git-hooks.mjs
 *
 * 生成的文件是 .git\hooks\pre-commit；它不会被提交到 GitHub（.git 目录本身不参与
 * 版本控制），所以每位协作者 clone 之后都要自己跑一次这个脚本。
 */

import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const GIT = join(ROOT, ".git");
const HOOKS = join(GIT, "hooks");
const HOOK = join(HOOKS, "pre-commit");

if (!existsSync(GIT)) {
  console.log(`没有找到 ${GIT} —— 请先执行：`);
  console.log("   git init -b main");
  process.exit(1);
}

// 用 LF 换行：Windows 上 Git 自带的 sh 能正确执行 LF 脚本
const body = `#!/bin/sh
# 由 tools/install-git-hooks.mjs 自动生成 —— 提交前检查密钥。
# 想临时跳过：git commit --no-verify  （不推荐）

if command -v node >/dev/null 2>&1; then
	exec node tools/check-secrets.mjs
fi

if [ -f tools/node.cmd ]; then
	echo "check-secrets: 用 tools/node.cmd 运行..."
	exec cmd //c tools\\\\node.cmd tools\\\\check-secrets.mjs
fi

echo "check-secrets: 找不到 node，本次跳过密钥检查！"
echo "请手动运行：tools\\\\node.cmd tools\\\\check-secrets.mjs"
exit 0
`;

mkdirSync(HOOKS, { recursive: true });
writeFileSync(HOOK, body.replace(/\r\n/g, "\n"), "utf8");
try { chmodSync(HOOK, 0o755); } catch { /* Windows 上无所谓 */ }

console.log(`已安装提交前钩子：${HOOK}`);
console.log("");
console.log("现在每次 git commit 都会先跑一遍密钥检查；发现问题就中止提交。");
console.log("验证一下：先随便改一个文件，git add 之后 git commit，应当能看到检查输出。");
