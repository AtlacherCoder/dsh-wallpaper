/**
 * dsh-wallpaper — host half.
 *
 * Serves the DeepSeek Harness web GUI one page-level service: a wallpaper that
 * fills the whole frame, plus the panel data behind it (image list, upload,
 * display config) and the token/cost figures for the live session(s).
 *
 * Why the host owns any of this
 * -----------------------------
 * The browser half cannot read the durable session log, and it must not hold
 * the image files. So the host:
 *
 *   1. serves `/dsh-wallpaper/*` — bundled default wallpaper, uploaded user
 *      wallpapers, and the small JSON API the panel calls;
 *   2. persists the display config in the DSH home directory, not in the repo,
 *      so a plugin upgrade cannot clobber the user's choice;
 *   3. folds token usage out of the session log and prices it.
 *
 * Usage figures come from the session log itself (the `assistant/message`
 * events carry the provider's `TokenUsage`; `request/header` names the model in
 * force). The host only reads them: it never writes to any session, and a
 * session event that fails to parse is skipped rather than fatal.
 *
 * What this plugin deliberately does NOT do
 * -----------------------------------------
 * It does not estimate money. An earlier version multiplied the tokens by a
 * built-in copy of the provider's price table and showed a CNY figure; that
 * number could not be trusted (prices change, holidays are not in any local
 * calendar, and the provider's own billing window is not observable from a
 * session log), so it was removed rather than left with a disclaimer. What
 * remains is what the log actually records: token counts, and the peak/off-peak
 * split that explains why an invoice differs from a naive token × price sum.
 *
 * Zero npm dependencies: Node builtins and the loader contract only, which
 * keeps installation free of any dependency or build step.
 *
 * @module dsh-wallpaper
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

export const name = 'dsh-wallpaper'

/** The HTTP carrier is the plugin's whole delivery path; usage is optional. */
export const inject = ['webServer']

/** The one route namespace this plugin owns. */
const ROUTE_PREFIX = '/dsh-wallpaper'

/** Exact path of the API sub-namespace, and of one event stream. */
const API = `${ROUTE_PREFIX}/api`

/** Largest accepted upload body (base64 of a ~9 MB image). */
const MAX_BODY_BYTES = 12 * 1024 * 1024

/** Accepted upload media types, mapped to the extension they are stored under. */
const MEDIA_EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

/** Media type served per stored extension. */
const EXTENSION_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** Defaults written on first run; a partial stored config merges over these. */
const DEFAULT_CONFIG = {
  wallpaper: 'default',
  dim: 0.45,
  blur: 0,
  fit: 'cover',
  enabled: true,
  usageEnabled: true,
  scheme: 'deep-blue',
}

/**
 * Colour schemes the panel may select.
 *
 * Only the ids live here: the palettes are presentation and belong to the
 * browser half. The host validates against this list so a hand-edited config
 * file cannot persist a scheme no client can render.
 */
const SCHEME_IDS = ['deep-blue', 'ink-blue', 'midnight-cyan', 'mono']

/** Built-in wallpaper identity and its bundled file. */
const BUILTIN_ID = 'default'
const BUILTIN_FILE = 'default-wallpaper.jpg'

const here = fileURLToPath(new URL('.', import.meta.url))
const PACKAGE_ROOT = resolve(here, '..')
const BUILTIN_PATH = join(PACKAGE_ROOT, 'assets', BUILTIN_FILE)

/**
 * Where this plugin keeps its own state: the display config and the user's
 * uploaded wallpapers. Deliberately outside the package, so reinstalling or
 * upgrading the plugin (a `link:` checkout, a tarball, a git install) cannot
 * drop the user's choices. `DSH_WALLPAPER_HOME` overrides it, which is what the
 * smoke test uses to run the real code against a throwaway directory.
 */
function stateRoot() {
  const override = process.env.DSH_WALLPAPER_HOME
  return override !== undefined && override !== '' ? resolve(override) : join(homedir(), '.dsh', 'wallpaper')
}

/** Wallpapers the user added. */
const USER_WALLPAPER_DIR = join(stateRoot(), 'wallpapers')

/**
 * Durable session logs. The store only holds sessions this process has loaded,
 * so a fresh process (a restart, a second window) has none — these files are the
 * read-only fallback that keeps the panel useful in exactly that state.
 */
