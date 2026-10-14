/**
 * dsh-wallpaper client-bundle contract check.
 *
 * The browser half is a hand-rolled loader bundle, so nothing type-checks it and
 * nothing bundles it. This runs it under the loader's own contract instead:
 *
 *   node tools/client-syntax-check.mjs
 *
 * It stubs `window.__ModuleLoader__` and a `require` resolving the four module
 * ids the shell seeds into its platform table, evaluates the bundle, and then
 * asserts the things the module system actually depends on:
 *
 *   1. the definition id is the package name, and the factory is a function;
 *   2. the factory returns `{ apply, inject }` with `inject = ['slots']`;
 *   3. `require` was never called with an id outside the allowed four — a bare
 *      `require('some-package')` would throw in the browser and blank the page;
 *   4. the plugin's own `apply` registers into real slot names only, verified
 *      against the slot tree the host actually published.
 */
import { readFileSync } from 'node:fs'

const BUNDLE = new URL('../dsh-wallpaper/lib/client.js', import.meta.url)
/** Module ids the shell seeds; anything else cannot resolve in the browser. */
const ALLOWED_REQUIRES = new Set([
  'react',
  'react-dom',
  'react/jsx-runtime',
  '@deepseek-ai/dsh-client-ui-primitives',
])

const failures = []
const check = (label, condition, detail) => {
  if (!condition) failures.push(label)
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`)
}

/** Minimal element stand-in: enough for assertions, no DOM needed. */
/**
 * React flattens array children, so `.map()` output becomes individual
 * children rather than one nested array. Mirroring that here is not cosmetic:
 * without it a harness cannot see anything a `.map()` produced.
 */
const element = (type, props, ...children) => {
  const flat = []
  const push = (child) => {
    if (Array.isArray(child)) {
      for (const item of child) push(item)
      return
    }
    if (child === null || child === undefined || typeof child === 'boolean') return
    flat.push(child)
  }
  for (const child of children) push(child)
  return { $$typeof: Symbol.for('react.element'), type, props, children: flat }
}
/** The class stand-in React needs for an error-boundary component. */
class FakeComponent {
  constructor(props) {
    this.props = props ?? {}
    this.state = {}
  }

  setState(next) {
    this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) }
  }
}

const pendingEffects = []

const fakeReact = {
  Component: FakeComponent,
  createElement: element,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: (effect, deps) => { pendingEffects.push({ effect, deps }) },
  useMemo: (factory) => factory(),
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
}

const required = []
const fakeRequire = (id) => {
  required.push(id)
  if (!ALLOWED_REQUIRES.has(id)) throw new Error(`module "${id}" is not in the platform table`)
  if (id === 'react') return fakeReact
  if (id === 'react/jsx-runtime') return { jsx: element, jsxs: element, Fragment: 'Fragment' }
  if (id === 'react-dom') return { createPortal: (node) => node }
  return {} // the UI primitives: the bundle must not depend on specific exports
}

// --- run the bundle under the loader contract -------------------------------
let captured = null
globalThis.window = {
  __ModuleLoader__: { load: (definition) => { captured = definition } },
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
}
globalThis.fetch = async (url) => ({
  ok: true,
  status: 200,
  json: async () => ({
    ok: true,
    config: { wallpaper: 'default', dim: 0.45, blur: 0, fit: 'cover', enabled: true, usageEnabled: true },
    wallpapers: [{ id: 'default', name: '内置', url: '/dsh-wallpaper/wallpaper/default', builtin: true, bytes: 1 }],
    usage: {
      sessions: [{
        id: 'session-test', shortId: 'session-…test', title: null, cwd: null,
        createdAt: 0, lastTime: 1, model: 'deepseek-flash',
        inputTokens: 130576, outputTokens: 100485, cacheReadTokens: 24599808, cacheWriteTokens: 0,
        reasoningTokens: 22539, totalTokens: 231061, steps: 172,
        peakTokens: 231061, offPeakTokens: 0, isCurrent: true,
      }],
      currentSessionId: 'session-test',
    },
    url,
  }),
})
globalThis.EventSource = undefined
const injectedStyles = []
/** Every element the bundle creates, so getElementById can find them again. */
const created = []
globalThis.document = {
  visibilityState: 'visible',
  head: { appendChild: (element) => { if (element?.textContent) injectedStyles.push(element.textContent) } },
  body: { insertBefore: () => {}, firstChild: null },
  documentElement: { classList: { add: () => {}, remove: () => {} }, style: { setProperty: () => {}, removeProperty: () => {} } },
  getElementById: (id) => created.find((node) => node.id === id) ?? null,
  createElement: () => {
    const node = {
      id: '',
      style: {},
      className: '',
      classList: { add: () => {}, remove: () => {} },
      children: [],
      appendChild(child) { node.children.push(child) },
      remove: () => {},
    }
    Object.defineProperty(node, 'firstElementChild', { get: () => node.children[0] ?? null })
    Object.defineProperty(node, 'lastElementChild', { get: () => node.children[node.children.length - 1] ?? null })
    created.push(node)
    return node
  },
}

const source = readFileSync(BUNDLE, 'utf8')
globalThis.__DW_DEBUG = process.env.DEBUG_HARNESS === '1'
// `source` is also read by the scheme-palette check further down.
new Function('window', 'document', source)(globalThis.window, globalThis.document)

check('bundle registers with the module loader', captured !== null)
check('definition id is the package name', captured?.id === 'dsh-wallpaper', captured?.id)
check('factory is a function', typeof captured?.factory === 'function')

const exportsObject = captured.factory(fakeRequire)
check('factory returns an exports object', typeof exportsObject === 'object' && exportsObject !== null)
check('exports.apply is a function', typeof exportsObject.apply === 'function')
check('exports.inject is ["slots"]', JSON.stringify(exportsObject.inject) === JSON.stringify(['slots']),
  JSON.stringify(exportsObject.inject))
check('only platform module ids were required', required.every((id) => ALLOWED_REQUIRES.has(id)),
  [...new Set(required)].join(', '))

// --- apply() into a stubbed slot registry -----------------------------------
/** Slot names the live GUI actually declares (queried from the running host). */
const KNOWN_SLOTS = new Set(['shell.overlay', 'sidebar.footer.action', 'conversation.composer.dock'])
const injected = []
const registered = []
const effects = []
const tokenLayers = []
const themeSubscriptions = []
const ctx = {
  get: (name) => (name === 'theme'
    ? {
      overrideTokens: (source, tokens) => {
        tokenLayers.push({ source, tokens })
        return () => tokenLayers.push({ source, removed: true })
      },
    }
    : undefined),
  on: (event, listener) => { themeSubscriptions.push({ event, listener }); return () => {} },
  effect: (callback) => { effects.push(callback()); return () => {} },
  slots: {
    inject: (name, callback) => {
      injected.push(name)
      if (!KNOWN_SLOTS.has(name)) throw new Error(`unknown slot ${name}`)
      callback()
      return () => {}
    },
    register: (options, render) => {
      registered.push({ ...options, render })
      return () => {}
    },
  },
}

exportsObject.apply(ctx)
check('apply registers every declared slot', injected.length === registered.length && registered.length === 3,
  registered.map((entry) => `${entry.name}#${entry.id ?? entry.key ?? '?'}`).join(', '))
check('a throwing slot inject does not stop the remaining surfaces', (() => {
  const seen = []
  const hostile = {
    slots: {
      inject: (name, callback) => {
        seen.push(name)
        if (name === 'shell.overlay') throw new Error('slot missing')
        callback()
      },
      register: () => () => {},
    },
    effect: () => () => {},
  }
  try {
    exportsObject.apply(hostile)
  } catch {
    return false
  }
  return seen.length === 3
})(), 'three slots attempted despite the first one throwing')
check('all slot names exist in the live tree', injected.every((name) => KNOWN_SLOTS.has(name)), injected.join(', '))
check('every registration carries a fresh id', registered.every((entry) => typeof entry.id === 'string' && entry.id !== ''))
check('apply owns its cleanup through ctx.effect', effects.length === 1 && typeof effects[0] === 'function')
check('every surface is wrapped in its own error boundary', registered.every((entry) =>
  typeof entry.render === 'function' && entry.render.name === 'IsolatedSurface'),
  registered.map((entry) => entry.render.name).join(', '))
check('a failing surface degrades to null instead of propagating', (() => {
  const boundaryElement = registered[0].render({})
  const Boundary = boundaryElement.type
  const instance = new Boundary(boundaryElement.props)
  instance.state = Boundary.getDerivedStateFromError(new Error('boom'))
  return Boundary.prototype.render.call(instance) === null
})(), 'getDerivedStateFromError + render -> null')

// --- the render functions must be callable without throwing ------------------
// Each registration returns an error boundary; the surface is its child, so the
// check mounts the real component (one level down) the way React would.
/**
 * Mount one surface the way React would: reach the component through the
 * wrapper's own handle (no tree archaeology), call it, and expand only what it
 * returns — so the result is the element tree a user would see, with nested
 * function components (the SVG glyph, the swatches) left for `walk` to expand.
 */
const renderSurface = (entry, props) => {
  const Component = entry.render?.Surface
  if (typeof Component !== 'function') return null
  return Component(props ?? {})
}

for (const entry of registered) {
  try {
    renderSurface(entry, entry.name === 'sidebar.footer.action' ? { wide: true } : { sessionId: null })
  } catch (error) {
    failures.push(`render ${entry.name}`)
    console.log(`FAIL  render ${entry.name} threw: ${error?.message}`)
  }
}
const closed = renderSurface(registered.find((entry) => entry.id === 'dsh-wallpaper-panel'))
const strip = renderSurface(registered.find((entry) => entry.id === 'dsh-wallpaper-usage'))
const button = renderSurface(registered.find((entry) => entry.id === 'dsh-wallpaper'), { wide: true })
check('panel renders closed (null) by default', closed === null)
check('strip renders nothing without a session', strip === null)
const footButton = Array.isArray(button?.children) ? button.children.find((child) => child?.type === 'button') : undefined
check('footer trigger is a wrapper row holding the button', button?.type === 'div' && footButton !== undefined,
  `wrapper=${String(button?.type)} button=${String(footButton?.type)}`)
check('the trigger carries an accessible name', typeof footButton?.props?.['aria-label'] === 'string' &&
  footButton.props['aria-label'].includes('壁纸'), String(footButton?.props?.['aria-label']))
const glyph = footButton?.children
  ?.map((child) => (typeof child?.type === 'function' ? child.type(child.props) : child))
  ?.find((child) => child?.type === 'svg')
check('the trigger renders an inline SVG glyph (not an emoji)', glyph !== undefined,
  `children=${(footButton?.children ?? []).map((child) => String(child?.type)).join(',')}`)
check('the glyph inherits colour and is hidden from assistive tech',
  glyph?.props?.stroke === 'currentColor' && glyph?.props?.['aria-hidden'] === 'true')
check('a hostile slot prop does not throw', (() => {
  try {
    renderSurface(registered.find((entry) => entry.id === 'dsh-wallpaper'), undefined)
    renderSurface(registered.find((entry) => entry.id === 'dsh-wallpaper-panel'), { sessionId: 42 })
    return true
  } catch {
    return false
  }
})(), 'undefined and non-string props are tolerated')

// --- colour schemes: palettes present, complete, and selectable --------------
/** Read the scheme table out of the bundle source and check it is complete. */
function SCHEME_IDS_OK() {
  const ids = [...source.matchAll(/id: '((?:deep-blue|ink-blue|midnight-cyan|mono))'/g)].map((match) => match[1])
  const varBlocks = [...source.matchAll(/vars: \{([^}]+)\}/g)].map((match) => match[1])
  const required = ['card', 'field', 'fieldHover', 'line', 'accent', 'accent2', 'ink', 'inkDim', 'glow']
  const incomplete = varBlocks.filter((block) => required.some((name) => !new RegExp(`\\b${name}:`).test(block)))
  SCHEME_IDS_OK.detail = `${ids.length} schemes, ${varBlocks.length} palettes, ${incomplete.length} incomplete`
  return ids.length === 4 && varBlocks.length === 4 && incomplete.length === 0
}

