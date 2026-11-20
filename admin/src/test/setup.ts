/**
 * Vitest setup (vite.config.ts `test.setupFiles`): browser APIs jsdom lacks but the app uses.
 * `??=` keeps any real implementation a future jsdom ships.
 */

// Theme ('system') and the sidebar's mobile breakpoint read media queries.
window.matchMedia ??= ((query: string) =>
  ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }) as unknown as MediaQueryList) as typeof window.matchMedia

// Animate UI's menus stagger their rows with the Web Animations API.
Element.prototype.animate ??= function () {
  return {
    finished: Promise.resolve(),
    playState: 'finished',
    cancel() {},
    finish() {},
    addEventListener() {},
    removeEventListener() {},
  } as unknown as Animation
}
Element.prototype.getAnimations ??= () => []

// The menus' check indicators test `instanceof SVGGeometryElement`.
globalThis.SVGGeometryElement ??= class extends SVGElement {} as typeof SVGGeometryElement

// Animate UI's Tabs highlight tracks the active tab's size.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

// Animate UI's CountingNumber watches visibility (motion's `useInView`).
globalThis.IntersectionObserver ??= class {
  readonly root = null
  readonly rootMargin = '0px'
  readonly thresholds = [0]
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
} as unknown as typeof IntersectionObserver

// Reply-box image previews (M7-T10). Unique URLs: previews are keyed by them.
let objectUrls = 0
URL.createObjectURL ??= () => `blob:http://admin.localhost/${(objectUrls += 1)}`
URL.revokeObjectURL ??= () => {}