const SESSION_ROOT = join(homedir(), '.dsh', 'sessions')

/** How many recent logs to fold when no session is loaded in memory. */
const RECENT_LOG_LIMIT = 8

/** The last path segment of a session log file name. */
const SESSION_LOG_FILE = join('session.v3.jsonl.zstd')

/** The persisted display config. */
const CONFIG_PATH = join(stateRoot(), 'config.json')

/** Peak billing windows, Beijing time: two weekday spans, each doubled in price. */
const PEAK_WINDOWS = [
  [9, 12],
  [14, 18],
]

/** One formatter for the provider's own billing timezone (China has no DST). */
const BEIJING = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  hour12: false,
  weekday: 'short',
  hour: 'numeric',
  minute: 'numeric',
})

/**
 * Is one instant inside a peak billing window?
 *
 * The provider's peak windows are stated in Beijing time on weekdays. We read
 * the instant in that zone rather than trusting the host's local zone, so a
 * machine set to another timezone still prices correctly.
 *
 * @param timeMs - event time, epoch milliseconds.
 * @returns true when that instant bills at the peak rate.
 */
function isPeakTime(timeMs) {
  const parts = BEIJING.formatToParts(new Date(timeMs))
  const get = (type) => parts.find((part) => part.type === type)?.value
  const weekday = get('weekday')
  if (weekday === 'Sat' || weekday === 'Sun') return false
  const hour = Number(get('hour'))
  const minute = Number(get('minute'))
  if (!Number.isFinite(hour)) return false
  const minutes = hour * 60 + (Number.isFinite(minute) ? minute : 0)
  return PEAK_WINDOWS.some(([from, to]) => minutes >= from * 60 && minutes < to * 60)
}

/** A fresh fold target: the running totals plus the fold's own cursor. */
function emptyState() {
  return { seq: -1, model: null, lastTime: 0, ...emptyUsage() }
}

/**
 * Fold events into a state, in place.
 *
 * One implementation serves both sources: a live session's events carry
 * `{ type, data, seq, time }`, and an on-disk log is reduced by
 * {@link compactEvents} to the same facts under short keys. Keeping one fold
 * means a restarted process cannot compute different numbers than a live one.
 *
 * @param state - the tally to accumulate into.
 * @param events - live session events or compact log events.
 */
function foldEvents(state, events) {
  for (const event of events) {
    const type = event.type ?? event.t
    if (type === 'request/header') {
      const model = event.data?.header?.config?.model ?? event.m
      if (typeof model === 'string' && model !== '') state.model = model
    } else if (type === 'request/context') {
      const model = event.data?.model ?? event.m
      if (typeof model === 'string' && model !== '') state.model = model
    } else if (type === 'assistant/message') {
      const usage = event.data?.usage ?? event.u
      if (usage !== undefined && usage !== null) {
        const input = Number(usage.inputTokens) || 0
        const output = Number(usage.outputTokens) || 0
        state.inputTokens += input
        state.outputTokens += output
        state.cacheReadTokens += Number(usage.cacheReadTokens) || 0
        state.cacheWriteTokens += Number(usage.cacheWriteTokens) || 0
        state.reasoningTokens += Number(usage.reasoningTokens) || 0
        state.steps += 1
        const time = Number(event.time ?? event.e) || Date.now()
        if (isPeakTime(time)) state.peakTokens += input + output
        else state.offPeakTokens += input + output
        if (time > state.lastTime) state.lastTime = time
      }
    }
    const seq = Number(event.seq ?? event.s)
    if (Number.isFinite(seq) && seq > state.seq) state.seq = seq
  }
  state.totalTokens = state.inputTokens + state.outputTokens
  return state
}

/** An all-zero usage tally; every field is a running total over the session. */
function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    steps: 0,
    peakTokens: 0,
    offPeakTokens: 0,
  }
}

/** Size of one file, or 0 when it cannot be read (absent, or a race). */
function fileSize(path) {
  try {
    const info = statSync(path)
    return info.isFile() ? info.size : 0
  } catch {
    return 0
  }
}

/** Read JSON, or a fallback when the file is absent or unreadable. */
function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

/** Write JSON atomically, so an interrupted write cannot leave a half file. */
function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

