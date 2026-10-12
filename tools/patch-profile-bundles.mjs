/**
 * Register the plugin in a DSH profile's bundle list.
 *
 * `dsh plugin --profile <p> add <dir>` only adds a dependency line to the profile
 * package.json; the bundle channel that actually loads a plugin is driven by
 * `dsh.profile.bundles`, so the name has to be appended there too.
 *
 *   tools\node.cmd tools\patch-profile-bundles.mjs <profileDir> [packageName]
 */

import { readFile, writeFile, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const profileDir = process.argv[2];
const packageName = process.argv[3] ?? "dsh-english-study";

if (profileDir === undefined) {
  console.error("usage: node patch-profile-bundles.mjs <profileDir> [packageName]");
  process.exit(2);
}

const manifestPath = join(resolve(profileDir), "package.json");
const raw = await readFile(manifestPath, "utf8");
const manifest = JSON.parse(raw);

manifest.dsh ??= {};
manifest.dsh.profile ??= {};
manifest.dsh.profile.bundles ??= [];

if (manifest.dsh.profile.bundles.includes(packageName)) {
  console.log(`already registered: ${packageName}`);
} else {
  manifest.dsh.profile.bundles.push(packageName);
  await copyFile(manifestPath, `${manifestPath}.bak-english-study`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`registered: ${packageName}`);
}

console.log(`dependencies.${packageName} = ${manifest.dependencies?.[packageName] ?? "(missing)"}`);
console.log(`bundles = ${JSON.stringify(manifest.dsh.profile.bundles)}`);
