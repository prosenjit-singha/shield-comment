# Shared Design System: Animate UI, shadcn/ui OKLCH Tokens & Frontend Standards

> **Parent Index:** [`../README.md`](../README.md) | **Admin UI:** [`./admin.md`](./admin.md) | **Client UI:** [`./client.md`](./client.md)

## 1. Component Library & Theme Token Standard
- **Component Library:** Both `admin/` and `client/` use **[Animate UI](https://animate-ui.com/docs)** (`npx @animate-ui/cli@latest animate all`), which wraps Radix UI / [shadcn/ui](https://ui.shadcn.com/docs/theming) primitives with restrained, GPU-composited Motion animations and built-in `prefers-reduced-motion` support.
- **Standard shadcn/ui OKLCH CSS Variables (No Custom Variable Names):**
  Define directly in `globals.css` under `:root`, `.dark`, and `@theme inline`:

```css
:root {
  --background: oklch(1 0 0);               /* #FFFFFF */
  --foreground: oklch(0.145 0.02 260);      /* #0F172A */
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0.02 260);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.145 0.02 260);
  --primary: oklch(0.51 0.21 258);          /* Meta Blue #005CDA (darkened from #0668E1 for 4.5:1, M9-T9) */
  --primary-foreground: oklch(0.985 0 0);   /* #FFFFFF */
  --secondary: oklch(0.5 0.24 14);          /* Fuchsia #C70037 (darkened from #FE2C55 for 4.5:1, M9-T9) */
  --secondary-foreground: oklch(0.985 0 0);
  --accent: oklch(0.88 0.14 192);           /* TikTok Cyan #25F4EE */
  --accent-foreground: oklch(0.145 0.02 260);
  --muted: oklch(0.968 0.007 247);          /* #F8FAFC */
  --muted-foreground: oklch(0.45 0.03 257); /* #475569 */
  --destructive: oklch(0.62 0.24 14);       /* #FE2C55 */
  --border: oklch(0.929 0.013 255);         /* #E2E8F0 */
  --input: oklch(0.929 0.013 255);
  --ring: oklch(0.51 0.21 258);
  --radius: 1rem;                           /* 16px base */
}

.dark {
  /* brand tokens only; the rest: same hues, adjusted lightness (see globals.css) */
  --primary: oklch(0.72 0.14 258);          /* #6BA5FB */
  --primary-foreground: oklch(0.145 0.02 260);  /* dark text: white can't reach 4.5:1 on a blue that also reads as text on dark surfaces */
  --secondary: oklch(0.74 0.16 14);         /* #FF7B8C */
  --secondary-foreground: oklch(0.145 0.02 260);
}
```
- **Contrast (WCAG AA, M9-T9):** `--primary`/`--secondary` pass 4.5:1 with their foreground, as text on `--background`/`--card`, and as `text-*` on their own `/10` tint over `--muted` (landing pills), in both modes. `--ring`, `--sidebar-primary`, `--chart-1`/`--chart-2` track the same values; `client/src/lib/contrast.test.ts` checks the pairs.
Color references: [ColorBase Meta](https://colorbase.in/brands/meta), [Meta Brand Guidelines](https://www.meta.com/brand/resources/facebook/logo/), [Mobbin TikTok](https://mobbin.com/colors/brand/tiktok).

## 2. Rounded & Circular UI Geometry
- **Buttons, Pills, Badges, Toggles, Avatars:** Always `rounded-full` (`9999px`).
- **Cards, Bento Grids, Modals:** `rounded-2xl` (`16px`) to `rounded-3xl` (`24px`).
- **Inputs & Selects:** `rounded-full` or `rounded-xl` (`12px`).

## 3. Typography & Bangla Rendering
- **English:** `Plus Jakarta Sans` or `Inter` (`font-display: swap`).
- **Bangla Unicode:** `Hind Siliguri` or `Noto Sans Bengali` (`font-display: swap`).

## 4. Routing, Auth, State Management & Data Fetching
Full stack details: [`../project-documentation/tech-stack.md`](../project-documentation/tech-stack.md).
- **Routing:** File-based [TanStack Router](https://tanstack.com/router/latest) routes in `src/routes/`. `admin/` is a Vite SPA. `client/` uses [TanStack Start](https://tanstack.com/start/latest) (SSR for public pages). Use `beforeLoad` for guards, `loader` + `queryClient.ensureQueryData` for prefetching, `validateSearch` for typed filters, and `pendingComponent` / `errorComponent` for loading and error states.
- **Auth:** [Better Auth](https://www.better-auth.com/) React client (`authClient`). The session is an `httpOnly` cookie. Read it through TanStack Query (`sessionQueryOptions`), never from Zustand or `localStorage`.
- **Zustand (`zustand`):** Client-side global UI state (selected workspace, language `'en' | 'bn'`, theme, UI filters, modals).
- **TanStack Query (`@tanstack/react-query`):** All API requests (same-origin `/api/*`), caching, pagination, and mutations, including Better Auth calls.
