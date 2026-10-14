/**
 * dsh-wallpaper UI-recolour verification.
 *
 *   node tools/ui-recolour-test.mjs
 *
 * The claim under test is not "the plugin sends colour tokens" but "the composer
 * bar, the session list, the menus and the hover states end up blue, in the mode
 * the user is actually in". Three links, all checkable without a browser:
 *
 *   1. the SHIPPED theme maps each surface alias to a neutral-bluish step, and
 *      binds aliases twice — light on `body`, dark on `body[data-ds-dark-theme]`
 *      (both read out of @deepseek-ai/dsh-client-ui-theme, not assumed here);
 *   2. the plugin re-hues every step the surfaces use, for every scheme;
 *   3. the resulting colours are saturated blue in DARK and still light in LIGHT,
 *      with the ramp's direction preserved — because a step that inverts would
 *      turn light mode into a navy page.
 */
import { readFileSync } from 'node:fs'

const THEME = process.env.DSH_THEME_BUNDLE
  ?? '/home/atlaslinux/.nvm/versions/node/v24.21.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js'
const CLIENT = new URL('../dsh-wallpaper/lib/client.js', import.meta.url)

/** The surfaces the user named, plus the rest of the frame they sit in. */
const SURFACES = [
  ['dsw-alias-bg-layer-1', 'composer bar / cards / main panel'],
  ['dsw-alias-bg-layer-2', 'menus and popovers'],
  ['dsw-alias-bg-layer-3', 'nested surfaces'],
  ['dsw-specific-sidebar-fill', 'conversation list column'],
  ['dsw-specific-sidebar-nav-item-hover', 'session row hover'],
  ['dsw-specific-sidebar-nav-item-active', 'session row selected'],
  ['dsw-alias-bg-module-platform', 'plugin/module surfaces'],
]