/**
 * Read one run of zstd frames — a session log is a sequence, not one frame.
 *
 * @param path - the log file.
 * @returns the decoded text, or null when the file cannot be read.
 */
function readSessionLog(path) {
  let buffer
  try {
    buffer = readFileSync(path)
  } catch {
    return null
  }
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
  return parts.length === 0 ? null : Buffer.concat(parts).toString('utf8')
}

/**
 * Reduce one raw log to just the events the usage fold needs.
 *
 * A log carries every streamed delta of every step; only step boundaries,
 * route headers, and per-message usage matter here, and the rest is dropped
 * before it can occupy memory. The returned shape is the fold's internal
 * vocabulary, so a disk session and a live session fold through one path.
 *
 * @param text - decoded session log text.
 * @returns compact events: `{ t, s }` plus the payload each type carries.
 */
function compactEvents(text) {
  const events = []
  for (const line of text.split('\n')) {
    if (line === '' || line.charCodeAt(0) !== 0x7b) continue
    let raw
    try {
      raw = JSON.parse(line)
    } catch {
      continue
    }
    const data = raw.data
    if (raw.type === 'assistant/message') {
      if (data?.usage === undefined || data.usage === null) continue
      events.push({ t: 'assistant/message', s: Number(raw.seq) || 0, e: Number(raw.time) || 0, u: data.usage })
    } else if (raw.type === 'request/header') {
      events.push({ t: 'request/header', s: Number(raw.seq) || 0, e: Number(raw.time) || 0, m: data?.header?.config?.model })
    } else if (raw.type === 'request/context') {
      events.push({ t: 'request/context', s: Number(raw.seq) || 0, e: Number(raw.time) || 0, m: data?.model })
    }
  }
  return events
}

/**
 * The most recently written session logs, newest first.
 *
 * The layout is `<root>/<workspace-slug>/<session-id>/session.v3.jsonl.zstd`,
 * so this walks two levels and reads the directory listing only: no log is
 * opened until one is actually wanted.
 *
 * @param limit - how many to return.
 * @returns `{ id, path, mtime, bytes }`, newest first.
 */
function recentSessionLogs(limit) {
  const found = []
  let workspaces = []
  try {
    workspaces = readdirSync(SESSION_ROOT, { withFileTypes: true })
  } catch {
    return found
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    const workspacePath = join(SESSION_ROOT, workspace.name)
    let sessions = []
    try {
      sessions = readdirSync(workspacePath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const file = join(workspacePath, session.name, SESSION_LOG_FILE)
      try {
        const info = statSync(file)
        if (!info.isFile() || info.size === 0) continue
        found.push({ id: session.name, path: file, mtime: info.mtimeMs, bytes: info.size })
      } catch {
        continue
      }
    }
  }
  found.sort((left, right) => right.mtime - left.mtime)
  return found.slice(0, limit)
}

/**
 * Collect a request body, refusing anything past the upload budget.
 *
 * @param req - the incoming request.
 * @returns the decoded UTF-8 body.
 */
function readBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        rejectPromise(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    req.on('error', rejectPromise)
  })
}

/**
 * Is this response still writable?
 *
 * A client that navigated away, a browser that cancelled an upload, and a
 * probe that opened a socket and dropped it all leave the response destroyed
 * or finished. Writing then does not throw on every Node path, but the paths
 * that do throw (`writeHead` after the socket died, `end` after `end`) are
 * exactly the ones that turn a dead request into a dead process: an exception
 * raised while handling a rejection becomes an unhandled rejection, and Node's
 * default for that is to terminate. Every write below is gated on this.
 *
 * @param res - the response to inspect.
 * @returns true when a write is still safe.
 */
function writable(res) {
  if (res.writableEnded === true || res.destroyed === true) return false
  return res.socket === null || res.socket.destroyed !== true
}

/** Answer one request with JSON, silently when the peer is already gone. */
function sendJson(res, status, value) {
  if (!writable(res)) return
  let body
  try {
    body = Buffer.from(JSON.stringify(value ?? null), 'utf8')
  } catch {
    body = Buffer.from('{"ok":false,"error":"unserializable response"}', 'utf8')
  }
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch {
    /* the peer left mid-write; nothing left to say to it */
  }
}

