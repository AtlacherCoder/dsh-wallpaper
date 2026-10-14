/**
 * dsh-wallpaper usage-fold verification.
 *
 * The panel's numbers are only worth reading if they can be reproduced from the
 * raw session log by hand. This test does exactly that: it decompresses real
 * session logs, folds `assistant/message` usage with an independent
 * implementation written here, prices it with the published DeepSeek table, and
 * requires the plugin's own fold to agree — field by field.
 *
 * Money is deliberately NOT part of this test any more: the plugin no longer
 * estimates cost, so there is no derived value left to cross-check. The
 * independent `totalTokens` below is the one aggregate that is not itself a
 * logged field, which keeps a second derivation of the same numbers in play.
 *
 *   node tools/usage-fold-test.mjs             # live-session fold, 4 logs
 *   node tools/usage-fold-test.mjs 6           # check six of them
 *   node tools/usage-fold-test.mjs --disk 4    # the on-disk fallback path
 *
 * The two modes exercise the two sources the host reads: `live` folds a
 * Session-like object with the events already in memory, `disk` lets the plugin
 * discover and decompress the newest logs by itself — the path a freshly
 * restarted process takes, where the in-memory store is empty.
 *
 * It also prints the peak/off-peak split that the estimate depends on, since a
 * wrong split is the one way this estimate could be silently off by 2x.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const SESSION_ROOT = join(homedir(), '.dsh', 'sessions')
const MODE = process.argv[2] === '--disk' ? 'disk' : 'live'
const LIMIT = Number(process.argv[MODE === 'disk' ? 3 : 2] ?? 4)

const BEIJING = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour12: false, weekday: 'short', hour: 'numeric', minute: 'numeric' })

/** Independent peak test: weekday 09:00–12:00 or 14:00–18:00 in Beijing. */
function peak(timeMs) {
  const parts = Object.fromEntries(BEIJING.formatToParts(new Date(timeMs)).map((part) => [part.type, part.value]))
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false
  const minutes = Number(parts.hour) * 60 + Number(parts.minute)
  return (minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1080)
}

/** One session log is a run of independent zstd frames. */
function readLog(path) {
  const buffer = readFileSync(path)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const parts = []
  let offset = 0
  while (offset < buffer.length) {
    try {
      parts.push(zstdDecompressSync(buffer.subarray(offset)))
    } catch {
      break
    }
    const next = buffer.indexOf(magic, offset + 4)
    if (next < 0) break
    offset = next
  }
  return Buffer.concat(parts).toString('utf8')
}

/** Every session log with at least one usage record, newest file first. */
function logsWithUsage() {
  const found = []
  for (const workspace of readdirSync(SESSION_ROOT)) {
    const workspacePath = join(SESSION_ROOT, workspace)
    let sessions = []
    try {
      sessions = readdirSync(workspacePath)
    } catch {
      continue
    }
    for (const session of sessions) {
      const file = join(workspacePath, session, 'session.v3.jsonl.zstd')
      let info
      try {
        info = statSync(file)
      } catch {
        continue
      }
      let text
      try {
        text = readLog(file)
      } catch {
        continue
      }
      if (!text.includes('"usage"')) continue
      found.push({ file, text, mtime: info.mtimeMs, session })
    }
  }
  found.sort((left, right) => right.mtime - left.mtime)
  return found
}

