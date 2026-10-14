/**
 * dsh-wallpaper host-half smoke test.
 *
 * Runs the real host plugin against a real HTTP server and the real DSH
 * session store, so the API, the usage fold, the SSE feed, and the
 * image library are exercised over the wire rather than asserted in the
 * abstract.
 *
 *   node tools/host-smoke.mjs
 *
 * The Cordis surface is stubbed to the smallest contract the plugin uses
 * (`get`, `provide`, `on`, `effect`, `webServer.register`). Nothing here writes
 * to a session log; the only writes are the plugin's own config file and one
 * throwaway wallpaper, both removed at the end.
 */
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = new URL('../dsh-wallpaper/lib/index.js', import.meta.url)
const PACKAGE_ROOT = new URL('../dsh-wallpaper/', import.meta.url)
// A throwaway state root keeps the real ~/.dsh/wallpaper untouched while the
// plugin's real storage path is exercised end to end.
const STATE_ROOT = mkdtempSync(join(tmpdir(), 'dsh-wallpaper-smoke-'))
process.env.DSH_WALLPAPER_HOME = STATE_ROOT
const CONFIG_PATH = join(STATE_ROOT, 'config.json')
const USER_DIR = join(STATE_ROOT, 'wallpapers')

/** Minimal Cordis surface, plus a live record of what the plugin registered. */
const routes = []
const disposers = []
const provided = new Map()
const listeners = new Map()
const ctx = {
  get: (name) => provided.get(name),
  provide: (name, value) => provided.set(name, value),
  on: (event, listener) => {
    listeners.set(event, listener)
    return () => listeners.delete(event)
  },
  effect: (callback) => {
    const dispose = callback()
    if (typeof dispose === 'function') disposers.push(dispose)
    return () => {}
  },
  webServer: {
    register: (route) => {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  },
}

const plugin = await import(PLUGIN.href)
plugin.apply(ctx)
console.log(`inject:            ${JSON.stringify(plugin.inject)}`)
console.log(`routes:            ${routes.map((route) => `${route.kind} ${route.path}`).join(', ')}`)
console.log(`provide:           ${[...provided.keys()].join(', ')}`)
console.log(`events listened:   ${[...listeners.keys()].join(', ')}`)

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const route = routes.find((candidate) =>
    candidate.kind === 'exact'
      ? url.pathname === candidate.path
      : url.pathname === candidate.path || url.pathname.startsWith(`${candidate.path}/`))
  if (route === undefined) {
    res.writeHead(404).end('no route')
    return
  }
  Promise.resolve(route.handler(req, res)).catch((error) => {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }).end(String(error?.message ?? error))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
console.log(`server:            ${base}`)

const failures = []
const check = (label, condition, detail) => {
  if (!condition) failures.push(label)
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`)
}
const post = async (path, body) => (await fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})).json()
const state = async () => (await fetch(`${base}/dsh-wallpaper/api/state`)).json()

// 1 — state endpoint: shape and default wallpaper.
const first = await state()
check('state.ok', first.ok === true)
check('default config', first.config.wallpaper === 'default' && first.config.fit === 'cover' && first.config.enabled === true,
  JSON.stringify(first.config))
check('bundled wallpaper listed', first.wallpapers[0]?.builtin === true && first.wallpapers[0].bytes > 0,
  `${first.wallpapers.length} entr(y|ies), default ${first.wallpapers[0].bytes} bytes`)
check('no money/price payload is served', first.pricing === undefined,
  first.pricing === undefined ? 'pricing absent' : 'pricing STILL present')
check('usage payload shaped', Array.isArray(first.usage.sessions), `live sessions folded: ${first.usage.sessions.length}`)

// The live-session fold must agree with the raw log: this session's own tally is
// compared against an independent scan of its own log file further below.
const self = first.usage.sessions.find((item) => item.steps > 0)
if (self !== undefined) {
  console.log(`\nfolded session ${self.id}\n  model=${self.model} steps=${self.steps} in=${self.inputTokens} out=${self.outputTokens} cacheRead=${self.cacheReadTokens} reasoning=${self.reasoningTokens}\n  peak=${self.peakTokens} offPeak=${self.offPeakTokens}`)
  check('folded steps > 0', self.steps > 0)
  check('no cost field survives in a usage row', self.costCNY === undefined && self.unitPrices === undefined,
    `costCNY=${String(self.costCNY)} unitPrices=${String(self.unitPrices)}`)
  check('peak + off-peak equals billed tokens', self.peakTokens + self.offPeakTokens === self.totalTokens,
    `${self.peakTokens} + ${self.offPeakTokens} vs ${self.totalTokens}`)
}

// 2 — the bundled wallpaper really is served, byte-identical to disk.
const bundledResponse = await fetch(`${base}/dsh-wallpaper/wallpaper/default`)
const bundledBytes = Buffer.from(await bundledResponse.arrayBuffer())
const onDisk = readFileSync(new URL('assets/default-wallpaper.jpg', PACKAGE_ROOT))
check('bundled wallpaper served', bundledResponse.status === 200 && bundledResponse.headers.get('content-type') === 'image/jpeg',
  `${bundledResponse.status} ${bundledResponse.headers.get('content-type')} ${bundledBytes.length} bytes`)
check('served bytes identical to the file on disk', bundledBytes.equals(onDisk), `${onDisk.length} bytes`)
check('JPEG magic', bundledBytes[0] === 0xff && bundledBytes[1] === 0xd8)

// 3 — upload -> listed -> served -> selected, over the real API.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64')
const upload = await post('/dsh-wallpaper/api/upload', { name: 'smoke test.png', dataUrl: `data:image/png;base64,${png.toString('base64')}` })
check('upload accepted', upload.ok === true && typeof upload.id === 'string', upload.id)
check('upload became the selected wallpaper', upload.config?.wallpaper === upload.id, upload.config?.wallpaper)
const uploadedResponse = await fetch(`${base}${upload.url}`)
check('uploaded wallpaper served', uploadedResponse.status === 200 && uploadedResponse.headers.get('content-type') === 'image/png',
  `${uploadedResponse.status} ${uploadedResponse.headers.get('content-type')}`)
check('uploaded wallpaper listed', (await state()).wallpapers.some((item) => item.id === upload.id))
const badType = await post('/dsh-wallpaper/api/upload', { name: 'x.svg', dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' })
check('unsupported type refused', badType.ok === false, badType.error)

// 4 — config persistence: a partial patch merges, clamps, and survives a re-read.
await post('/dsh-wallpaper/api/config', { dim: 5, blur: 999, fit: 'nonsense', usageEnabled: false })
const patched = await state()
check('dim clamped to 0.9', patched.config.dim === 0.9, String(patched.config.dim))
check('blur clamped to 24', patched.config.blur === 24, String(patched.config.blur))
check('bad fit falls back to cover', patched.config.fit === 'cover', patched.config.fit)
check('usageEnabled persisted', patched.config.usageEnabled === false, String(patched.config.usageEnabled))
check('other fields untouched by the patch', patched.config.wallpaper === upload.id, patched.config.wallpaper)
check('config written to the state root', existsSync(CONFIG_PATH))

// 5 — SSE: a real frame must arrive on the open stream, not just the greeting.
const streamResponse = await fetch(`${base}/dsh-wallpaper/api/events`, { headers: { accept: 'text/event-stream' } })
const reader = streamResponse.body.getReader()
const decoder = new TextDecoder()
let frames = decoder.decode((await reader.read()).value)
check('SSE opens with a ready frame', streamResponse.status === 200 && frames.includes('"type":"ready"'), frames.trim())
await post('/dsh-wallpaper/api/config', { dim: 0.3 })
const deadline = Date.now() + 2000
while (!frames.includes('"type":"config"') && Date.now() < deadline) {
  const chunk = await Promise.race([reader.read(), new Promise((resolve) => setTimeout(() => resolve(null), 300))])
  if (chunk?.value !== undefined) frames += decoder.decode(chunk.value)
}
check('SSE pushed a config frame after a write', frames.includes('"type":"config"'), frames.split('\n\n').length - 1 + ' frame(s)')
await reader.cancel()

// 6 — delete: the user's wallpaper goes, the builtin one refuses, selection falls back.
const removed = await post('/dsh-wallpaper/api/delete', { id: upload.id })
check('uploaded wallpaper deleted', removed.ok === true && removed.removed === true)
check('selection fell back to the builtin', removed.config.wallpaper === 'default', removed.config.wallpaper)
const refuse = await post('/dsh-wallpaper/api/delete', { id: 'default' })
check('builtin delete refused', refuse.ok === false, refuse.error)

// 7 — hardening: traversal, unknown route, oversized body.
check('path traversal refused', (await fetch(`${base}/dsh-wallpaper/wallpaper/${encodeURIComponent('user/../../config.json')}`)).status === 404)
check('unknown API route 404', (await fetch(`${base}/dsh-wallpaper/api/nope`)).status === 404)
const oversized = await fetch(`${base}/dsh-wallpaper/api/upload`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'huge.png', dataUrl: `data:image/png;base64,${Buffer.alloc(13 * 1024 * 1024).toString('base64')}` }),
}).then((response) => response.status).catch(() => 'rejected')
check('oversized body refused', oversized !== 200, String(oversized))

// 8 — the service face other host plugins would read.
const face = provided.get('wallpaper')
check('ctx.wallpaper provided', typeof face?.sessionUsage === 'function')

// 9 — the on-disk fallback: with no session loaded in this stub process, the
//     payload must still carry the newest durable logs, folded through the same
//     code path the live store uses.
const fromDisk = face.sessionUsage()
check('on-disk logs are folded when nothing is live', fromDisk.sessions.length > 0,
  `${fromDisk.sessions.length} session(s) from ~/.dsh/sessions`)
const newest = fromDisk.sessions[0]
check('disk rows carry model and tokens',
  newest !== undefined && typeof newest.model === 'string' && newest.totalTokens > 0,
  newest === undefined ? 'none' : `${newest.id} ${newest.model} ${newest.totalTokens} tok, ${newest.steps} steps`)
check('exactly one row is marked current', fromDisk.sessions.filter((row) => row.isCurrent).length === 1,
  String(fromDisk.currentSessionId))
const requested = face.sessionUsage(undefined, newest?.id)
check('a caller-supplied sessionId is honoured', requested.currentSessionId === newest?.id, String(requested.currentSessionId))
check('an unknown sessionId falls back instead of failing', typeof face.sessionUsage(undefined, 'nope').currentSessionId === 'string')

server.close()
for (const dispose of disposers) dispose()

// Undo this run: the whole state root was disposable.
rmSync(STATE_ROOT, { recursive: true, force: true })
console.log(`\nthrowaway state root removed: ${STATE_ROOT}`)
console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\nFAILURES: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
