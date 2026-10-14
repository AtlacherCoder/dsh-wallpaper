/**
 * dsh-wallpaper — browser half.
 *
 * Two surfaces, one stylesheet, one data store:
 *
 *   - the wallpaper itself: a fixed layer behind the whole frame, switched on
 *     by a single class on <html>, so enabling/disabling is one class change
 *     and nothing else in the page has to know about it;
 *   - the panel: sidebar-foot button opens a floating card with the wallpaper
 *     library, upload, the dim/blur/fit controls, and this session's token and
 *     cost figures.
 *   - the strip: a compact ambient line under the composer inside
 *     `conversation.composer.dock`, which is a session-scoped slot and therefore
 *     the one place the browser can learn the active session id from the app
 *     itself rather than guessing it.
 *
 * Everything the panel shows is fetched from the plugin's own host routes under
 * /dsh-wallpaper — the browser cannot read the durable session log.
 *
 * The panel reports tokens, never money: an estimated currency figure was tried
 * and removed, because a sum of token counts cannot be turned into a trustworthy
 * bill without the provider's own pricing at request time.
 *
 * Hand-rolled loader bundle: no build step, no JSX, no TypeScript. The only
 * module ids it may require are the ones the shell seeds into the platform
 * table (react, react-dom, react/jsx-runtime, the UI primitives).
 */