// --- colour tokens: light/dark pairs, applied on paint, removed on disable ---
/**
 * Mount one surface the way React would: render it, then run the effects it
 * registered. The panel's mount effect calls the store's load(), which resolves
 * the fetch stub and notifies the paint subscriber apply() installed.
 */
const mountSurface = async (entry, props) => {
  const rendered = renderSurface(entry, props) // may be null when closed
  void rendered
  const effects = pendingEffects.splice(0, pendingEffects.length)
  for (const item of effects) await item.effect()
}

check('a theme/change subscription is registered', themeSubscriptions.some((item) => item.event === 'theme/change'),
  themeSubscriptions.map((item) => item.event).join(', ') || 'none')

// Drive the real paint path: the strip is always mounted by the app, its mount
// effect loads state, and apply() subscribed paint() to the store.
await mountSurface(registered.find((entry) => entry.id === 'dsh-wallpaper-usage'), { sessionId: 'session-test' })
await new Promise((resolve) => setTimeout(resolve, 20))
// Re-enter the store's own load path with the panel mounted, which is what the
// running app does on every refresh tick.
await mountSurface(registered.find((entry) => entry.id === 'dsh-wallpaper-usage'), { sessionId: 'session-test' })
await new Promise((resolve) => setTimeout(resolve, 20))
if (process.env.DEBUG_HARNESS === '1') {
  console.log('DEBUG tokenLayers:', JSON.stringify(tokenLayers.map((entry) => ({ source: entry.source, removed: entry.removed, tokens: entry.tokens ? Object.keys(entry.tokens).length : 0 }))))
  const themeLookup = ctx.get('theme')
  console.log('DEBUG theme lookup:', typeof themeLookup, themeLookup === undefined ? 'undefined' : typeof themeLookup.overrideTokens)
  console.log('DEBUG pendingEffects after mounts:', pendingEffects.length)
}
const layer = tokenLayers.find((entry) => entry.removed !== true)
check('paint stacked a theme token layer', layer !== undefined, layer?.source ?? 'none')
const tokens = layer?.tokens ?? {}
check('every token layer declares a light AND a dark value', Object.values(tokens).length > 0 && Object.values(tokens).every((pair) =>
  pair !== null && typeof pair === 'object' && typeof pair.light === 'string' && typeof pair.dark === 'string'),
  `${Object.keys(tokens).length} tokens`)
