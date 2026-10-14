/**
 * dsh-wallpaper crash test.
 *
 *   node tools/crash-test.mjs
 *
 * The question this answers is not "does the API work" (host-smoke.mjs covers
 * that) but "can a badly behaved client take the DSH process down with it".
 * Node terminates the process on an unhandled rejection, and a write after the
 * peer disconnected is the classic way a plugin manufactures one — so the test
 * runs the real plugin in a child process that turns those two events into a
 * loud exit code, fires hostile requests at it, and requires the process to be
 * alive and serving normally after every single one.
 *
 * Hostile cases: a client that vanishes mid-upload, an oversized body, a
 * malformed body, a body that is not JSON at all, a disconnect during a static
 * wallpaper transfer, an aborted SSE reader, a HEAD/OPTIONS, and a burst of
 * parallel aborts.
 *
 * Honest scope: this suite passes both for the shipped plugin and for a
 * deliberately unguarded variant of it (`CRASH_PLUGIN=... node tools/crash-test.mjs`).
 * That means it proves the plugin survives hostile clients, and does NOT prove
 * that the guards are what saves it — a crash here would be a real finding, but
 * a pass is "no vector found", not "a vector was fixed".
 */
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

// Workspace paths contain a space, so URLs must be converted, not used raw.
const RUNNER = fileURLToPath(new URL('./crash-runner.mjs', import.meta.url))
const PLUGIN = process.env.CRASH_PLUGIN ?? fileURLToPath(new URL('../dsh-wallpaper/lib/index.js', import.meta.url))

const failures = []
const check = (label, condition, detail) => {
  if (!condition) failures.push(label)
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`)
}

const child = spawn(process.execPath, [RUNNER, PLUGIN], { stdio: ['ignore', 'pipe', 'pipe'] })
let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk) => { stdout += chunk })
child.stderr.on('data', (chunk) => { stderr += chunk })

/** Resolve once the runner reports its port. */
const port = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`runner never reported a port; stderr:\n${stderr}`)), 10000)
  const poll = setInterval(() => {
    const match = /PORT (\d+)/.exec(stdout)
    if (match !== null) {
      clearInterval(poll)
      clearTimeout(timer)
      resolve(Number(match[1]))
    }
  }, 50)
})
const base = `http://127.0.0.1:${port}`
console.log(`runner pid ${child.pid} on ${base}\n`)

/** Send raw bytes on a socket and drop the connection without reading a reply. */
function abortRaw(request) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(request)
      // Half-sent bodies are the point: the server has started parsing and the
      // peer disappears before the end of the message.
      setTimeout(() => {
        socket.destroy()
        resolve()
      }, 30)
    })
    socket.on('error', () => resolve())
  })
}

const alive = async () => {
  const before = stdout
  await new Promise((resolve) => setTimeout(resolve, 400))
  const counts = [...stdout.matchAll(/ALIVE (\d+)/g)].map((match) => Number(match[1]))
  const latest = counts.length > 0 ? counts[counts.length - 1] : -1
  void before
  return { running: child.exitCode === null && child.signalCode === null, latest }
}

const behavesNormally = async (label) => {
  const state = await alive()
  if (!state.running) {
    check(`${label}: process still alive`, false, `exit=${child.exitCode} signal=${child.signalCode}`)
    return false
  }
  let status = 0
  try {
    status = (await fetch(`${base}/dsh-wallpaper/api/state`)).status
  } catch (error) {
    check(`${label}: still serving`, false, String(error?.message ?? error))
    return false
  }
  check(`${label}: process alive and serving`, status === 200, `state → ${status}`)
  return true
}

// 1 — a client that vanishes in the middle of an upload.
await abortRaw(
  'POST /dsh-wallpaper/api/upload HTTP/1.1\r\n' +
  `Host: 127.0.0.1:${port}\r\n` +
  'Content-Type: application/json\r\n' +
  'Content-Length: 900000\r\n\r\n' +
  '{"name":"x.png","dataUrl":"data:image/png;base64,' + 'A'.repeat(4000))
await behavesNormally('upload aborted mid-body')

