// Minimal asar archive reader/validator + targeted extractor.
// Usage:
//   node asar-list.mjs <archive> list <prefixRegex> [limit]
//   node asar-list.mjs <archive> extract <prefix> <outDir> [limit] [maxSize]
//
// NOTE: `list` prints up to <limit> lines (default 400). Always pass a small
// limit — a broad regex dumps tens of KB straight into the agent context.
// Use `extract` to pull files to disk instead; extraction costs no context.
import fs from 'node:fs'
import path from 'node:path'

const [archive, cmd, arg, outDirArg, limitArg, maxSizeArg] = process.argv.slice(2)
if (!archive || !cmd) {
  console.error('usage: node asar-list.mjs <archive> list|extract <prefix> [outDir] [limit] [maxSize]')
  process.exit(2)
}

const fd = fs.openSync(archive, 'r')
const sizeBuf = Buffer.alloc(16)
fs.readSync(fd, sizeBuf, 0, 16, 0)
const headerJsonSize = sizeBuf.readUInt32LE(12)
const headerBuf = Buffer.alloc(headerJsonSize)
fs.readSync(fd, headerBuf, 0, headerJsonSize, 16)
const header = JSON.parse(headerBuf.toString('utf8'))
const baseOffset = 16 + headerJsonSize

/** Walk the asar header into a flat list of {path, size, offset, unpacked}. */
function walk(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const full = prefix ? `${prefix}/${name}` : name
    if (entry.files) walk(entry, full, out)
    else out.push({ path: full, size: entry.size ?? 0, offset: entry.offset, unpacked: !!entry.unpacked })
  }
  return out
}

const all = walk(header, '', [])
const re = new RegExp(arg ?? '.', 'i')
const limit = limitArg ? Number(limitArg) : 400

if (cmd === 'list') {
  const hits = all.filter((f) => re.test(f.path))
  console.log(`archive=${archive}`)
  console.log(`total entries=${all.length}  matched=${hits.length}`)
  for (const f of hits.slice(0, limit)) console.log(`${String(f.size).padStart(10)}  ${f.path}`)
  if (hits.length > limit) console.log(`... ${hits.length - limit} more`)
} else if (cmd === 'extract') {
  const outDir = outDirArg
  if (!outDir) { console.error('extract needs outDir'); process.exit(2) }
  const maxSize = maxSizeArg ? Number(maxSizeArg) : Infinity
  const hits = all.filter((f) => f.path.startsWith(arg))
  let n = 0
  let skipped = 0
  let bytes = 0
  for (const f of hits) {
    if (n >= limit) break
    if (f.size > maxSize) { skipped++; continue }
    const dest = path.join(outDir, f.path.slice(arg.length).replace(/^\//, ''))
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    if (f.unpacked) {
      // Stored outside the asar; skip silently (caller reads from .unpacked dir).
      n++
      continue
    }
    const buf = Buffer.alloc(f.size)
    if (f.size > 0) fs.readSync(fd, buf, 0, f.size, baseOffset + Number(f.offset))
    fs.writeFileSync(dest, buf)
    bytes += f.size
    n++
  }
  console.log(`extracted ${n} files (${(bytes / 1024).toFixed(0)} KB) from ${arg} -> ${outDir}`)
  if (skipped) console.log(`skipped ${skipped} file(s) larger than ${maxSize} bytes`)
} else {
  console.error(`unknown cmd ${cmd}`)
  process.exit(2)
}
fs.closeSync(fd)