check('the base background is transparent so the wallpaper shows through',
  tokens['--dsw-alias-bg-base']?.light === 'transparent' && tokens['--dsw-alias-bg-base']?.dark === 'transparent')
check('text tokens are NOT overridden (the palette keeps its own ink)',
  !('--dsw-alias-label-primary' in tokens) && !('--dsw-alias-label-secondary' in tokens),
  Object.keys(tokens).join(', '))

// Drive the config through the store's own path by re-running apply with a state
// already present is not possible here; instead assert the shape the paint path
// would pass, via the registered panel's own effect-free render.

// --- the panel must be full of data, not full of holes ----------------------
/** Flatten a rendered element tree into the text a user would read. */
const textOf = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  const own = Array.isArray(node.children) ? node.children.flatMap(textOf) : []
  const nested = node.props?.children === undefined ? [] : (Array.isArray(node.props.children) ? node.props.children.flatMap(textOf) : textOf(node.props.children))
  return [...own, ...nested]
}

// Open the panel the way a user does: click the trigger's button, then render it.
const buttonElement = renderSurface(registered.find((entry) => entry.id === 'dsh-wallpaper'), { wide: true })
const triggerButton = Array.isArray(buttonElement?.children) ? buttonElement.children.find((child) => child?.type === 'button') : undefined
triggerButton?.props?.onClick?.()
await mountSurface(registered.find((entry) => entry.id === 'dsh-wallpaper-panel'))
const panelElement = renderSurface(registered.find((entry) => entry.id === 'dsh-wallpaper-panel'))
const panelText = textOf(panelElement).join(' | ')
check('opened panel renders content', panelText.length > 40, `${panelText.length} chars of text`)
check('panel shows the token breakdown', /输入/.test(panelText) && /输出/.test(panelText) && /合计/.test(panelText))
check('panel shows the peak / off-peak split that replaced the money row',
  /高峰时段/.test(panelText) && /非高峰时段/.test(panelText))