/** Refuse one request with a JSON error the panel can show verbatim. */
function sendError(res, status, message) {
  sendJson(res, status, { ok: false, error: String(message ?? 'unknown error') })
}

/**
 * Run one request handler so it can never produce an unhandled rejection.
 *
 * The rejection path is the one that kills the host: `route.handler(req, res)`
 * is awaited by the web carrier, and an error raised *inside* the rejection
 * handler has nowhere left to go. Routing every request through this wrapper —
 * including the failure branch — keeps a Hostile or interrupted request from
 * reaching the process.
 *
 * @param req - incoming request.
 * @param res - response to own.
 * @param handler - the handler to run.
 */
function guarded(req, res, handler) {
  // A response is an EventEmitter: an unconsumed 'error' event throws, and a
  // dropped peer emits exactly that. Claiming it here is what makes the rest of
  // the writes above survivable.
  res.on('error', () => {})
  req.on('error', () => {})
  Promise.resolve()
    .then(() => handler())
    .catch((error) => {
      try {
        sendError(res, 500, error?.message ?? error)
      } catch {
        /* already answered, or the peer is gone */
      }
    })
}

/**
 * Wallpaper service: display config, the image library, and session usage.
 *
 * One instance per process (the loader mounts the package once). Every side
 * effect it creates — the route, the session listener, the stream clients —
 * belongs to the plugin fiber, so unloading the plugin removes all of them.
 */
class WallpaperService {
  /**
   * @param ctx - the plugin's Cordis context.
   */
  constructor(ctx) {
    this.ctx = ctx
    /** Per-session usage tallies, keyed by session id. */
    this.usage = new Map()
    /** Folded on-disk logs, keyed by session id and invalidated by (bytes, mtime). */
    this.diskCache = new Map()
    /** Open SSE responses, so a fold can push a frame. */
    this.streams = new Set()
    /** Open event streams' keep-alive handle; null when none is needed. */
    this.heartbeat = null
    // Creating the directory is a convenience, not a precondition: a plugin
    // that throws in its own constructor fails its loader row, so this is
    // best-effort and the write paths retry through ensureUserDir().
    this.ensureUserDir()
  }

  /**
   * Make sure the wallpaper directory exists, without ever throwing.
   *
   * A read-only home, a full disk, or a permission problem must degrade to
   * "uploads fail" — not to "the plugin fails to load".
   *
   * @returns true when the directory is usable.
   */
  ensureUserDir() {
    try {
      mkdirSync(USER_WALLPAPER_DIR, { recursive: true })
      return true
    } catch {
      return false
    }
  }

  /** The stored display config, merged over the defaults. */
  config() {
    const stored = readJson(CONFIG_PATH, {})
    const merged = { ...DEFAULT_CONFIG, ...(stored && typeof stored === 'object' ? stored : {}) }
    if (merged.wallpaper !== BUILTIN_ID && !existsSync(this.wallpaperPath(merged.wallpaper))) {
      merged.wallpaper = BUILTIN_ID
    }
    return merged
  }

  /**
   * Merge a partial config over the stored one and persist it.
   *
   * @param patch - the caller's partial config.
   * @returns the merged config now in force.
   */
  saveConfig(patch) {
    const next = { ...this.config(), ...(patch && typeof patch === 'object' ? patch : {}) }
    next.dim = Math.min(0.9, Math.max(0, Number(next.dim) || 0))
    next.blur = Math.min(24, Math.max(0, Math.round(Number(next.blur) || 0)))
    next.fit = ['cover', 'contain', 'fill'].includes(next.fit) ? next.fit : 'cover'
    next.enabled = next.enabled !== false
    next.usageEnabled = next.usageEnabled !== false
    if (!SCHEME_IDS.includes(next.scheme)) next.scheme = DEFAULT_CONFIG.scheme
    if (typeof next.wallpaper !== 'string' || !next.wallpaper) next.wallpaper = BUILTIN_ID
    if (next.wallpaper !== BUILTIN_ID && !existsSync(this.wallpaperPath(next.wallpaper))) {
      next.wallpaper = BUILTIN_ID
    }
    writeJsonAtomic(CONFIG_PATH, next)
    this.broadcast({ type: 'config', config: next })
    return next
  }