/** The truth: fold and price one log without touching plugin code. */
function expected(text) {
  const totals = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, totalTokens: 0, steps: 0, peakTokens: 0, offPeakTokens: 0,
  }
  let model = null
  let lastTime = 0
  for (const line of text.split('\n')) {
    if (line === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const data = event.data ?? {}
    if (event.type === 'request/header' && typeof data.header?.config?.model === 'string') model = data.header.config.model
    if (event.type === 'request/context' && typeof data.model === 'string') model = data.model
    if (event.type !== 'assistant/message' || data.usage === undefined) continue
    const usage = data.usage
    const input = Number(usage.inputTokens) || 0
    const output = Number(usage.outputTokens) || 0
    totals.inputTokens += input
    totals.outputTokens += output
    totals.cacheReadTokens += Number(usage.cacheReadTokens) || 0
    totals.cacheWriteTokens += Number(usage.cacheWriteTokens) || 0
    totals.reasoningTokens += Number(usage.reasoningTokens) || 0
    totals.steps += 1
    if (peak(Number(event.time))) totals.peakTokens += input + output
    else totals.offPeakTokens += input + output
    lastTime = Math.max(lastTime, Number(event.time) || 0)
  }
  totals.totalTokens = totals.inputTokens + totals.outputTokens
  return { totals, model, lastTime }
}

const plugin = await import(new URL('../dsh-wallpaper/lib/index.js', import.meta.url).href)
const provided = new Map()
const ctx = {
  get: (name) => provided.get(name),
  provide: (name, value) => provided.set(name, value),
  on: () => () => {},
  effect: (callback) => { callback(); return () => {} },
  webServer: { register: () => () => {} },
}
process.env.DSH_WALLPAPER_HOME ??= '/tmp/dsh-wallpaper-fold-test'
plugin.apply(ctx)
const face = provided.get('wallpaper')

const candidates = logsWithUsage().slice(0, LIMIT)
if (candidates.length === 0) {
  console.log('no session logs with usage found under ~/.dsh/sessions')
  process.exit(1)
}

let failed = 0
for (const candidate of candidates) {
  const want = expected(candidate.text)
  // The plugin folds through a Session-like object: only id/header/snapshotEvents are used.
  const events = candidate.text.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
  const session = {
    id: candidate.session,
    header: { id: candidate.session, createdAt: 0, cwd: null },
    seq: events.reduce((max, event) => Math.max(max, Number(event.seq) ?? -1), -1),
    snapshotEvents: () => events,
  }
  // Exercise the plugin through its own service face, exactly as the GUI does.
  const got = MODE === 'disk'
    ? face.sessionUsage().sessions.find((row) => row.id === candidate.session)
    : face.sessionUsage([session]).sessions[0]

  if (got === undefined) {
    failed += 1
    console.log(`FAIL  ${candidate.session}  not present in the plugin's usage payload (mode ${MODE})`)
    continue
  }

  const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens', 'steps', 'peakTokens', 'offPeakTokens']
  const mismatch = fields.filter((field) => got[field] !== want.totals[field])
  const ok = mismatch.length === 0 && got.model === want.model
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${candidate.session}  steps=${want.totals.steps}  model=${want.model}`)
  console.log(`      input ${want.totals.inputTokens.toLocaleString('en-US')} · output ${want.totals.outputTokens.toLocaleString('en-US')} · cacheRead ${want.totals.cacheReadTokens.toLocaleString('en-US')} · reasoning ${want.totals.reasoningTokens.toLocaleString('en-US')}`)
  console.log(`      peak ${want.totals.peakTokens.toLocaleString('en-US')} tok / off-peak ${want.totals.offPeakTokens.toLocaleString('en-US')} tok  (peak share ${(want.totals.totalTokens > 0 ? want.totals.peakTokens / want.totals.totalTokens : 0).toFixed(4)})`)
  console.log(`      plugin total ${got.totalTokens.toLocaleString('en-US')} tok   ${mismatch.length === 0 ? 'fields agree' : `MISMATCH: ${mismatch.map((field) => `${field} want ${want.totals[field]} got ${got[field]}`).join(', ')}`}`)
  if (got.model !== want.model) console.log(`      model mismatch: want ${want.model} got ${got.model}`)
}

console.log(failed === 0 ? `\nALL ${candidates.length} SESSION LOGS REPRODUCED EXACTLY (${MODE} path)` : `\n${failed} OF ${candidates.length} LOGS DISAGREE`)
process.exit(failed === 0 ? 0 : 1)