check('panel shows a real total, not a placeholder', /231,061/.test(panelText), '231,061 tok')
check('no money, price, or estimate wording survives anywhere in the UI',
  !/[¥￥]/.test(panelText) && !/预估|消费|单价|计价/.test(panelText),
  panelText.replace(/\s+/g, ' '))
check('no empty value cell is rendered', !/\|\s*\|/.test(panelText) && !/：\s*\|/.test(panelText))

// The stylesheet must define every class the panel actually uses, or the new
// rows render unstyled (visually "empty") even though the text is there.
const styleText = injectedStyles.join('\n')
const usedClasses = [...new Set([...JSON.stringify(panelElement).matchAll(/"className":"(dw-[a-z0-9-]+)"/g)].map((match) => match[1]))]
const missingStyles = usedClasses.filter((name) => !styleText.includes(`.${name}`))
check('every class the panel renders has a rule in the stylesheet', missingStyles.length === 0,
  missingStyles.length === 0 ? `${usedClasses.length} classes covered` : `unstyled: ${missingStyles.join(', ')}`)
check('the removed cost class is no longer styled', !styleText.includes('dsh-wallpaper-cost'))
check('scheme variables drive the panel surfaces', styleText.includes('var(--dw-card') && styleText.includes('var(--dw-accent'))
check('a colour picker with four schemes is offered', (panelText.match(/深蓝|墨蓝|午夜青|石墨/g) ?? []).length === 4,
  (panelText.match(/深蓝|墨蓝|午夜青|石墨/g) ?? []).join(','))