const failures = []
const check = (label, condition, detail) => {
  if (!condition) failures.push(label)
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`)
}

/** sRGB hex -> { hue, saturation, lightness }. */
function hsl(hex) {
  if (typeof hex !== 'string') return { hue: 0, saturation: 0, lightness: 0 }
  const value = hex.replace('#', '')
  const full = value.length === 3 ? [...value].map((c) => c + c).join('') : value
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(full.slice(offset, offset + 2), 16) / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  const lightness = (max + min) / 2
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1))
  let hue = 0
  if (delta !== 0) {
    if (max === r) hue = 60 * (((g - b) / delta) % 6)
    else if (max === g) hue = 60 * ((b - r) / delta + 2)
    else hue = 60 * ((r - g) / delta + 4)
  }
  if (hue < 0) hue += 360
  return { hue, saturation, lightness }
}

// ---- link 1: the shipped theme's own bindings ------------------------------
const themeSource = readFileSync(THEME, 'utf8')

/**
 * Pull one rule's declarations into an alias -> step map.
 *
 * The theme expresses a mode as a whole rule (`body[data-ds-dark-theme]{…}`)
 * full of literal values; the aliases inside it point at static steps. Reading
 * the rule — not "the text before the next selector" — is what makes this
 * reliable, and which rule is the dark one is decided by luminance, not order,
 * because on this build the light rule comes second.
 */
function ruleDeclarations(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, (character) => `\\${character}`)
  const map = new Map()
  // A selector can appear more than once: on this build the static palette and
  // the alias bindings are two separate `body{}` rules, so every match is read
  // and merged. Taking only the first would find the palette and none of the
  // aliases — silently, which is the worst way to be wrong.
  const pattern = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g')
  for (const match of themeSource.matchAll(pattern)) {
    for (const declaration of match[1].split(';')) {
      const separator = declaration.indexOf(':')
      if (separator < 0) continue
      map.set(declaration.slice(0, separator).trim(), declaration.slice(separator + 1).trim())
    }
  }
  return map
}

const flatDeclarations = (() => {
  const map = new Map()
  for (const match of themeSource.matchAll(/--(dsw-static-[a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})/g)) map.set(match[1], match[2])
  return map
})()

/** Resolve `var(--x)` chains down to a literal hex. */
function resolveValue(map, name, depth = 0) {
  if (depth > 6) return null
  const value = map.get(name)
  if (value === undefined) return null
  const reference = /^var\(--([a-z0-9-]+)\)$/.exec(value)
  if (reference === null) return value.startsWith('#') ? value : null
  return resolveValue(map, reference[1], depth + 1) ?? flatDeclarations.get(reference[1]) ?? null
}

/** The two palette rules, identified by the base background's luminance. */
const palettes = ['body', 'body[data-ds-dark-theme]'].map((selector) => {
  const map = ruleDeclarations(selector)
  const base = resolveValue(map, '--dsw-alias-bg-base')
  return { selector, map, base, lightness: base === null ? null : hsl(base).lightness }
})
const darkPalette = palettes.find((item) => item.lightness !== null && item.lightness < 0.3)
const lightPalette = palettes.find((item) => item !== darkPalette)
check('the theme exposes a light and a dark palette rule',
  darkPalette !== undefined && lightPalette !== undefined,
  palettes.map((item) => `${item.selector}=L${item.lightness?.toFixed(2) ?? '?'}`).join(' '))

const stepIn = (palette, alias) => {
  if (palette === undefined) return null
  const match = /^var\(--dsw-static-neutral-bluish-(\d+)\)$/.exec(palette.map.get(`--${alias}`) ?? '')
  return match === null ? null : match[1]
}
const bound = SURFACES.map(([alias, label]) => ({
  alias,
  label,
  lightStep: stepIn(lightPalette, alias),
  darkStep: stepIn(darkPalette, alias),
}))
check('every named surface is bound by the shipped theme in both modes',
  bound.every((item) => item.lightStep !== null && item.darkStep !== null),
  bound.map((item) => `${item.alias.replace('dsw-', '')}:${item.lightStep ?? '?'}/${item.darkStep ?? '?'}`).join(' '))
check('the light binding is a pale step and the dark binding a deep one',
  bound.every((item) => Number(item.lightStep) <= 100 && Number(item.darkStep) >= 750),
  'light ≤100, dark ≥750 — i.e. the ramp is directional')

// ---- link 2 + 3: the plugin's ramp overrides -------------------------------
const clientSource = readFileSync(CLIENT, 'utf8')
const hueSpecs = [...clientSource.matchAll(/hue:\s*(\d+),\s*saturation:\s*([\d.]+)/g)]
  .map((match) => ({ hue: Number(match[1]), ceiling: Number(match[2]) }))
check('the bundle declares one hue+saturation per scheme', hueSpecs.length === 4,
  hueSpecs.map((spec) => `${spec.hue}°/${spec.ceiling}`).join(' '))

const lightnessTable = Object.fromEntries(
  [...(/const RAMP_LIGHTNESS = \{([\s\S]*?)\}/.exec(clientSource)[1]).matchAll(/(\d+):\s*([\d.]+)/g)]
    .map((match) => [match[1], Number(match[2])]),
)
check('the ramp declares a curve for the surface steps', Object.keys(lightnessTable).length >= 18,
  `${Object.keys(lightnessTable).length} steps, white excluded: ${!('00' in lightnessTable)}`)
check('the ramp excludes pure white (the light page background)',
  !('00' in lightnessTable) && '1000' in lightnessTable,
  'white stays out; the dark base is recoloured')

/** Same maths the bundle uses, so this checks the recipe and not a copy of data. */
function hslToHex(hueDegrees, saturation, lightness) {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const hue = ((hueDegrees % 360) + 360) % 360
  const secondary = chroma * (1 - Math.abs(((hue / 60) % 2) - 1))
  const floor = lightness - chroma / 2
  const table = [
    [chroma, secondary, 0], [secondary, chroma, 0], [0, chroma, secondary],
    [0, secondary, chroma], [secondary, 0, chroma], [chroma, 0, secondary],
  ][Math.floor(hue / 60) % 6]
  return `#${table.map((channel) => Math.round((channel + floor) * 255).toString(16).padStart(2, '0')).join('')}`
}
const valueOf = (spec, step) => {
  const lightness = lightnessTable[step]
  if (lightness === undefined) return null
  const saturation = Math.min(spec.ceiling, spec.ceiling * (0.35 + 0.65 * (1 - lightness)))
  return hslToHex(spec.hue, saturation, lightness)
}
const luminance = (hex) => {
  const value = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a, b) => {
  const first = luminance(a)
  const second = luminance(b)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

const schemeNamesRamp = [...(/const SCHEME_HUES = \{([\s\S]*?)\n    \}/.exec(clientSource)?.[1] ?? '')
  .matchAll(/'?([a-z-]+)'?:\s*\{/g)].map((match) => match[1])

console.log('')
for (const [index, spec] of hueSpecs.entries()) {
  const name = schemeNamesRamp[index] ?? `scheme #${index + 1}`
  const steps = Object.keys(lightnessTable).map(Number).sort((a, b) => a - b)
  const values = steps.map((step) => valueOf(spec, step))
  // steps ascend, so lightness must fall: 50 is the palest, 1000 the deepest
  const lightnesses = steps.map((step) => hsl(valueOf(spec, step)).lightness)
  check(`${name}: the ramp stays directional (palest step first, deepest last)`,
    lightnesses.every((item, position) => position === 0 || item <= lightnesses[position - 1]),
    `${values[0]} L${lightnesses[0].toFixed(2)} → ${values[values.length - 1]} L${lightnesses[lightnesses.length - 1].toFixed(2)}`)

  // the columns the user named, resolved through their DARK binding
  const dark = bound.map((item) => ({ ...item, colour: valueOf(spec, item.darkStep) }))
  const light = bound.map((item) => ({ ...item, colour: item.lightStep === '00' ? '#ffffff' : valueOf(spec, item.lightStep) }))

  const saturationFloor = name === 'mono' ? 0.1 : 0.35
  check(`${name}: dark-mode columns are saturated blue`,
    dark.every((item) => hsl(item.colour).saturation >= saturationFloor && Math.abs(hsl(item.colour).hue - spec.hue) < 30),
    dark.map((item) => `${item.darkStep}→${item.colour} ${(hsl(item.colour).saturation * 100).toFixed(0)}%`).join(' '))
  check(`${name}: light-mode columns stay light (no navy page)`,
    light.every((item) => hsl(item.colour).lightness >= 0.9),
    light.map((item) => `${item.lightStep}→${item.colour}`).join(' '))

  // Contrast of the panel's own ink against every column colour, both modes.
  const worst = Math.min(
    ...dark.map((item) => contrast('#e8eefc', item.colour)),
    ...light.map((item) => contrast('#101c3a', item.colour)),
  )
  check(`${name}: panel text stays readable on every column in both modes (WCAG AA)`,
    worst >= 4.5, `worst ${worst.toFixed(2)}:1`)
}


// ---- the overlay seat's own rule, read from the installed shell -------------
/**
 * The panel registers in `shell.overlay`, whose host declares
 * `.overlayLayer > * { pointer-events: auto }`. Reading that rule out of the
 * installed package is what turns "the plugin must use !important" from a
 * comment into a checked fact: if the shell ever stops declaring it, this
 * reports it, and if the plugin drops its weight, the plugin-side check fails.
 */
const LAYOUT = process.env.DSH_LAYOUT_BUNDLE
  ?? '/home/atlaslinux/.nvm/versions/node/v24.21.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js'
const layoutSource = readFileSync(LAYOUT, 'utf8')
const hostRule = /[^{}]*overlayLayer\s*>\s*\*[^{}]*\{[^}]*\}/.exec(layoutSource)
check('the shell still force-enables pointer events on overlay children',
  hostRule !== null && /pointer-events:\s*auto/.test(hostRule[0]),
  hostRule === null ? 'rule not found (shell changed?)' : hostRule[0].replace(/^[^{]*/, ''))

const pluginCss = (/style\.textContent = `([\s\S]*?)`\n/.exec(readFileSync(CLIENT, 'utf8'))?.[1] ?? '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
const pluginSurface = /\.dw-surface\s*\{([^}]*)\}/.exec(pluginCss)?.[1] ?? ''
const pluginCard = /\.dw-card\s*\{([^}]*)\}/.exec(pluginCss)?.[1] ?? ''
check('the plugin neutralises that rule on its wrapper',
  /pointer-events:\s*none\s*!important/.test(pluginSurface),
  pluginSurface.match(/pointer-events:[^;]*/)?.[0] ?? 'none declared')
check('and re-enables clicks only on the panel card',
  /pointer-events:\s*auto/.test(pluginCard),
  pluginCard.match(/pointer-events:[^;]*/)?.[0] ?? 'none declared')

console.log(failures.length === 0 ? '\nSURFACES RECOLOUR CORRECTLY' : `\nFAILURES: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
