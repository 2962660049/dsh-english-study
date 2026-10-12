/**
 * 从你本机的 data\store.json 生成一份**可以公开提交**的示例数据文件
 * data\store.example.json：清空 API Key、清空日记与词库，只保留结构和默认设置。
 *
 *     tools\node.cmd tools\make-example-store.mjs
 *
 * 为什么需要它：首次 clone 的人没有 store.json，程序会自己重建一个空白的；
 * 但把 example 文件放进去，别人一眼就能看懂数据长什么样、Key 该填在哪个字段。
 *
 * 这个脚本**从不打印密钥**，只报告「清空前 / 清空后」的长度。
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SOURCE = join(ROOT, "data", "store.json");
const TARGET = join(ROOT, "data", "store.example.json");

if (!existsSync(SOURCE)) {
  console.log(`没有找到 ${SOURCE} —— 先运行一次程序让它生成，再执行本脚本。`);
  process.exit(1);
}

const store = JSON.parse(readFileSync(SOURCE, "utf8"));

const before = String(store?.settings?.credentials?.glm?.apiKey ?? "").length;
if (store.settings?.credentials?.glm) {
  store.settings.credentials.glm = { ...store.settings.credentials.glm, apiKey: "" };
}
const after = String(store?.settings?.credentials?.glm?.apiKey ?? "").length;

// 清空全部个人数据，只留结构
store.diary = [];
store.vocabEvents = [];
store.vocabWords = [];
store.ledger = [];
store.createdAt = new Date(0).toISOString();
store.updatedAt = new Date(0).toISOString();
store.updatedAt = store.createdAt;

writeFileSync(TARGET, `${JSON.stringify(store, null, 2)}\n`, "utf8");

console.log(`apiKey 长度：${before} -> ${after}${after === 0 ? "  ✓" : "  ✗ 请检查！"}`);
console.log(`diary / vocabEvents / vocabWords / ledger：全部清空`);
console.log(`已写出 ${TARGET}`);
console.log("");
console.log("提交前请再确认一次：");
console.log(`  - ${TARGET} 里 apiKey 是空字符串`);
console.log("  - data/store.json（真身）没有被 git 记录");
