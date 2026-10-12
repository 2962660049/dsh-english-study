/**
 * Environment check for the 「英语学习小助手」 workspace.
 *
 * Run:  node tools/check-env.mjs        (use the bundled node; see tools/node.cmd)
 *
 * Verifies every external dependency the project needs, so a failure here is
 * always a configuration problem and never a mystery later during development.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKSPACE = path.resolve(HERE, '..')

const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const DSH_INSTALL = 'D:\\deepseek harness'
const DSH_ASAR = path.join(DSH_INSTALL, 'resources', 'app.asar')
const DSH_CLI = path.join(DSH_INSTALL, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd')
const BUNDLED_NODE = path.join(
  DSH_HOME,
  'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe',
)
const BUNDLED_PNPM = path.join(
  DSH_HOME,
  'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs',
)
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', process.env.DSH_PROFILE ?? 'desktop')

const results = []
const record = (area, name, ok, detail) => results.push({ area, name, ok, detail })

function probe(area, name, fn) {
  try {
    const detail = fn()
    record(area, name, true, detail)
  } catch (error) {
    record(area, name, false, error.message)
  }
}

function assertFile(p, label) {
  if (!fs.existsSync(p)) throw new Error(`${label} missing: ${p}`)
  return p
}

// ---------------------------------------------------------------- runtime
probe('runtime', 'node version', () => {
  const major = Number(process.versions.node.split('.')[0])
  if (major < 22) throw new Error(`need Node >= 22.19, got ${process.versions.node}`)
  return `v${process.versions.node}`
})

probe('runtime', 'bundled node exists', () => assertFile(BUNDLED_NODE, 'bundled node'))
probe('runtime', 'bundled pnpm exists', () => assertFile(BUNDLED_PNPM, 'bundled pnpm'))

// Read the version from the bundled pnpm manifest rather than spawning it.
// Spawning with captured stdio hits the DSH sandbox's EPERM (named pipes are
// unavailable in confined modes), which would report a false failure here.
// Live invocation is exercised separately through tools/pnpm.cmd.
probe('runtime', 'pnpm version', () => {
  const manifest = path.join(path.dirname(path.dirname(BUNDLED_PNPM)), 'package.json')
  const version = JSON.parse(fs.readFileSync(assertFile(manifest, 'pnpm manifest'), 'utf8')).version
  if (!version.startsWith('11.')) throw new Error(`expected pnpm 11.x, got ${version}`)
  return `pnpm ${version} (manifest; live run via tools/pnpm.cmd)`
})

// ---------------------------------------------------------------- dsh app
probe('dsh', 'install dir', () => assertFile(DSH_INSTALL, 'DSH install'))
probe('dsh', 'app.asar', () => {
  const p = assertFile(DSH_ASAR, 'app.asar')
  const mb = (fs.statSync(p).size / 1024 / 1024).toFixed(1)
  return `${mb} MB`
})
probe('dsh', 'cli launcher', () => assertFile(DSH_CLI, 'dsh.cmd'))
probe('dsh', 'profile dir', () => assertFile(PROFILE_DIR, 'DSH profile'))
probe('dsh', 'profile manifest', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, 'package.json'), 'utf8'))
  const bundles = manifest?.dsh?.profile?.bundles ?? []
  return `${bundles.length} bundles: ${bundles.slice(0, 4).join(', ')}${bundles.length > 4 ? ', …' : ''}`
})
probe('dsh', 'plugin dev deps in profile', () => {
  const nm = path.join(PROFILE_DIR, 'node_modules')
  const found = fs.existsSync(nm)
    ? fs.readdirSync(nm).filter((n) => n.startsWith('dsh-') || n.startsWith('@deepseek-ai'))
    : []
  if (found.length === 0) throw new Error('no dsh plugins resolved in profile node_modules')
  return `${found.length} entries`
})

// ---------------------------------------------------------------- workspace
probe('workspace', 'root', () => {
  if (!fs.existsSync(WORKSPACE)) throw new Error(`missing ${WORKSPACE}`)
  return WORKSPACE
})
probe('workspace', 'writable', () => {
  const probeFile = path.join(WORKSPACE, '.write-probe')
  fs.writeFileSync(probeFile, String(Date.now()))
  fs.unlinkSync(probeFile)
  return 'write+delete ok'
})
for (const dir of ['data', 'data/diary', 'data/images', 'data/cache', 'docs', 'packages']) {
  probe('workspace', `dir ${dir}`, () => {
    const p = path.join(WORKSPACE, dir)
    fs.mkdirSync(p, { recursive: true })
    return 'present'
  })
}

// ---------------------------------------------------------------- network
const netChecks = [
  ['npm registry', 'https://registry.npmjs.org/-/ping'],
  ['volcengine ark (doubao)', 'https://ark.cn-beijing.volces.com/api/v3/models'],
  ['deepseek api', 'https://api.deepseek.com/v1/models'],
]
for (const [label, url] of netChecks) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    .then((res) => ({ ok: true, detail: `HTTP ${res.status}` }))
    .catch((error) => ({ ok: false, detail: error.message }))
  // 401/403 proves reachability (auth is a separate concern).
  const reachable = r.ok || /^HTTP (401|403)$/.test(r.detail)
  record('network', label, reachable, r.detail)
}

// ---------------------------------------------------------------- credentials
probe('credentials', 'deepseek api key in DSH', () => {
  const f = path.join(DSH_HOME, '.credentials.yaml')
  if (!fs.existsSync(f)) throw new Error('no .credentials.yaml')
  const text = fs.readFileSync(f, 'utf8')
  if (!/DEEPSEEK_API_KEY\s*:/.test(text)) throw new Error('DEEPSEEK_API_KEY not registered')
  return 'present (value not read)'
})
probe('credentials', 'doubao/ark api key', () => {
  const f = path.join(DSH_HOME, '.credentials.yaml')
  const text = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
  const fromEnv = process.env.ARK_API_KEY ?? process.env.DOUBAO_API_KEY
  if (fromEnv) return 'present in environment'
  if (/ark|volc|doubao/i.test(text) === false) {
    throw new Error('NOT configured — must be supplied via plugin settings before Doubao features work')
  }
  return 'present in DSH credentials'
})

// ---------------------------------------------------------------- report
const byArea = new Map()
for (const r of results) {
  if (!byArea.has(r.area)) byArea.set(r.area, [])
  byArea.get(r.area).push(r)
}

let failed = 0
for (const [area, rows] of byArea) {
  console.log(`\n[${area}]`)
  for (const r of rows) {
    if (!r.ok) failed += 1
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(28)} ${r.detail}`)
  }
}

console.log(`\n${results.length - failed}/${results.length} checks passed`)
if (failed > 0) {
  console.log(`${failed} check(s) need attention (see FAIL lines above)`)
  process.exitCode = 1
}