  /**
   * Resolve one stored wallpaper id to a file inside the user directory.
   *
   * The id is a relative path (`user/<stamp>-<rand><ext>`); anything that tries
   * to climb out of the wallpaper directory resolves outside it and is refused
   * by the caller's containment check.
   *
   * @param id - stored wallpaper id.
   * @returns the absolute path it names.
   */
  wallpaperPath(id) {
    const relative = String(id).replace(/^user\//, '')
    return resolve(USER_WALLPAPER_DIR, relative)
  }

  /** Every wallpaper the panel may offer: the bundled one, then the user's. */
  wallpapers() {
    const list = [
      {
        id: BUILTIN_ID,
        name: '默认壁纸（内置）',
        url: `${ROUTE_PREFIX}/wallpaper/${BUILTIN_ID}`,
        builtin: true,
        bytes: fileSize(BUILTIN_PATH),
      },
    ]
    let entries = []
    try {
      entries = readdirSync(USER_WALLPAPER_DIR, { withFileTypes: true })
    } catch {
      entries = []
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const extension = extname(entry.name).toLowerCase()
      if (EXTENSION_TYPES[extension] === undefined) continue
      const bytes = fileSize(join(USER_WALLPAPER_DIR, entry.name))
      // A file that vanished between listing and stat is simply not offered.
      if (bytes === 0) continue
      const id = `user/${entry.name}`
      list.push({
        id,
        name: entry.name,
        url: `${ROUTE_PREFIX}/wallpaper/${encodeURIComponent(id)}`,
        builtin: false,
        bytes,
      })
    }
    return list
  }

  /**
   * Save one uploaded image and return its new wallpaper id.
   *
   * @param name - the client's file name, kept only for display.
   * @param dataUrl - `data:<media-type>;base64,<payload>`.
   * @returns the stored wallpaper's id and URL.
   */
  saveUpload(name, dataUrl) {
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(String(dataUrl ?? ''))
    if (match === null) throw new Error('图片数据格式无法识别')
    const mediaType = match[1].toLowerCase()
    const extension = MEDIA_EXTENSIONS[mediaType]
    if (extension === undefined) throw new Error(`不支持的图片类型：${mediaType}`)
    const bytes = Buffer.from(match[2], 'base64')
    if (bytes.length === 0) throw new Error('图片内容为空')
    if (bytes.length > MAX_BODY_BYTES) throw new Error('图片过大（上限约 9 MB）')
    const safeStem = basename(String(name ?? 'wallpaper'))
      .replace(/\.[^.]*$/, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'wallpaper'
    const stored = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeStem}${extension}`
    this.ensureUserDir()
    writeFileSync(join(USER_WALLPAPER_DIR, stored), bytes)
    const id = `user/${stored}`
    return { id, url: `${ROUTE_PREFIX}/wallpaper/${encodeURIComponent(id)}`, bytes: bytes.length }
  }

  /**
   * Remove one user wallpaper.
   *
   * @param id - stored wallpaper id; the bundled default is refused.
   * @returns true when a file was removed.
   */
  deleteWallpaper(id) {
    if (id === BUILTIN_ID || typeof id !== 'string' || id === '') throw new Error('内置壁纸不能删除')
    const path = this.wallpaperPath(id)
    if (!path.startsWith(USER_WALLPAPER_DIR)) throw new Error('壁纸路径不合法')
    if (!existsSync(path)) return false
    unlinkSync(path)
    if (this.config().wallpaper === id) this.saveConfig({ wallpaper: BUILTIN_ID })
    return true
  }

  /**
   * Add recent on-disk session logs to a live session list, skipping duplicates.
   *
   * The in-memory store is the authority for what is *open*; the logs are the
   * fallback for what exists. Folding the newest few keeps the panel meaningful
   * right after a restart, when the store is empty and the conversation the user
   * is looking at has not been reopened yet.
   *
   * @param liveSessions - sessions currently loaded in this process.
   * @returns live sessions first, then the most recently written logs.
   */
  withRecentLogs(liveSessions) {
    const known = new Set(liveSessions.map((session) => String(session.id)))
    const extra = []
    for (const candidate of recentSessionLogs(RECENT_LOG_LIMIT)) {
      if (known.has(candidate.id)) continue
      const state = this.diskUsage(candidate)
      if (state === null || state.steps === 0) continue
      extra.push({
        id: candidate.id,
        header: { id: candidate.id, createdAt: 0, cwd: null },
        snapshotEvents: () => [],
        diskState: state,
      })
    }
    return [...liveSessions, ...extra]
  }

  /**
   * Fold one session log from disk, cached by (path, size, mtime).
   *
   * @param candidate - a log discovered by {@link recentSessionLogs}.
   * @returns the folded tally, or null when the log cannot be read.
   */
  diskUsage(candidate) {
    const cached = this.diskCache.get(candidate.id)
    if (cached !== undefined && cached.bytes === candidate.bytes && cached.mtime === candidate.mtime) {
      return cached.state
    }
    const text = readSessionLog(candidate.path)
    if (text === null) return null
    const state = foldEvents(emptyState(), compactEvents(text))
    this.diskCache.set(candidate.id, { bytes: candidate.bytes, mtime: candidate.mtime, state })
    // Bound the cache: a long-lived process must not accumulate one entry per
    // log it has ever glanced at.
    if (this.diskCache.size > RECENT_LOG_LIMIT * 4) {
      const keep = new Set(recentSessionLogs(RECENT_LOG_LIMIT).map((item) => item.id))
      for (const id of [...this.diskCache.keys()]) {
        if (!keep.has(id) && id !== candidate.id) this.diskCache.delete(id)
      }
    }
    return state
  }

  /**
   * The sessions' usage tallies, newest activity first.
   *
   * A session is folded on first sight and updated from then on, so this is
   * cheap after the first call. Sessions the store no longer holds are dropped
   * from the cache, which bounds it to live sessions.
   *
   * @param source - optional session list; defaults to the live store. The
   *                 override exists so the fold can be verified against raw logs
   *                 without a running host (see tools/usage-fold-test.mjs).
   * @returns one entry per session, plus the id of the session driving this
   *          very request when the host can name it.
   */
  sessionUsage(source, preferredId) {
    const sessionsService = this.ctx.get('sessions')
    const liveSessions = source !== undefined
      ? source
      : (typeof sessionsService?.list === 'function' ? sessionsService.list() : [])
    // A session loaded in this process outranks the same session read from disk.
    const sessions = source !== undefined ? liveSessions : this.withRecentLogs(liveSessions)
    const rows = []
    for (const session of sessions) {
      const id = String(session.id)
      const state = this.foldSession(session)
      rows.push({
        id,
        shortId: id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id,
        title: null,
        cwd: typeof session.header?.cwd === 'string' ? session.header.cwd : null,
        createdAt: Number(session.header?.createdAt) || 0,
        lastTime: state.lastTime,
        model: state.model,
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
        cacheReadTokens: state.cacheReadTokens,
        cacheWriteTokens: state.cacheWriteTokens,
        reasoningTokens: state.reasoningTokens,
        totalTokens: state.totalTokens,
        steps: state.steps,
        peakTokens: state.peakTokens,
        offPeakTokens: state.offPeakTokens,
        isCurrent: false,
      })
    }
    const visible = new Set(sessions.map((session) => String(session.id)))
    for (const id of [...this.usage.keys()]) if (!visible.has(id)) this.usage.delete(id)
    rows.sort((left, right) => right.lastTime - left.lastTime)
    const currentId = this.currentSessionId(preferredId, rows)
    for (const item of rows) item.isCurrent = item.id === currentId
    return { sessions: rows, currentSessionId: currentId }
  }

  /**
   * Which session the caller means by "the current one".
   *
   * Three answers, in order of confidence: the session the browser names (the
   * panel knows which conversation it is standing in, and only the browser can
   * tell the host that over a plain HTTP request); the session driving the
   * current host request, when an agent is in the middle of one; otherwise the
   * most recently active live session, which is the useful default for a single
   * window.
   *
   * @param preferredId - the id the caller asked for, if any.
   * @param rows - the usage rows already built.
   * @returns the session id to highlight, or null when nothing is live.
   */
  currentSessionId(preferredId, rows = []) {
    if (typeof preferredId === 'string' && rows.some((row) => row.id === preferredId)) return preferredId
    const agent = this.ctx.get('agents')?.currentInitiator?.()
    const id = agent?.id ?? agent?.session?.id
    if (typeof id === 'string' && rows.some((row) => row.id === id)) return id
    return rows[0]?.id ?? null
  }

  /**
   * Fold one session's log into its tally, reusing the cached state.
   *
   * The first fold walks the session's whole in-memory log; later calls only
   * apply the events appended since the last one. `request/header` and
   * `request/context` name the model in force, so each usage record is
   * attributed to the model that actually produced it.
   *
   * @param session - a live session.
   * @returns the session's current tally.
   */
  foldSession(session) {
    const id = String(session.id)
    // A session read from disk arrives already folded; the live path folds here.
    if (session.diskState !== undefined) return session.diskState
    let state = this.usage.get(id)
    const first = state === undefined
    if (first) {
      state = emptyState()
      this.usage.set(id, state)
    }
    const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents(0) : []
    foldEvents(state, events)
    return state
  }

  /** Register the route, the session feed, and the shutdown of both. */
  attach() {
    this.ctx.effect(() => {
      const disposeRoute = this.ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => guarded(req, res, () => this.handle(req, res)),
      })
      const disposeFeed = this.ctx.on('session/event', (_session, event) => {
        try {
          // Recomputing every open stream's payload is only worth it while a
          // panel is actually listening; a closed panel is a no-op, not a cost.
          if (this.streams.size === 0) return
          if (event?.type !== 'assistant/message' && event?.type !== 'request/header') return
          this.broadcast({ type: 'usage', usage: this.sessionUsage() })
        } catch (error) {
          // This runs inside another plugin's append path; a throw here would
          // surface as that plugin's failure, so it is contained.
          console.error('[dsh-wallpaper] usage feed failed', error)
        }
      })
      const disposeStreams = () => {
        this.stopHeartbeat()
        for (const res of this.streams) {
          try {
            res.end()
          } catch {
            /* the socket is already gone */
          }
        }
        this.streams.clear()
      }
      return () => {
        disposeStreams()
        disposeFeed()
        disposeRoute()
      }
    })
  }

  /**
   * Read and parse one JSON request body.
   *
   * A truncated body, a malformed document, and an aborted upload are all the
   * caller's problem, not the host's: each answers 400 and returns null.
   *
   * @param req - incoming request.
   * @param res - response to answer on failure.
   * @returns the parsed object, or null when the request was already answered.
   */
  async readJsonBody(req, res) {
    let body
    try {
      body = await readBody(req)
    } catch (error) {
      sendError(res, 400, `读取请求体失败：${error?.message ?? error}`)
      return null
    }
    try {
      const parsed = JSON.parse(body === '' ? '{}' : body)
      return typeof parsed === 'object' && parsed !== null ? parsed : {}
    } catch {
      sendError(res, 400, '请求体不是合法 JSON')
      return null
    }
  }

  /** Push one frame to every open event stream, dropping dead ones. */
  broadcast(frame) {
    if (this.streams.size === 0) return
    const payload = `data: ${JSON.stringify(frame)}\n\n`
    for (const res of [...this.streams]) {
      try {
        res.write(payload)
      } catch {
        this.streams.delete(res)
      }
    }
  }

  /**
   * Route one request inside the plugin's namespace.
   *
   * @param req - incoming request.
   * @param res - response to own.
   */
  async handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = decodeURIComponent(url.pathname)
    if (req.method === 'GET' && path === `${API}/state`) {
      sendJson(res, 200, {
        ok: true,
        config: this.config(),
        wallpapers: this.wallpapers(),
        usage: this.sessionUsage(undefined, url.searchParams.get('sessionId') ?? undefined),
      })
      return
    }
    if (req.method === 'GET' && path === `${API}/events`) {
      this.openStream(req, res)
      return
    }
    if (req.method === 'POST' && path === `${API}/config`) {
      const payload = await this.readJsonBody(req, res)
      if (payload === null) return
      sendJson(res, 200, { ok: true, config: this.saveConfig(payload) })
      return
    }
    if (req.method === 'POST' && path === `${API}/upload`) {
      const payload = await this.readJsonBody(req, res)
      if (payload === null) return
      const saved = this.saveUpload(payload.name, payload.dataUrl)
      this.saveConfig({ wallpaper: saved.id, enabled: true })
      sendJson(res, 200, { ok: true, ...saved, config: this.config(), wallpapers: this.wallpapers() })
      return
    }
    if (req.method === 'POST' && path === `${API}/delete`) {
      const payload = await this.readJsonBody(req, res)
      if (payload === null) return
      const removed = this.deleteWallpaper(payload.id)
      sendJson(res, 200, { ok: true, removed, config: this.config(), wallpapers: this.wallpapers() })
      return
    }
    if (req.method === 'GET' && path.startsWith(`${ROUTE_PREFIX}/wallpaper/`)) {
      this.serveWallpaper(path.slice(`${ROUTE_PREFIX}/wallpaper/`.length), res)
      return
    }
    sendError(res, 404, `no route: ${req.method} ${path}`)
  }

  /**
   * Serve one wallpaper file by id.
   *
   * @param rawId - the id segment, URL-decoded already.
   * @param res - response to own.
   */
  serveWallpaper(rawId, res) {
    const id = rawId.replace(/^\/+/, '')
    let file = null
    if (id === BUILTIN_ID) file = BUILTIN_PATH
    else {
      const candidate = this.wallpaperPath(id)
      if (candidate.startsWith(USER_WALLPAPER_DIR)) file = candidate
    }
    if (file === null || !existsSync(file)) {
      sendError(res, 404, '壁纸文件不存在')
      return
    }
    const info = statSync(file)
    if (!writable(res)) return
    res.writeHead(200, {
      'content-type': EXTENSION_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': String(info.size),
      'last-modified': info.mtime.toUTCString(),
      'etag': `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`,
      'cache-control': 'public, max-age=300',
    })
    const stream = createReadStream(file)
    // Both directions can fail (file removed between stat and open, peer gone
    // mid-transfer); each side tears the other down so no descriptor leaks and
    // no second 'end' write happens.
    stream.on('error', () => {
      try {
        res.end()
      } catch {
        /* peer already gone */
      }
    })
    res.on('close', () => stream.destroy())
    stream.pipe(res)
  }

  /**
   * Open one Server-Sent Events stream and keep it in the broadcast set.
   *
   * @param req - incoming request, used only to notice the client going away.
   * @param res - response that stays open.
   */
  openStream(req, res) {
    if (!writable(res)) return
    try {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write(`data: ${JSON.stringify({ type: 'ready' })}\n\n`)
    } catch {
      return
    }
    this.streams.add(res)
    const drop = () => {
      this.streams.delete(res)
      if (this.streams.size === 0) this.stopHeartbeat()
    }
    for (const event of ['close', 'error']) {
      req.on(event, drop)
      res.on(event, drop)
    }
    // A proxy or a sleeping laptop can hold the socket open without ever
    // closing it; a comment frame keeps the stream alive and, more usefully,
    // makes the write path notice a peer that died silently.
    this.startHeartbeat()
  }

  /**
   * Keep open event streams warm, and drop the ones the peer abandoned.
   *
   * The heartbeat is one timer for all streams and exists only while at least
   * one is open, so a closed panel costs nothing.
   */
  startHeartbeat() {
    if (this.heartbeat !== null) return
    this.heartbeat = setInterval(() => {
      for (const res of [...this.streams]) {
        if (!writable(res)) {
          this.streams.delete(res)
          continue
        }
        try {
          res.write(': keep-alive\n\n')
        } catch {
          this.streams.delete(res)
        }
      }
      if (this.streams.size === 0) this.stopHeartbeat()
    }, 25000)
    // A heartbeat must never be the reason the process stays alive.
    if (typeof this.heartbeat?.unref === 'function') this.heartbeat.unref()
  }

  /** Stop the heartbeat when no stream needs it. */
  stopHeartbeat() {
    if (this.heartbeat === null) return
    clearInterval(this.heartbeat)
    this.heartbeat = null
  }
}

/**
 * Mount the wallpaper service for the web composition.
 *
 * @param ctx - the plugin's Cordis context.
 */
export function apply(ctx) {
  const service = new WallpaperService(ctx)
  service.attach()
  ctx.effect(() => ctx.provide('wallpaper', {
    config: () => service.config(),
    saveConfig: (patch) => service.saveConfig(patch),
    wallpapers: () => service.wallpapers(),
    sessionUsage: (source, preferredId) => service.sessionUsage(source, preferredId),
    /** The fold itself, for a verifier comparing against raw logs. */
    fold: (session) => service.foldSession(session),
  }))
}