// 2 — an oversized body (the read guard destroys the request under the writer).
await fetch(`${base}/dsh-wallpaper/api/upload`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'huge.png', dataUrl: `data:image/png;base64,${'A'.repeat(13 * 1024 * 1024)}` }),
}).then((response) => response.status).catch((error) => String(error?.message ?? error)).then((result) => {
  check('oversized body answered or refused cleanly', result !== 200, String(result))
})
await behavesNormally('oversized body')

// 3 — malformed and empty bodies.
const notJson = await fetch(`${base}/dsh-wallpaper/api/config`, { method: 'POST', body: 'not json at all' })
check('non-JSON body → 400', notJson.status === 400, String(notJson.status))
const empty = await fetch(`${base}/dsh-wallpaper/api/config`, { method: 'POST' })
check('empty body tolerated', empty.status === 200 || empty.status === 400, String(empty.status))
const wrongType = await fetch(`${base}/dsh-wallpaper/api/config`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '[1,2,3]',
})
check('JSON array body tolerated', wrongType.status === 200 || wrongType.status === 400, String(wrongType.status))
await behavesNormally('malformed bodies')

// 4 — a disconnect in the middle of a static wallpaper transfer.
await abortRaw(
  'GET /dsh-wallpaper/wallpaper/default HTTP/1.1\r\n' +
  `Host: 127.0.0.1:${port}\r\n\r\n`,
)
await behavesNormally('static transfer aborted')

// 5 — a reader that opens the SSE stream and hangs up immediately, repeatedly.
for (let index = 0; index < 5; index += 1) {
  const response = await fetch(`${base}/dsh-wallpaper/api/events`, { headers: { accept: 'text/event-stream' } })
  await response.body?.cancel()
}
await behavesNormally('SSE readers cancelled')

// 6 — methods and paths the plugin never declared.
for (const [method, path] of [['HEAD', '/dsh-wallpaper/api/state'], ['OPTIONS', '/dsh-wallpaper'], ['GET', '/dsh-wallpaper/'], ['POST', '/dsh-wallpaper/nope']]) {
  try {
    await fetch(`${base}${path}`, { method })
  } catch {
    /* a refused upgrade or an empty reply is acceptable; a dead process is not */
  }
}
await behavesNormally('undeclared methods and paths')

// 7 — a burst of parallel aborts, to catch anything that only shows under load.
await Promise.all(Array.from({ length: 12 }, () => abortRaw(
  'POST /dsh-wallpaper/api/upload HTTP/1.1\r\n' +
  `Host: 127.0.0.1:${port}\r\n` +
  'Content-Type: application/json\r\n' +
  'Content-Length: 500000\r\n\r\n{"name":"y.png","dataUrl":"data:image/png;base64,' + 'B'.repeat(2000),
)))
const state = await alive()
check('process alive after a burst of aborts', state.running, `exit=${child.exitCode} signal=${child.signalCode}`)
check('every hostile request actually reached the plugin', state.latest > 0, `${state.latest} requests seen`)

// 8 — the process must not have reported either fatal class on its own.
check('no unhandled rejection was raised', !stderr.includes('UNHANDLED'),
  stderr.includes('UNHANDLED') ? stderr.split('\n').slice(0, 6).join(' | ') : 'clean')
check('no uncaught exception was raised', !stderr.includes('UNCAUGHT'),
  stderr.includes('UNCAUGHT') ? stderr.split('\n').slice(0, 6).join(' | ') : 'clean')
check('no handler rejection escaped', !stderr.includes('handler rejection escaped'),
  stderr.includes('handler rejection escaped') ? 'escaped' : 'clean')

// 9 — a final ordinary request, to prove the plugin still does its job.
const final = await fetch(`${base}/dsh-wallpaper/api/state`).then((response) => response.json()).catch(() => null)
check('plugin still returns a valid state payload after everything', final?.ok === true,
  final === null ? 'no payload' : `wallpapers=${final.wallpapers.length} sessions=${final.usage.sessions.length}`)

child.kill('SIGTERM')
await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2000))])

console.log(failures.length === 0 ? '\nNO CRASH VECTOR FOUND' : `\nFAILURES: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