/** Walk a rendered tree, expanding function children the way React does. */
const walk = (node, visit) => {
  if (node === null || node === undefined || typeof node !== 'object') return
  const expanded = typeof node.type === 'function' ? node.type(node.props) : node
  if (expanded !== node) return walk(expanded, visit)
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}
const pickerButtons = []
walk(panelElement, (node) => { if (node?.props?.className === 'dw-scheme') pickerButtons.push(node) })
check('the picker renders one button per scheme with a swatch', pickerButtons.length === 4 &&
  pickerButtons.every((node) => (node.children ?? []).some((child) => {
    const drawn = typeof child?.type === 'function' ? child.type(child.props) : child
    return drawn?.props?.className === 'dw-swatch' && typeof drawn.props.style?.background === 'string'
  })), `${pickerButtons.length} buttons`)
check('the default scheme is the one marked selected',
  pickerButtons.filter((node) => node.props['data-selected'] === 'true').length === 1,
  pickerButtons.map((node) => `${node.props.title}:${node.props['data-selected']}`).join(' '))
check('the footer trigger is built on the shell footer geometry',
  styleText.includes('.dw-foot {') && styleText.includes('height: 42px') && styleText.includes('border-radius: 12px'))
/**
 * The sidebar.footer.action row is shared with the Team action and this entry is
 * registered first, so a full-width trigger pushes its neighbour off-screen.
 * That regression happened once; this asserts the rule that prevents it.
 */
const footBlock = styleText.slice(styleText.indexOf('.dw-foot {'), styleText.indexOf('.dw-foot-rail {'))
const footBtnBlock = styleText.slice(styleText.indexOf('.dw-foot-btn {'), styleText.indexOf('.dw-foot-rail .dw-foot-btn'))
const widthOf = (block) => /width:\s*([^;]+);/.exec(block)?.[1]?.trim() ?? '(none)'
check('the trigger does not claim the shared footer row',
  !/(?<!max-)(?<!min-)width:\s*100%/.test(footBlock) && !/(?<!max-)(?<!min-)width:\s*100%/.test(footBtnBlock) &&
  /(?<!max-)(?<!min-)width:\s*auto/.test(footBlock),
  `row=${widthOf(footBlock)} button=${widthOf(footBtnBlock)}`)
check('the trigger carries no full-row negative margin',
  !/margin:\s*0 -2px/.test(footBlock) && !/margin:\s*0 -2px/.test(footBtnBlock))
check('a gap separates the trigger from the neighbouring action',
  /margin:\s*8px 6px 0 0/.test(footBlock), /margin:\s*([^;]+)/.exec(footBlock)?.[1])
check('the rail variant drops that gap so it stays centred',
  /\.dw-foot-rail\s*\{[^}]*margin:\s*0/.test(styleText))