window.__ModuleLoader__.load({
  id: 'dsh-wallpaper',
  factory: (require) => {
    // The loader's factory form is CommonJS: it hands over `require` only, so the
    // module envelope is created here.
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const h = React.createElement

    /** Route namespace owned by the host half. */
    const API = '/dsh-wallpaper/api'
    /** Class on <html> that switches the whole wallpaper treatment on. */
    const ON_CLASS = 'dsh-wallpaper-on'
    /** Style element id, so a re-apply replaces its own sheet instead of stacking. */
    const STYLE_ID = 'dsh-wallpaper-style'
    /** Wallpaper layer element id, kept unique so two applies cannot double it. */
    const LAYER_ID = 'dsh-wallpaper-layer'
    /** Panel toggle state lives here; both the panel and the sidebar button read it. */
    const listeners = new Set()
    let panelOpen = false
    /** The active session id, as reported by the dock strip (authoritative) or inferred. */
    let activeSessionId = null
    /** Bumped by data-store updates so every subscriber re-reads module state. */
    let revision = 0

    /**
     * Plugin-wide store: one state snapshot, one SSE connection, one repaint path.
     *
     * One connection serves every mounted component — a second EventSource per
     * component would multiply the host's broadcast work for no gain.
     */
    const store = {
      state: null,
      error: null,
      changed: false,
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      emit() {
        revision += 1
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch (error) {
            console.error('[dsh-wallpaper] subscriber failed', error)
          }
        }
      },
      async load() {
        try {
          const query = activeSessionId === null ? '' : `?sessionId=${encodeURIComponent(activeSessionId)}`
          const response = await fetch(`${API}/state${query}`, { headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const body = await response.json()
          if (body?.ok !== true) throw new Error(body?.error ?? '状态接口返回异常')
          this.state = body
          this.error = null
        } catch (error) {
          this.error = String(error?.message ?? error)
        }
        this.changed = true
        this.emit()
      },
      async post(path, body) {
        const response = await fetch(`${API}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        })
        const payload = await response.json().catch(() => null)
        if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
        return payload
      },
      /** Adopt an incoming frame (SSE or a POST response) without another round trip. */
      absorb(frame) {
        if (this.state === null) return
        if (frame.type === 'config' && frame.config !== undefined) {
          this.state = { ...this.state, config: frame.config }
        } else if (frame.type === 'usage' && frame.usage !== undefined) {
          this.state = { ...this.state, usage: frame.usage }
        }
        this.changed = true
        this.emit()
      },
    }

    let stream = null
    /** Timestamp of the last frame the feed delivered, used to skip needless polls. */
    let lastFrameAt = 0
    /** Open the SSE feed once, degrading to polling when the browser refuses it. */
    function openStream() {
      if (stream !== null) return stream
      if (typeof EventSource !== 'function') return null
      try {
        const source = new EventSource(`${API}/events`)
        source.onmessage = (event) => {
          lastFrameAt = Date.now()
          try {
            store.absorb(JSON.parse(event.data))
          } catch {
            /* a frame we cannot parse is not worth breaking the panel over */
          }
        }
        source.onerror = () => {
          // EventSource retries on its own; nothing to do but stay quiet.
        }
        stream = source
      } catch {
        stream = null
      }
      return stream
    }

    /** Poll only while something is actually mounted. */
    const POLL_MS = 5000
    const subscribers = { count: 0, timer: null }
    function acquirePolling() {
      subscribers.count += 1
      if (subscribers.timer !== null) return
      subscribers.timer = window.setInterval(() => {
        if (document.visibilityState === 'hidden') return
        // A live feed already pushed fresh figures; polling is the fallback path.
        if (Date.now() - lastFrameAt < POLL_MS * 3) return
        store.load()
      }, POLL_MS)
    }
    function releasePolling() {
      subscribers.count = Math.max(0, subscribers.count - 1)
      if (subscribers.count === 0 && subscribers.timer !== null) {
        window.clearInterval(subscribers.timer)
        subscribers.timer = null
      }
    }

    /** One stylesheet for both surfaces, keyed on theme variables. */
    function injectStyle() {
      const existing = document.getElementById(STYLE_ID)
      if (existing !== null) existing.remove()
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
#${LAYER_ID} {
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  overflow: hidden;
  background: #0b0b0f;
}
#${LAYER_ID} > .dw-image {
  position: absolute;
  inset: 0;
  background-position: center center;
  background-repeat: no-repeat;
  transform: scale(1.06);
  will-change: filter;
}
#${LAYER_ID} > .dw-dim {
  position: absolute;
  inset: 0;
}
/* The scheme's colour wash: what makes the frame read as deep blue rather than
   as "a photo the panel happens to sit on". Kept low enough that the wallpaper
   stays recognisable, and it follows the scheme picker. */
/* Structure only. Colour tokens are stacked through the theme service as
   light/dark pairs, so the wallpaper never forces white text onto a light
   theme; the scheme variables below are the plugin's own surfaces. */
html.${ON_CLASS} body {
  background: transparent;
}

/* ------------------------------------------------------------------ panel */
.dw-surface {
  position: fixed;
  inset: 0;
  z-index: 40;
  /* The overlay seat's host re-enables pointer events on every direct child
     (.overlayLayer > * { pointer-events: auto }), which would turn this
     full-viewport wrapper into a transparent shield: clicks would land on it
     instead of the app underneath. Beating it needs weight, not a plain none —
     the shipped rule is injected later and wins on ties. */
  pointer-events: none !important;
  user-select: none;
}
.dw-card {
  position: absolute;
  z-index: 1;
  right: 16px;
  bottom: 16px;
  width: min(340px, calc(100vw - 32px));
  max-height: min(74vh, 760px);
  overflow-y: auto;
  pointer-events: auto;
  box-sizing: border-box;
  padding: 0 14px 14px;
  border-radius: 16px;
  border: 1px solid var(--dw-line, rgba(255,255,255,0.14));
  background: var(--dw-card, #101c3a);
  color: var(--dw-ink, #e8eefc);
  box-shadow: 0 22px 56px rgba(0, 0, 0, 0.5), 0 0 0 1px var(--dw-glow, rgba(76,141,255,0.10)) inset;
  user-select: text;
  font-size: 12px;
  line-height: 1.55;
}
.dw-accent {
  height: 3px;
  margin: 0 -14px 10px;
  border-radius: 16px 16px 0 0;
  background: linear-gradient(90deg, transparent, var(--dw-accent, #4c8dff) 35%, var(--dw-accent-2, #22d3ee) 70%, transparent);
  opacity: 0.9;
}
.dw-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--dw-line, rgba(255,255,255,0.14));
}
.dw-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dw-accent, #4c8dff);
  box-shadow: 0 0 10px var(--dw-glow, rgba(76,141,255,0.10));
  flex: none;
}
.dw-title {
  flex: 1;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.01em;
}
.dw-section {
  margin: 12px 0 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--dw-accent, #4c8dff);
  display: flex;
  align-items: center;
  gap: 6px;
}
.dw-section::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--dw-line, rgba(255,255,255,0.14));
}
.dw-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 0;
}
.dw-row > label {
  flex: 1;
  color: var(--dw-ink-dim, #a9bce0);
}
.dw-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
}
.dw-thumb {
  position: relative;
  height: 44px;
  border-radius: 9px;
  border: 1px solid var(--dw-line, rgba(255,255,255,0.14));
  background-size: cover;
  background-position: center;
  background-color: var(--dw-field, rgba(255,255,255,0.05));
  cursor: pointer;
  padding: 0;
  overflow: hidden;
}
.dw-thumb[data-selected='true'] {
  outline: 2px solid var(--dw-accent, #4c8dff);
  outline-offset: 1px;
}
.dw-thumb > span {
  position: absolute;
  right: 2px;
  top: 2px;
  border-radius: 6px;
  padding: 0 4px;
  font-size: 10px;
  line-height: 14px;
  background: rgba(0, 0, 0, 0.62);
  color: #fff;
}
.dw-btn {
  box-sizing: border-box;
  border: 1px solid var(--dw-line, rgba(255,255,255,0.14));
  background: var(--dw-field, rgba(255,255,255,0.05));
  color: var(--dw-ink, #e8eefc);
  border-radius: 9px;
  padding: 4px 10px;
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}
.dw-btn:hover {
  border-color: var(--dw-accent, #4c8dff);
  background: var(--dw-field-hover, rgba(255,255,255,0.09));
}
.dw-btn:focus-visible {
  outline: 2px solid var(--dw-accent, #4c8dff);
  outline-offset: -2px;
}
.dw-btn[disabled] {
  opacity: 0.5;
  cursor: default;
}
/* The scheme picker: each swatch is the scheme's own card colour plus its
   accent stripe, so the choice is visible before it is applied. */
.dw-schemes {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px;
}
.dw-scheme {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 9px;
  border: 1px solid var(--dw-line, rgba(255,255,255,0.14));
  background: var(--dw-field, rgba(255,255,255,0.05));
  color: var(--dw-ink, #e8eefc);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}
.dw-scheme[data-selected='true'] {
  border-color: var(--dw-accent, #4c8dff);
  box-shadow: 0 0 0 1px var(--dw-accent, #4c8dff) inset;
}
.dw-scheme:hover {
  background: var(--dw-field-hover, rgba(255,255,255,0.09));
}
.dw-swatch {
  width: 22px;
  height: 22px;
  border-radius: 7px;
  flex: none;
  position: relative;
  overflow: hidden;
}
.dw-swatch::after {
  content: '';
  position: absolute;
  left: 3px;
  right: 3px;
  top: 4px;
  height: 3px;
  border-radius: 2px;
  background: var(--sw-accent);
}
.dw-table {
  width: 100%;
  border-collapse: collapse;
}
.dw-table td {
  padding: 2px 0;
}
.dw-table td:last-child {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.dw-total {
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px solid var(--dw-line, rgba(255,255,255,0.14));
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.dw-note {
  margin-top: 2px;
  color: var(--dw-ink-dim, #a9bce0);
  font-size: 11px;
}
.dw-error {
  margin-top: 8px;
  color: #ff8080;
  font-size: 11px;
  word-break: break-all;
}

/* ------------------------------------------------- footer trigger (rail/wide)
   Geometry copied from the shell's own footer row so this action sits in the
   same rhythm as the Settings and Team actions beside it: 42px tall, 12px
   radius and 14px label when wide, a 36px circle when the sidebar is a rail.

   Width is deliberately CONTENT-SIZED, not 100%: the sidebar.footer.action slot
   is one flex row (display:flex; width:100%; min-width:0) shared with the Team
   action, and this entry is registered first. A full-width first child overflows
   that row and pushes its neighbour out of the sidebar — the exact regression
   this rule prevents. The Settings action can afford width:100% because it is
   the last child of its own row. */
.dw-foot {
  flex: none;
  align-self: flex-end;
  width: auto;
  max-width: 100%;
  min-width: 0;
  height: 42px;
  /* 6px gap to the neighbouring action: the row itself defines no gap, and with
     the full-width rule gone the two triggers would otherwise touch. */
  margin: 8px 6px 0 0;
  display: flex;
}
.dw-foot-rail {
  align-items: center;
  width: 36px;
  height: 36px;
  margin: 0;
}
.dw-foot-btn {
  box-sizing: border-box;
  color: var(--dsw-alias-label-primary, #f2f2f5);
  cursor: pointer;
  background: 0 0;
  border: 0;
  border-radius: 12px;
  align-items: center;
  gap: 8px;
  width: auto;
  max-width: 100%;
  height: 42px;
  margin: 0;
  padding: 0 10px 0 8px;
  font-family: inherit;
  font-size: 14px;
  line-height: 22px;
  display: inline-flex;
  overflow: hidden;
  white-space: nowrap;
}
/* Hidden rather than removed: the dock strip under the composer reports the
   figure in full, and a long right-aligned number in a shared flex row is what
   pushed the Team action out of the sidebar. */
.dw-foot-metric {
  display: none;
}
.dw-foot-rail .dw-foot-btn {
  corner-shape: round;
  border-radius: 50%;
  justify-content: center;
  width: 36px;
  height: 36px;
  margin: 0;
  padding: 0;
}
.dw-foot-btn:hover,
.dw-foot-btn:focus-visible {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.18));
}
.dw-foot-btn:focus-visible {
  outline: 2px solid var(--dsw-alias-label-primary, #f2f2f5);
  outline-offset: -2px;
}
.dw-foot-btn[aria-expanded='true'] {
  background: var(--dw-field-hover, rgba(255,255,255,0.09));
}
.dw-foot-icon {
  flex: none;
  color: var(--dw-accent, #4c8dff);
}
.dw-foot-label {
  flex: none;
}

/* ------------------------------------------------------- ambient usage strip */
.dw-strip {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 2px 0 4px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, rgba(255,255,255,0.6));
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dw-strip b {
  color: var(--dsw-alias-label-primary, #f2f2f5);
  font-weight: 600;
}
@media (prefers-reduced-motion: no-preference) {
  .dw-card {
    transition: opacity 120ms ease;
  }
}
`
      document.head.appendChild(style)
      return style
    }

    /**
     * The panel's colour schemes.
     *
     * Every scheme is a deep blue family — the user asked for one tone with a
     * little decoration, not a theme engine. `accent` paints the icon, the
     * section headings, the selected outlines and the card's top stripe;
     * `card`/`field`/`line`/`ink` paint the surfaces. `swatch` is shown in the
     * picker so the choice is visible before it is applied.
     *
     * These are the plugin's OWN surfaces (panel, buttons, footer trigger), not
     * the application palette: they are deliberately the same in light and dark
     * themes, because a deep-blue card over a wallpaper is the requested look.
     */
    const SCHEMES = [
      {
        id: 'deep-blue',
        label: '深蓝',
        swatch: { card: '#101c3a', accent: '#4c8dff' },
        vars: {
          card: '#101c3a', field: 'rgba(76,141,255,0.08)', fieldHover: 'rgba(76,141,255,0.16)',
          line: 'rgba(96,150,255,0.22)', accent: '#4c8dff', accent2: '#22d3ee',
          ink: '#e8eefc', inkDim: '#a9bce0', glow: 'rgba(76,141,255,0.12)',
        },
      },
      {
        id: 'ink-blue',
        label: '墨蓝',
        swatch: { card: '#0b1530', accent: '#7fb2ff' },
        vars: {
          card: '#0b1530', field: 'rgba(127,178,255,0.07)', fieldHover: 'rgba(127,178,255,0.14)',
          line: 'rgba(127,178,255,0.18)', accent: '#7fb2ff', accent2: '#4c8dff',
          ink: '#eaf0ff', inkDim: '#9fb3d9', glow: 'rgba(127,178,255,0.10)',
        },
      },
      {
        id: 'midnight-cyan',
        label: '午夜青',
        swatch: { card: '#0a1b2e', accent: '#22d3ee' },
        vars: {
          card: '#0a1b2e', field: 'rgba(34,211,238,0.08)', fieldHover: 'rgba(34,211,238,0.16)',
          line: 'rgba(34,211,238,0.22)', accent: '#22d3ee', accent2: '#4c8dff',
          ink: '#e6f7ff', inkDim: '#9dc4d8', glow: 'rgba(34,211,238,0.12)',
        },
      },
      {
        id: 'mono',
        label: '石墨',
        swatch: { card: '#14161c', accent: '#8ea2c9' },
        vars: {
          card: '#14161c', field: 'rgba(255,255,255,0.05)', fieldHover: 'rgba(255,255,255,0.10)',
          line: 'rgba(255,255,255,0.14)', accent: '#8ea2c9', accent2: '#5f7099',
          ink: '#eef1f7', inkDim: '#a3adc2', glow: 'rgba(142,162,201,0.10)',
        },
      },
    ]

    /** The scheme in force, resolved from config with a safe fallback. */
    function schemeOf(config) {
      return SCHEMES.find((item) => item.id === config?.scheme) ?? SCHEMES[0]
    }

    /**
     * Publish a scheme's colours as CSS variables on <html>.
     *
     * The stylesheet reads these with hard-coded fallbacks, so a page whose
     * variables never landed still renders a coherent deep blue card.
     *
     * @param config - the config in force.
     */
    function applyScheme(config) {
      const scheme = schemeOf(config)
      const style = document.documentElement?.style
      // A document without a style object is not a reason to stop painting the
      // wallpaper: the stylesheet carries the same values as fallbacks.
      if (style === undefined || typeof style.setProperty !== 'function') return scheme
      for (const [name, value] of Object.entries(scheme.vars)) {
        style.setProperty(`--dw-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, value)
      }
      return scheme
    }

    /**
     * Each scheme is declared by a hue and a saturation ceiling; the ramp's
     * LIGHTNESS comes from the shipped palette itself, step for step.
     *
     * The shipped ramp's ordinals encode a luminance curve — 00 and 50 are page
     * and card backgrounds in light mode, 875/900/950 are the surfaces in dark
     * mode — so keeping its lightness and changing only hue and saturation means
     * light mode stays as light as it was (merely blue-tinted) and dark mode's
     * surfaces become blue at the same depth.
     */
    const SCHEME_HUES = {
      'deep-blue': { hue: 220, saturation: 0.62 },
      'ink-blue': { hue: 226, saturation: 0.68 },
      'midnight-cyan': { hue: 196, saturation: 0.55 },
      mono: { hue: 220, saturation: 0.14 },
    }

    /**
     * The shipped palette's lightness per step, as HSL lightness (0..1).
     *
     * Read off the build this plugin is installed into — the greys the surfaces
     * are made of today — so the recolour inherits its contrast rather than
     * inventing one. Step 00 (pure white, the light page background) is
     * deliberately absent: re-hueing it would tint the page behind every card.
     */
    const RAMP_LIGHTNESS = {
      1000: 0.07,
      950: 0.085,
      900: 0.11,
      875: 0.14,
      850: 0.175,
      800: 0.21,
      750: 0.27,
      700: 0.36,
      600: 0.47,
      500: 0.58,
      400: 0.68,
      300: 0.80,
      200: 0.88,
      150: 0.93,
      100: 0.94,
      75: 0.96,
      60: 0.97,
      50: 0.975,
    }

    /** One RGB triple as a hex literal. */
    function toHex(rgb) {
      return `#${rgb.map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0')).join('')}`
    }

    /** HSL -> hex, with the sRGB conversion every browser uses. */
    function hslToHex(hueDegrees, saturation, lightness) {
      const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
      const hue = ((hueDegrees % 360) + 360) % 360
      const secondary = chroma * (1 - Math.abs(((hue / 60) % 2) - 1))
      const floor = lightness - chroma / 2
      const sector = Math.floor(hue / 60) % 6
      const table = [
        [chroma, secondary, 0], [secondary, chroma, 0], [0, chroma, secondary],
        [0, secondary, chroma], [secondary, 0, chroma], [chroma, 0, secondary],
      ][sector]
      return toHex(table.map((channel) => Math.round((channel + floor) * 255)))
    }

    /**
     * Build one scheme's ramp: the shipped lightness curve, re-hued.
     *
     * Saturation grows as the surface deepens — a very pale step cannot hold much
     * colour without looking washed, and a deep step needs more of it to read as
     * blue rather than black. A floor keeps the palest steps visibly blue instead
     * of grey.
     *
     * @param spec - the scheme's hue and saturation ceiling.
     * @returns token name -> { light, dark }. The two are the same value because
     *          the ramp's ordinals already encode the mode; the OBJECT shape is
     *          what the theme boundary requires, and handing it a tuple instead
     *          fails silently inside its validator.
     */
    function buildRamp(spec) {
      const tokens = {}
      for (const [step, lightness] of Object.entries(RAMP_LIGHTNESS)) {
        const depth = 1 - lightness
        const saturation = Math.min(spec.saturation, spec.saturation * (0.35 + 0.65 * depth))
        const value = hslToHex(spec.hue, saturation, lightness)
        tokens[`--dsw-static-neutral-bluish-${step}`] = { light: value, dark: value }
      }
      return tokens
    }

    /** Ramps are pure functions of their spec: build each one once. */
    const UI_RAMPS = Object.fromEntries(
      Object.entries(SCHEME_HUES).map(([id, spec]) => [id, buildRamp(spec)]),
    )

    /**
     * The chosen scheme's ramp, as the theme service wants it: one light/dark
     * pair per token.
     *
     * @param config - the config in force.
     * @returns the token overrides for that scheme.
     */
    function uiTokens(config) {
      const scheme = schemeOf(config)
      const ramp = UI_RAMPS[scheme.id] ?? UI_RAMPS['deep-blue']
      const tokens = { ...ramp }
      // The scheme's accent also replaces the neutral "platform module" surface,
      // so the picker visibly changes something beyond a shade of navy.
      tokens['--dsw-alias-bg-module-platform'] = {
        light: scheme.vars.field, dark: scheme.vars.fieldHover,
      }
      return tokens
    }

    /**
     * Colour tokens the wallpaper needs, stated for BOTH schemes.
     *
     * Only the application base background and the borders are set here; every
     * surface colour comes from the ramp above, which is why one small table can
     * recolour the whole frame without naming a single component.
     */
    const TOKENS = {
      '--dsw-alias-bg-base': { light: 'transparent', dark: 'transparent' },
      '--dsw-alias-border-l1': { light: 'rgba(37,64,120,0.16)', dark: 'rgba(122,160,232,0.18)' },
      '--dsw-alias-border-l2': { light: 'rgba(37,64,120,0.24)', dark: 'rgba(122,160,232,0.26)' },
    }

    /** The live token layer, if one is stacked. */
    let tokenLayer = null
    /** The scheme the live layer encodes, so a no-op repaint does not restack it. */
    let stackedScheme = null

    /**
     * Stack or remove the token layer for the current config.
     *
     * The theme service is optional: a client without it simply keeps the stock
     * palette, and the wallpaper still works because only the base background
     * had to become transparent for that.
     *
     * @param ctx - plugin context, used to reach the theme service.
     * @param enabled - whether the wallpaper treatment is on.
     */
    function applyTokens(ctx, enabled, config) {
      const theme = typeof ctx?.get === 'function' ? ctx.get('theme') : undefined
      if (theme === undefined || typeof theme.overrideTokens !== 'function') return
      try {
        if (!enabled) {
          tokenLayer?.()
          tokenLayer = null
          stackedScheme = null
          return
        }
        // Re-stacking on every paint would emit a theme/change per frame during a
        // slider drag, so only the scheme transition rebuilds the layer.
        const scheme = schemeOf(config).id
        if (tokenLayer !== null && stackedScheme === scheme) return
        stackedScheme = scheme
        // Re-calling with the same source replaces that source's layer, so this
        // stays a single layer no matter how often the config changes.
        tokenLayer = theme.overrideTokens('dsh-wallpaper', { ...TOKENS, ...uiTokens(config) })
      } catch (error) {
        console.error('[dsh-wallpaper] theme token override failed', error)
      }
    }

    /**
     * A 16px line-art "image" glyph, drawn with `currentColor` so the scheme's
     * accent and the theme's label colour both apply without extra rules.
     *
     * @param props - `size` in px.
     */
    function WallpaperGlyph(props) {
      const size = Number(props?.size) || 16
      return h('svg', {
        className: 'dw-foot-icon',
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
      h('rect', { x: 1.7, y: 2.7, width: 12.6, height: 10.6, rx: 2.2 }),
      h('circle', { cx: 5.6, cy: 6.4, r: 1.15 }),
      h('path', { d: 'M2.2 11.6l3.5-3.2 2.6 2.3 2.5-2.4 2.9 2.8' }),
      )
    }

    /** The wallpaper layer, inserted as the first body child so nothing sits under it. */
    function ensureLayer() {
      let layer = document.getElementById(LAYER_ID)
      if (layer === null) {
        layer = document.createElement('div')
        layer.id = LAYER_ID
        const image = document.createElement('div')
        image.className = 'dw-image'
        const dim = document.createElement('div')
        dim.className = 'dw-dim'
        layer.appendChild(image)
        layer.appendChild(dim)
        document.body.insertBefore(layer, document.body.firstChild)
      }
      return layer
    }

    /**
     * Apply one config to the page: the on-class, the tokens, the image, blur,
     * dim, and fit. Colour tokens follow the same on/off state as the layer, so
     * disabling the wallpaper restores the stock palette exactly.
     *
     * @param ctx - plugin context, forwarded to the token layer.
     * @param config - the config in force.
     * @param wallpapers - the library, for resolving the chosen image.
     */
    function paint(ctx, config, wallpapers) {
      const html = document.documentElement
      const enabled = config.enabled !== false
      applyScheme(config)
      applyTokens(ctx, enabled, config)
      if (!enabled) {
        html.classList.remove(ON_CLASS)
        document.getElementById(LAYER_ID)?.remove()
        return
      }
      const chosen = wallpapers.find((item) => item.id === config.wallpaper) ?? wallpapers[0]
      const layer = ensureLayer()
      const image = layer.children[0]
      const dim = layer.children[1]
      if (chosen !== undefined) image.style.backgroundImage = `url("${chosen.url}")`
      image.style.backgroundSize = config.fit === 'contain' ? 'contain' : config.fit === 'fill' ? '100% 100%' : 'cover'
      image.style.filter = `blur(${Number(config.blur) || 0}px)`
      dim.style.background = `rgba(0, 0, 0, ${Number(config.dim) || 0})`
      html.classList.add(ON_CLASS)
    }

    /** 1234567 -> "1.23M", 12345 -> "12.3k", 999 -> "999". */
    function compact(value) {
      const number = Number(value) || 0
      if (number >= 1e9) return `${(number / 1e9).toFixed(2)}B`
      if (number >= 1e6) return `${(number / 1e6).toFixed(2)}M`
      if (number >= 1e4) return `${(number / 1e3).toFixed(1)}k`
      return number.toLocaleString('zh-CN')
    }

    /** Full numbers with thousands separators, for tooltips and the table. */
    function full(value) {
      return (Number(value) || 0).toLocaleString('zh-CN')
    }

    /** Seconds since epoch -> "MM-DD HH:mm". */
    function stamp(ms) {
      const value = Number(ms) || 0
      if (value <= 0) return '—'
      const date = new Date(value)
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /** Resolve which usage row a component should show, in order of confidence. */
    function pickSession(usage, preferredId) {
      const sessions = Array.isArray(usage?.sessions) ? usage.sessions : []
      if (sessions.length === 0) return null
      const wanted = preferredId ?? activeSessionId ?? usage?.currentSessionId ?? null
      const exact = sessions.find((row) => row.id === wanted)
      if (exact !== undefined) return exact
      const current = sessions.find((row) => row.isCurrent === true)
      if (current !== undefined) return current
      return sessions[0]
    }

    /** Debounce a config write so dragging a slider does not post per pixel. */
    function debounce(fn, delay) {
      let timer = null
      return (...args) => {
        if (timer !== null) window.clearTimeout(timer)
        timer = window.setTimeout(() => {
          timer = null
          fn(...args)
        }, delay)
      }
    }

    /** Every component re-renders off the store's change signal. */
    function useStore() {
      const [, bump] = React.useState(0)
      React.useEffect(() => {
        let alive = true
        const off = store.subscribe(() => {
          if (alive) bump((value) => value + 1)
        })
        return () => {
          alive = false
          off()
        }
      }, [])
      return store
    }

    /** Fetch once on mount and start the shared polling/metre loop. */
    function useLiveState() {
      const current = useStore()
      React.useEffect(() => {
        acquirePolling()
        store.load()
        openStream()
        return releasePolling
      }, [])
      return current
    }

    /** The panel's own transient state (which tab, in-flight upload, message). */
    function WallpaperPanel() {
      const live = useLiveState()
          const state = live.state
      const config = state?.config ?? null
      const open = panelOpen
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState(null)
      const [preference, setPreference] = React.useState(null)
      const fileRef = React.useRef(null)

      // Live editing must be instant on screen and cheap on the wire.
      const persist = React.useMemo(() => debounce((patch) => {
        store.post('/config', patch)
          .then((payload) => store.absorb({ type: 'config', config: payload.config }))
          .catch((error) => setMessage(String(error?.message ?? error)))
      }, 320), [])

      const patch = (next) => {
        if (state === null) return
        const merged = { ...state.config, ...next }
        store.state = { ...state, config: merged }
        store.emit()
        paint(ctx, merged, state.wallpapers)
        persist(next)
      }

      if (!open) return null

      const wallpapers = state?.wallpapers ?? []
      const row = pickSession(state?.usage, preference)
      const sessions = state?.usage?.sessions ?? []

      const onPick = (id) => patch({ wallpaper: id })
      const onUpload = async (event) => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (file === undefined) return
        setBusy(true)
        setMessage(null)
        try {
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(String(reader.result))
            reader.onerror = () => reject(new Error('读取文件失败'))
            reader.readAsDataURL(file)
          })
          const payload = await store.post('/upload', { name: file.name, dataUrl })
          store.absorb({ type: 'config', config: payload.config })
          await store.load()
          setMessage(`已上传并切换到「${file.name}」`)
        } catch (error) {
          setMessage(String(error?.message ?? error))
        } finally {
          setBusy(false)
        }
      }
      const onDelete = async (id) => {
        setBusy(true)
        try {
          const payload = await store.post('/delete', { id })
          store.absorb({ type: 'config', config: payload.config })
          await store.load()
        } catch (error) {
          setMessage(String(error?.message ?? error))
        } finally {
          setBusy(false)
        }
      }
      const onReset = () => {
        patch({ wallpaper: 'default', dim: 0.45, blur: 0, fit: 'cover', enabled: true })
        setMessage('已恢复默认')
      }

      return h('div', { className: 'dw-surface' },
        h('div', { className: 'dw-card' },
          h('div', { className: 'dw-accent', 'aria-hidden': 'true' }),
          h('div', { className: 'dw-head' },
            h('span', { className: 'dw-dot', 'aria-hidden': 'true' }),
            h('span', { className: 'dw-title' }, '壁纸'),
            h('div', { className: 'dw-row', style: { margin: 0, gap: 6 } },
              h('button', {
                type: 'button',
                className: 'dw-btn',
                title: '重新读取状态',
                onClick: () => store.load(),
              }, '↻'),
              h('button', {
                type: 'button',
                className: 'dw-btn',
                title: '关闭面板',
                onClick: () => setPanelOpen(false),
              }, '✕')
            )
          ),

          h('div', { className: 'dw-row' },
            h('label', { htmlFor: 'dsh-wallpaper-enabled' }, '启用壁纸'),
            h('input', {
              id: 'dsh-wallpaper-enabled',
              type: 'checkbox',
              checked: config?.enabled !== false,
              onChange: (event) => patch({ enabled: event.target.checked }),
            })
          ),

          h('div', { className: 'dw-section' }, '配色'),
          h('div', { className: 'dw-schemes' },
            SCHEMES.map((item) => h('button', {
              key: item.id,
              type: 'button',
              className: 'dw-scheme',
              'data-selected': String(item.id === schemeOf(config).id),
              title: item.label,
              onClick: () => patch({ scheme: item.id }),
            },
            h('span', {
              className: 'dw-swatch',
              'aria-hidden': 'true',
              style: {
                background: item.swatch.card,
                '--sw-accent': item.swatch.accent,
              },
            }),
            h('span', null, item.label),
            )),
          ),

          state === null
            ? h('div', { className: 'dw-note' }, '读取中…')
            : h('div', null,
              h('div', { className: 'dw-section' }, `壁纸（${wallpapers.length}）`),
              h('div', { className: 'dw-grid' },
                wallpapers.map((item) => h('button', {
                  key: item.id,
                  type: 'button',
                  className: 'dw-thumb',
                  'data-selected': String(item.id === config?.wallpaper),
                  title: `${item.name}${item.builtin ? '（内置）' : ''}`,
                  style: { backgroundImage: `url("${item.url}")` },
                  onClick: () => onPick(item.id),
                }, item.builtin ? null : h('span', {
                  title: '删除这张壁纸',
                  onClick: (event) => {
                    event.stopPropagation()
                    onDelete(item.id)
                  },
                }, '×'))
              ),
              h('div', { className: 'dw-row' },
                h('button', {
                  type: 'button',
                  className: 'dw-btn',
                  disabled: busy,
                  onClick: () => fileRef.current?.click(),
                }, busy ? '处理中…' : '上传图片'),
                h('button', {
                  type: 'button',
                  className: 'dw-btn',
                  onClick: onReset,
                }, '恢复默认'),
                h('input', {
                  ref: fileRef,
                  type: 'file',
                  accept: 'image/png,image/jpeg,image/webp,image/gif',
                  style: { display: 'none' },
                  onChange: onUpload,
                })
              ),

              h('div', { className: 'dw-section' }, '显示'),
              h('div', { className: 'dw-row' },
                h('label', null, `暗度 ${(Number(config?.dim) || 0).toFixed(2)}`),
                h('input', {
                  type: 'range', min: 0, max: 0.9, step: 0.05,
                  value: Number(config?.dim) || 0,
                  onChange: (event) => patch({ dim: Number(event.target.value) }),
                })
              ),
              h('div', { className: 'dw-row' },
                h('label', null, `模糊 ${Number(config?.blur) || 0}px`),
                h('input', {
                  type: 'range', min: 0, max: 24, step: 1,
                  value: Number(config?.blur) || 0,
                  onChange: (event) => patch({ blur: Number(event.target.value) }),
                })
              ),
              h('div', { className: 'dw-row' },
                h('label', null, '填充方式'),
                h('select', {
                  className: 'dw-btn',
                  value: config?.fit ?? 'cover',
                  onChange: (event) => patch({ fit: event.target.value }),
                },
                h('option', { value: 'cover' }, '填充'),
                h('option', { value: 'contain' }, '适应'),
                h('option', { value: 'fill' }, '拉伸')
                )
              )
            ),

          h('div', { className: 'dw-section' }, '本次会话用量'),
          h('div', { className: 'dw-row' },
            h('label', { htmlFor: 'dsh-wallpaper-usage-enabled' }, '在读用量'),
            h('input', {
              id: 'dsh-wallpaper-usage-enabled',
              type: 'checkbox',
              checked: config?.usageEnabled !== false,
              onChange: (event) => patch({ usageEnabled: event.target.checked }),
            })
          ),

          config?.usageEnabled === false
            ? h('div', { className: 'dw-note' }, '用量显示已关闭')
            : h('div', null,
              sessions.length > 0
                ? h('div', { className: 'dw-row' },
                  h('label', { htmlFor: 'dsh-wallpaper-session' }, '会话'),
                  h('select', {
                    id: 'dsh-wallpaper-session',
                    className: 'dw-btn',
                    value: row?.id ?? '',
                    onChange: (event) => setPreference(event.target.value),
                  },
                  sessions.map((item) => h('option', { key: item.id, value: item.id },
                    `${item.isCurrent ? '● ' : ''}${item.title ?? item.shortId} · ${compact(item.totalTokens)} tok`))
                  )
                )
                : h('div', { className: 'dw-note' }, '没有已加载的会话'),

              row === null || row.steps === 0
                ? h('div', { className: 'dw-note' }, '本会话暂无用量记录')
                : h('div', null,
                  h('table', { className: 'dw-table' },
                    h('tbody', null,
                      h('tr', null, h('td', null, '输入（未命中缓存）'), h('td', null, full(Math.max(0, row.inputTokens - row.cacheReadTokens)))),
                      h('tr', null, h('td', null, '输入（命中缓存）'), h('td', null, full(row.cacheReadTokens))),
                      h('tr', null, h('td', null, '输出'), h('td', null, full(row.outputTokens))),
                      h('tr', null, h('td', null, '其中推理'), h('td', null, full(row.reasoningTokens))),
                      h('tr', null, h('td', null, '合计'), h('td', null, full(row.totalTokens))),
                      h('tr', null, h('td', null, '模型 / 步数'), h('td', null, `${row.model ?? '—'} · ${row.steps}`)),
                      h('tr', null, h('td', null, '高峰时段'), h('td', null, `${full(row.peakTokens)} tok`)),
                      h('tr', null, h('td', null, '非高峰时段'), h('td', null, `${full(row.offPeakTokens)} tok`))
                    )
                  ),
                  h('div', { className: 'dw-total' },
                    `合计 ${full(row.totalTokens)} tok · ${row.steps} 步 · 输入 ${full(row.inputTokens)} / 输出 ${full(row.outputTokens)}`),
                  h('div', { className: 'dw-note' },
                    row.peakTokens + row.offPeakTokens > 0
                      ? '按每条记录自身的北京时间划分时段，可解释账单与「token 数」不成正比的原因'
                      : '本会话暂无时段划分'),
                  h('div', { className: 'dw-note' },
                    `最后一次刷新 ${stamp(Date.now())} · 数据源：会话日志 usage 计数`)
                )
            ),

          live.error !== null ? h('div', { className: 'dw-error' }, `读取失败：${live.error}`) : null,
          message !== null ? h('div', { className: 'dw-note' }, message) : null
        )
      )
      )
    }

    /**
     * The footer trigger.
     *
     * Built to the same geometry as the shipped Settings action and the Team
     * action beside it — 42px row, 12px radius, 8px icon gap, 14px label, and a
     * 36px circle when the sidebar is a rail — because that is what "in the same
     * rhythm as its neighbours" means in this shell. The glyph is an inline SVG,
     * not an emoji: an emoji renders as a tofu box wherever the platform font
     * lacks it (exactly what the previous 🖼 did), while an SVG cannot.
     *
     * @param props - slot props; `wide` is false in the 56px collapsed rail.
     */
    function SidebarButton(props) {
      const live = useStore()
      const wide = props?.wide !== false
      const row = pickSession(live.state?.usage, null)
      const metric = row !== null && row.steps > 0 ? `${compact(row.totalTokens)} tok` : ''
      const label = '壁纸'
      return h('div', { className: wide ? 'dw-foot' : 'dw-foot dw-foot-rail' },
        h('button', {
          type: 'button',
          className: 'dw-foot-btn',
          'aria-label': metric === '' ? label : `${label}与用量（本次会话 ${metric}）`,
          'aria-expanded': String(panelOpen),
          title: metric === '' ? label : `${label} · 本次会话 ${metric}`,
          onClick: () => setPanelOpen(!panelOpen),
        },
        h(WallpaperGlyph, { size: wide ? 16 : 18 }),
        wide ? h('span', { className: 'dw-foot-label' }, label) : null,
        wide && metric !== '' ? h('span', { className: 'dw-foot-metric' }, metric) : null,
        ),
      )
    }

    /**
     * Ambient strip under the composer, inside the session-scoped dock slot.
     *
     * This is the one place the browser receives the app's own active session id
     * as a slot prop, so it both renders the live figure and publishes that id to
     * the shared store for the panel.
     */
    function UsageStrip(props) {
      const live = useLiveState()
      const sessionId = typeof props?.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : null
      React.useEffect(() => {
        if (sessionId === null || sessionId === activeSessionId) return
        activeSessionId = sessionId
        store.load()
      }, [sessionId])
      if (live.state?.config?.usageEnabled === false) return null
      const row = pickSession(live.state?.usage, sessionId)
      if (row === null || row.steps === 0) return null
      return h('div', {
        className: 'dw-strip',
        title: `本次会话：输入 ${full(row.inputTokens)}（其中命中缓存 ${full(row.cacheReadTokens)}）· 输出 ${full(row.outputTokens)} · 其中推理 ${full(row.reasoningTokens)} · 合计 ${full(row.totalTokens)} tok · ${row.steps} 步\n高峰 ${full(row.peakTokens)} tok / 非高峰 ${full(row.offPeakTokens)} tok`,
      },
      h('span', null, '本次会话'),
      h('b', null, `${compact(row.totalTokens)} tok`),
      h('span', null, '·'),
      h('span', null, `输入 ${compact(row.inputTokens)}`),
      h('span', null, '·'),
      h('span', null, `输出 ${compact(row.outputTokens)}`)
      )
    }

    /** Panel visibility is shared state, so both surfaces re-render together. */
    function setPanelOpen(next) {
      panelOpen = next
      store.emit()
    }

    /**
     * Isolate one surface from the rest of the page.
     *
     * The three surfaces are independent features — the wallpaper, the panel,
     * and the usage strip. A render error in any one of them must not take the
     * conversation down with it, which is exactly what an unguarded React tree
     * inside the shell's own tree would do. An error boundary degrades to
     * nothing rendered instead, and reports once.
     */
    class SurfaceBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error) {
        console.error('[dsh-wallpaper] surface failed', this.props?.name ?? '', error)
      }

      render() {
        if (this.state.failed) return null
        return this.props.children
      }
    }

    /**
     * Wrap one surface component in its own boundary.
     *
     * The returned wrapper carries the surface and its slot name as properties.
     * That is a debug handle, not decoration: a harness has to mount one surface
     * in isolation to assert what it renders, and without this it would have to
     * reverse-engineer the React element tree to find the component.
     *
     * @param name - identity of the slot this surface fills, for error reports.
     * @param Component - the surface component.
     * @returns a component that renders the surface behind a boundary.
     */
    function isolate(name, Component) {
      function IsolatedSurface(props) {
        return h(SurfaceBoundary, { name },
          h(Component, props))
      }
      IsolatedSurface.Surface = Component
      IsolatedSurface.surfaceName = name
      return IsolatedSurface
    }

    /**
     * Mount the plugin.
     *
     * Nothing here may throw. `apply` runs while the shell builds its own tree,
     * so an exception raised here can cost the user their whole page, not just
     * their wallpaper. Every registration is individually guarded and a broken
     * one is skipped, leaving the other two surfaces working.
     */
    function apply(ctx) {
      let style = null
      try {
        style = injectStyle()
      } catch (error) {
        console.error('[dsh-wallpaper] stylesheet injection failed', error)
      }

      try {
        // A theme switch can drop stacked layers; restack from the config we
        // already hold rather than waiting for the next state fetch.
        if (typeof ctx.on === 'function') {
          ctx.on('theme/change', () => {
            const current = store.state
            if (current === null) return
            try {
              paint(ctx, current.config, current.wallpapers)
            } catch (error) {
              console.error('[dsh-wallpaper] repaint after theme change failed', error)
            }
          })
        }
      } catch (error) {
        console.error('[dsh-wallpaper] theme subscription failed', error)
      }

      try {
        if (typeof ctx?.effect !== 'function') throw new Error('ctx.effect unavailable')
        ctx.effect(() => () => {
          try {
            style?.remove()
            document.documentElement.classList.remove(ON_CLASS)
            document.getElementById(LAYER_ID)?.remove()
          } catch {
            /* teardown is best-effort: the page is going away anyway */
          }
          try {
            tokenLayer?.()
            tokenLayer = null
          } catch {
            /* the theme service may already be gone */
          }
          releasePolling()
          if (stream !== null) {
            stream.close()
            stream = null
          }
        })
      } catch (error) {
        console.error('[dsh-wallpaper] cleanup registration failed', error)
      }

      // The panel is the only surface that knows the config, and it only renders
      // when opened; so the wallpaper must be painted here, from the first state
      // fetch, or a user who never opens the panel would see no wallpaper.
      store.subscribe(() => {
        const current = store.state
        if (current === null) return
        try {
          paint(ctx, current.config, current.wallpapers)
        } catch (error) {
          console.error('[dsh-wallpaper] paint failed', error)
        }
      })

      const surfaces = [
        ['shell.overlay', 'dsh-wallpaper-panel', 0, '壁纸', WallpaperPanel],
        ['sidebar.footer.action', 'dsh-wallpaper', 50, '壁纸', SidebarButton],
        ['conversation.composer.dock', 'dsh-wallpaper-usage', 20, '用量', UsageStrip],
      ]
      for (const [name, id, order, label, Component] of surfaces) {
        try {
          if (typeof ctx?.slots?.inject !== 'function') break
          ctx.slots.inject(name, () => {
            try {
              ctx.slots.register({ name, id, order, label }, isolate(`${name}#${id}`, Component))
            } catch (error) {
              console.error(`[dsh-wallpaper] could not register ${name}`, error)
            }
          })
        } catch (error) {
          // One slot failing to exist must not stop the next one from trying.
          console.error(`[dsh-wallpaper] slot unavailable: ${name}`, error)
        }
      }
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
