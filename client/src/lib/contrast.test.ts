// @vitest-environment node
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// WCAG AA (4.5:1) for the brand tokens in both apps (D9, M9-T9; docs/design/base.md §1).
// Tiny OKLCH → sRGB conversion (Björn Ottosson's matrices, per-channel clip like Chrome) + WCAG luminance.
type Rgb = [number, number, number]

function oklchToSrgb(l: number, c: number, h: number): Rgb {
  const a = c * Math.cos((h * Math.PI) / 180)
  const b = c * Math.sin((h * Math.PI) / 180)
  const L = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const M = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const S = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  const lin = [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ]
  return lin.map((v) => {
    const x = Math.min(1, Math.max(0, v))
    return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055
  }) as Rgb
}

const linear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const luminance = ([r, g, b]: Rgb) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
const contrast = (x: Rgb, y: Rgb) => {
  const [a, b] = [luminance(x), luminance(y)]
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}
/** `bg-token/10` composited over `under` (sRGB blend, as the browser paints it). */
const tint = ([r, g, b]: Rgb, [ur, ug, ub]: Rgb, alpha = 0.1): Rgb => [
  r * alpha + ur * (1 - alpha),
  g * alpha + ug * (1 - alpha),
  b * alpha + ub * (1 - alpha),
]

function tokens(file: string, block: ':root' | '.dark'): (name: string) => Rgb {
  const css = readFileSync(file, 'utf8')
  const start = css.indexOf(`\n${block} {`)
  const body = css.slice(start, css.indexOf('}', start))
  const out: Record<string, Rgb> = {}
  for (const [, name = '', l, c, h] of body.matchAll(/--([\w-]+):\s*oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/g)) {
    out[name] = oklchToSrgb(Number(l), Number(c), Number(h))
  }
  return (name) => out[name] ?? expect.fail(`--${name} missing in ${block} of ${file}`)
}

const files = {
  client: path.resolve(import.meta.dirname, '../globals.css'),
  admin: path.resolve(import.meta.dirname, '../../../admin/src/globals.css'),
}

describe.each(Object.entries(files))('%s brand token contrast', (_app, file) => {
  describe.each([':root', '.dark'] as const)('%s', (block) => {
    const t = tokens(file, block)
    it.each(['primary', 'secondary'])('--%s passes 4.5:1 as a fill, as text and as a tinted pill', (name) => {
      const color = t(name)
      expect(contrast(color, t(`${name}-foreground`))).toBeGreaterThanOrEqual(4.5)
      for (const surface of ['background', 'card', 'muted']) expect(contrast(color, t(surface))).toBeGreaterThanOrEqual(4.5)
      expect(contrast(color, tint(color, t('muted')))).toBeGreaterThanOrEqual(4.5)
    })
  })
})

it('helper matches what Chrome reports', () => {
  // Lighthouse saw #3082f6 for the old dark --primary oklch(0.62 0.19 258).
  const hex = oklchToSrgb(0.62, 0.19, 258).map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')
  expect(hex).toBe('3082f6')
})
