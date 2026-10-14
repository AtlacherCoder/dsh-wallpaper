/**
 * Hostile-client harness for dsh-wallpaper's host half.
 *
 * Not a test itself: a child process that mounts the real plugin behind a real
 * HTTP server, reports its port, and then reports every request it ever
 * received. tools/crash-test.mjs drives it and judges whether the process
 * survived — which is the only way to see an unhandled rejection or a
 * write-after-end, since those kill the process rather than throwing at the
 * caller.
 *
 * Reads one command from argv: the plugin entry to load.
 */
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_WALLPAPER_HOME = mkdtempSync(join(tmpdir(), 'dsh-wallpaper-crash-'))

const routes = []
const provided = new Map()
const ctx = {
  get: (name) => provided.get(name),
  provide: (name, value) => provided.set(name, value),
  on: () => () => {},
  effect: (callback) => {
    callback()
    return () => {}
  },
  webServer: {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
  },
}

const plugin = await import(process.argv[2])
plugin.apply(ctx)

let requests = 0
const server = createServer((req, res) => {
  requests += 1
  const url = new URL(req.url, 'http://127.0.0.1')
  const route = routes.find((candidate) =>
    candidate.kind === 'exact'
      ? url.pathname === candidate.path
      : url.pathname === candidate.path || url.pathname.startsWith(`${candidate.path}/`))
  if (route === undefined) {
    res.writeHead(404).end('no route')
    return
  }
  // Mirrors the carrier: it awaits the handler and does not swallow for us.
  Promise.resolve(route.handler(req, res)).catch((error) => {
    process.stderr.write(`handler rejection escaped: ${error?.stack ?? error}\n`)
    if (!res.writableEnded) {
      try {
        res.writeHead(500).end('handler failed')
      } catch {
        /* peer gone */
      }
    }
  })
})

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`PORT ${server.address().port}\n`)
  // A liveness probe endpoint the parent uses after each hostile request.
  setInterval(() => {
    process.stdout.write(`ALIVE ${requests}\n`)
  }, 250).unref()
})

// Anything that would kill a normal process is reported loudly here, so the
// parent can tell "survived" from "survived until the next tick".
process.on('uncaughtException', (error) => {
  process.stderr.write(`UNCAUGHT ${error?.stack ?? error}\n`)
  process.exit(9)
})
process.on('unhandledRejection', (error) => {
  process.stderr.write(`UNHANDLED ${error?.stack ?? error}\n`)
  process.exit(8)
})