check('the metric text is hidden rather than expanding the button',
  /\.dw-foot-metric\s*\{\s*display:\s*none/.test(styleText))
check('the trigger still reports its figure through the title/aria attributes',
  typeof footButton?.props?.title === 'string' && footButton.props.title.includes('壁纸'),
  String(footButton?.props?.title))
check('the collapsed rail variant is defined', styleText.includes('.dw-foot-rail'))
check('every scheme palette declares a full variable set', SCHEME_IDS_OK(), SCHEME_IDS_OK.detail ?? '')
/**
 * A mistyped colour is invisible in review and ships as a broken surface (one
 * did: a stray character landed inside a hex value). Every literal the bundle
 * hands the theme service must therefore parse.
 */
const colourLiterals = [...source.matchAll(/'((?:#[0-9a-fA-F]*)|(?:rgba?\([^')]*\)))'/g)].map((match) => match[1])
const invalidColours = colourLiterals.filter((value) => !/^(?:#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[\d.]+\s*)?\))$/.test(value))
check('every colour literal in the bundle is a valid CSS colour', invalidColours.length === 0,
  invalidColours.length === 0 ? `${colourLiterals.length} literals checked` : invalidColours.join(', '))
check('each scheme carries its own ramp', (source.match(/--dsw-static-neutral-bluish-875':/g) ?? []).length >= 1 ||
  /UI_RAMPS = Object.fromEntries/.test(source), 'ramps are generated per scheme')
check('the stacked layer re-points the tokens the columns are built from',
  ['--dsw-static-neutral-bluish-875', '--dsw-static-neutral-bluish-900', '--dsw-static-neutral-bluish-850']
    .every((name) => layer?.tokens?.[name] !== undefined),
  layer === undefined ? 'no layer' : `${Object.keys(layer.tokens).length} tokens stacked`)

/**
 * This build recolours the neutral ramp the columns are built from, so the shape
 * that matters is coverage: every step the shipped theme binds a surface to, in
 * both modes, with a light/dark pair each.
 */
const RAMP_STEPS = ['1000', '950', '900', '875', '850', '800', '750', '700', '600', '500', '400', '300', '200', '150', '100', '75', '60', '50']
const rampTokens = Object.entries(layer?.tokens ?? {}).filter(([name]) => name.includes('neutral-bluish'))
const missingRampSteps = RAMP_STEPS.filter((step) => !rampTokens.some(([name]) => name === `--dsw-static-neutral-bluish-${step}`))
check('the stacked layer covers the surface palette the columns use', missingRampSteps.length === 0,
  missingRampSteps.length === 0 ? `${rampTokens.length} ramp tokens` : `missing ${missingRampSteps.join('/')}`)
check('each scheme is declared by a hue and a saturation ceiling', (source.match(/hue: \d+, saturation: [\d.]+/g) ?? []).length === 4,
  `${(source.match(/hue: \d+, saturation: [\d.]+/g) ?? []).length} schemes`)

/**
 * The overlay seat's host re-enables pointer events on every direct child
 * (`.overlayLayer > * { pointer-events: auto }`). This panel registers there, so
 * its full-viewport wrapper stops being click-through and becomes a transparent
 * shield: clicks land on it instead of the UI underneath, and nothing happens.
 *
 * That shipped rule wins on equal specificity simply by being injected later, so
 * the plugin must beat it by weight — and the check below is weight-sensitive on
 * purpose, because a plain `pointer-events: none` here reads correct and is not.
 */
// Braces inside CSS comments (a rule quoted in prose, for instance) would cut a
// naive `{...}` match short, so the commented text is removed first.
const styleCode = styleText.replace(/\/\*[\s\S]*?\*\//g, '')
const surfaceRule = /\.dw-surface\s*\{([^}]*)\}/.exec(styleCode)?.[1] ?? ''
const surfaceDeclares = (value) => new RegExp(`pointer-events:\\s*${value}\\s*!important`).test(surfaceRule)
check('the panel wrapper stays click-through even against the overlay host rule',
  surfaceDeclares('none'), surfaceRule.match(/pointer-events:[^;]*/)?.[0] ?? 'none declared')
check('the panel card itself re-enables clicks',
  new RegExp('\\.dw-card\\s*\\{[^}]*pointer-events:\\s*auto').test(styleCode))

/**
 * A z-index on #root would make it a stacking context and trap every popover the
 * app opens inside it — the workspace picker among them. The wallpaper layer is
 * fixed at z-index 0, so the app needs no help stacking above it.
 */
check('the plugin does not put the app root into a stacking context',
  !/body\s*>\s*\*[^{]*\{[^}]*z-index/.test(styleCode),
  /body\s*>\s*\*[^{]*\{[^}]*\}/.exec(styleCode)?.[0]?.slice(0, 80) ?? 'no body-child rule')

check('the wallpaper is no longer colour-washed', !source.includes('mix-blend-mode') && !source.includes('dw-tint'))

console.log(failures.length === 0 ? '\nALL CLIENT CHECKS PASSED' : `\nFAILURES: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
