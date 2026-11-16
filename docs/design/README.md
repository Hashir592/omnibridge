# OmniBridge design notes

Owner: S2. Status: **locked by Hashir and S1 on 19/10/2026 (T-0301)**. Small tweaks continue in T-0302. The source of truth for values is `apps/ui/src/styles.css`; this file lists every token with its value and use. The starting brief is `docs/design/DIRECTION.md`; Hashir's overrides of it are listed at the end.

## Screens and reference images

Screenshot tests cover **4 key screens only** (ADR-046). Every other screen (Home, the tablet orders list, the desktop shipping desk, the other auth screens) is covered by axe, keyboard and component tests, with no screenshot. Adding a screen to this list needs Hashir.

| Screen | Route | Reference images (`docs/design/reference/`) |
|---|---|---|
| Orders list (desktop) | `/orders` | `orders-win32.png`, `orders-linux.png` |
| Order detail (desktop) | `/orders/ord_0039` | `order-detail-*.png` |
| Shipping desk (tablet, 820 px) | `/shipping` | `shipping-tablet-*.png` |
| Sign in (desktop, T-0303) | `/sign-in` | `sign-in-*.png` |

Each screen has one image per platform (`-win32` for local runs, `-linux` for CI), because fonts rasterise differently. The Playwright project `ui` (`apps/ui/e2e/mockups.spec.ts`, `apps/ui/e2e/auth.spec.ts`) compares each screen with its image (at most 1% of pixels may differ), at 1440 x 900 or 820 x 1180, with the clock fixed at 19/10/2026 10:00 UTC. Linux images are refreshed with `scripts/ui-refs.sh`. Changing a reference image needs Hashir's approval.

## Auth screens (T-0303)

Sign in, TOTP code, recovery code, MFA set-up, forgot and reset password, accept invite and the workspace picker, at `/sign-in`, `/sign-in/code`, `/sign-in/recovery`, `/sign-in/set-up-mfa`, `/forgot-password`, `/reset-password?token=`, `/invite/:token` and `/workspaces`. They sit outside the app shell in `AuthFrame` (`apps/ui/src/routes/auth/layout.tsx`): at 1024 px and wider, a graphite product panel on the left and logo, form and footer on the right; below 1024 px the panel is hidden. Form messages use `Notice`: icon and coloured text only.

## Client preview screens (T-0305)

Mock-ups on MSW synthetic data for every other tab, built from the kit only: Stock & Catalogue (`/stock`, `/stock/:skuId`, tablet layout included), Sales & Profit, Finance (VAT quarters, expenses, P&L), Account Health (Amazon and eBay tabs), Users (`/users`, `/users/:userId`), Connections, Customer Service, Advertising, Forecasting, Reminders, Notes, the notification panel behind the bell, Audit Log, Settings and the password-change screen (`/sign-in/password-change`). Shared pieces: `components/Card.tsx` (card, page header, figure, details row, simple table), `components/Statement.tsx` (money statements), `components/TabGate.tsx` (permission mirroring for a shared link) and `components/NoCustomerDetails.tsx` (the TOOL-3 line and warning). The only chart is the Sales & Profit bar and line chart (Recharts): petrol for this period and a dashed grey line for the comparison, with a legend and a "Show table" view. Warnings are plain icon and text, never a tinted box. These screens have axe and keyboard tests (`apps/ui/e2e/preview.spec.ts`) and no screenshot tests (ADR-046). The PNG set sent to the client is in `client-preview/20261021/`, made by `apps/ui/scripts/client-preview.mjs`.

## Client changes, round 2 (T-0306)

The client's seven changes (`docs/plan/client-changes-20261112.md`) on the same mock data: the Home quick view per channel (C1), the Orders SKU column (C2), same-buyer groups on Orders, the shipping desk and order detail with Ship together and Not the same buyer (C3), the order Profit table with Ex VAT, VAT and Inc VAT (C4), Amazon seller feedback and recovery estimates on Account Health (C5), Amazon buyer messages and the Buyer messages setup on Connections (C6), and manual stock allocation on the SKU detail (C7). Shared pieces: `components/sameBuyer.tsx` (rail, chip, notes, dialogs), `components/channelLogos.tsx` and the kit table's `rowAccent` and `rowTone` hooks. Tests: `apps/ui/e2e/preview.spec.ts` and `apps/ui/src/mocks/groups.test.ts`. The PNG set is in `client-preview/20261112/`.

## Public site (M06, S2 with Hashir, 17 Nov 2026)

- `apps/site`: same tokens as the app (petrol accent, graphite for the one dark band), Inter Variable self-hosted from `@fontsource-variable/inter` 5.3.0 (ADR-036, now also a site dependency) with the latin file preloaded. Page width 84rem; prose 42rem.
- Home: three-line headline with "marketplace sellers" in petrol; the "bridge" figure (channels → OmniBridge mark → stock, orders, labels, profit and VAT) is static HTML + SVG, no animation; orders screenshot at 2x (2880x1800), never taller than the window.
- Privacy and terms use `layouts/Legal.astro` (contents list built at build time, wording unchanged). New `/amazon` and `/ebay` pages, wording drafted from PRD 3.1–3.3 and 7.3, pending client review.
- No script, inline style or outside request (WWW-3, CSP in `infra/docker/site-sws.toml`).

## Colour tokens

Tailwind 4 `@theme` tokens; use them as `bg-<token>`, `text-<token>` and so on. Contrast ratios are against white unless stated.

| Token | Value | Use |
|---|---|---|
| `brand-900` | `#0B5A55` | Text on brand tints |
| `brand-800` | `#0B5A55` | Hover state of primary buttons |
| `brand-700` | `#0F6B66` | Primary buttons (Create label, Create labels, Print labels). White text on it 6.3:1 |
| `brand-600` | `#0F766E` | Links, the focus ring, status progress ticks, info status icons. 5.4:1 |
| `brand-50` | `#ECF6F4` | Highlight behind brand text (command palette) |
| `ink` | `#121519` | Body text |
| `ink-muted` | `#5C6370` | Secondary text, column headers, subtext. 6.0:1 |
| `ink-faint` | `#9AA1AB` | Decorative only: empty-cell dashes, disabled pager arrows. Never for text that carries meaning |
| `surface` | `#EEF0F3` | App background behind cards |
| `rail` | `#F7F8FA` | Table header rows |
| `card` | `#FFFFFF` | Cards, tables, dialogs, top bar |
| `hover` | `#F5F7F9` | Row and menu-item hover |
| `border` | `#DDE1E7` | Card borders, inputs, outlined buttons |
| `divider` | `#ECEEF2` | Lines between rows inside a card |
| `side` | `#181B21` | Sidebar, bulk-action bar, active view tab, current page, secondary dark buttons |
| `side-hover` | `#23272F` | Hover on graphite surfaces |
| `side-active` | `#2E333D` | Active sidebar item (with a 2 px white edge) |
| `side-text` | `#D9DCE2` | Text on graphite. 12.7:1 on `side` |
| `side-muted` | `#9AA0AB` | Labels on graphite (workspace, Admin). 6.6:1 on `side` |
| `selected` | `#E9EEF6` | Selected rows and active filter chips; checkboxes are graphite |
| `success` / `success-bg` | `#15803D` / `#E8F4EA` | Status only: Delivered, confirmed tracking, label created. 5.0:1 |
| `warning` / `warning-bg` | `#B45309` / `#FCF1E3` | Status only: amber alerts, unmapped, address shortened, tracking not confirmed. 5.0:1 |
| `danger` / `danger-bg` | `#B91C1C` / `#FBEAEA` | Status only: overdue, oversold, critical alerts, failed labels, negative profit. 6.5:1 |
| `co-teal` ... `co-slate` | `#2F7F7A`, `#7357B0`, `#2A7F9E`, `#A3477F`, `#7A7A2E`, `#8A5A3C`, `#4B5BB0`, `#5F6B7D` | Company badge swatches (TEN-2), muted categorical set; never used for status |

Rules:

- **One accent family:** petrol, used only for primary actions, links, focus and status progress.
- **Graphite** marks "where you are" and "what you picked": the sidebar, active tabs, the current page and the bulk bar.
- **Status colours are for status only**, always with an icon and a text label.
- No gradients, glass, glow or coloured shadows. Light theme only; dark mode comes after client sign-off.

## Type

| Token / rule | Value | Use |
|---|---|---|
| `font-sans` | Inter Variable (`@fontsource-variable/inter` 5.3.0, self-hosted) | Everything |
| Page title | 22 px / 28 px, weight 600, tracking -0.015em | `h1` on each screen |
| Card title | 14 px, weight 600 | Card headers |
| Base | 14 px / 20 px | Body |
| `text-13` | 13 px / 18 px | Table cells, buttons, form fields |
| Small | 12 px / 16 px, `ink-muted` | Subtext under a value, column headers, notes |
| Weights | 400, 500, 600 only | |
| `num` utility | `tabular-nums` | Every number, amount and date, so columns line up |
| `ref` utility | `tabular-nums` (no slashed zero) | Order refs, SKUs, tracking numbers |

Money is right-aligned and shown as £1,234.56 from integer pence. Dates are DD/MM/YYYY and times are Europe/London. Recent dates read "Today, 10:28" and "Yesterday, 17:45"; ship-by reads "Overdue 2 days", "Today, 19:05", "Tomorrow, 07:54" or "In 3 days".

## Spacing, shape and depth

| Token / rule | Value | Use |
|---|---|---|
| Grid | 4 px | All padding and gaps |
| `radius-ctl` | 8 px | Buttons, inputs, selects, menu items (6 px inside dense bars) |
| `radius-card` | 12 px | Cards, tables, popovers, dialogs |
| Fully round | 9999 px | View tabs, filter chips, counts, search field, company switcher |
| `shadow-card` | `0 1px 2px rgba(16,24,40,.05), 0 1px 1px rgba(16,24,40,.03)` | Cards and outlined controls |
| `shadow-pop` | `0 8px 24px rgba(16,24,40,.14)` | Menus, dialogs, the bulk bar |
| Table rows | 56 px, one height everywhere (no density toggle) | Two-line cells: value plus 12 px subtext |
| Sidebar | 224 px graphite; below 1024 px a menu button opens it as a drawer | |
| Touch | On coarse pointers every button, tab, input and sidebar link is at least 40 px tall | Shipping desk and orders on a tablet (NFR-8) |
| Motion | None decorative; state changes only, at most 150 ms, off under `prefers-reduced-motion` | |

## Components settled in T-0301 (built properly in T-0302)

- **Status:** a coloured icon and a plain label. Open orders get four ticks underneath (paid, label, dispatched, delivered); closed orders show the label only.
- **Channel cell:** a 2-column grid. Row 1 is the channel glyph and name; row 2 is the company dot and trading name.
- **Lists:** view tabs with counts, a toolbar (search, filter menus, column picker), removable filter chips, the bulk bar in the toolbar's slot, then numbered pages with 20, 50 or 100 rows (default 50). Filters, page and size live in the URL.
- **Alerts:** a full-width strip in the status colour with a bold title and one plain sentence on what to do.
- **PII:** full buyer details only on order detail and the shipping desk, with the note "Each view is logged". Lists show the masked form only.

## Overrides of DIRECTION.md

Each change Hashir asked for that departs from `docs/design/DIRECTION.md` (S1 to fold these into DIRECTION.md; see PS-011):

| Date | DIRECTION.md said | Now | Why |
|---|---|---|---|
| 18/10/2026 | Accent is navy `#1B2A6B` (§2) | Deep petrol: `brand-700 #0F6B66` for primary buttons; `brand-600 #0F766E` for links, focus and status progress. Still one accent family, still no orange. | Hashir: navy felt dated |
| 19/10/2026 | Sidebar colour not specified (navy implied) | Graphite sidebar `#181B21`. The same graphite marks the active view tab, the current page and the bulk-action bar, so petrol is left for primary actions, links and status. | Hashir: cream (18/10) and then dark petrol (19/10) were rejected; too much green overall |
| 19/10/2026 | Cool slate neutrals (§2) | Kept cool: page `#EEF0F3`, white cards and white top bar. Cream was tried on 18/10 and rejected for lack of contrast. | Hashir: no cream fill; panels must stand out |
| 18/10/2026 | Radius 6 px on controls, 8 px on cards (§4) | 8 px controls, 12 px cards; fully round tabs, chips, counts and the search field | Hashir asked for rounder corners |
| 19/10/2026 | Rows 36 px default, 44 px comfortable, with a density toggle (§4) | One row height, 56 px, on every screen. No density toggle. | Hashir: comfortable rows read best |
| 18/10/2026 | Order refs use the slashed-zero feature (§3) | Tabular numbers only | Hashir found refs hard to read; refs are digits only |
| 19/10/2026 | Status as a tinted chip | Coloured icon, plain label, lifecycle ticks | Hashir: the pill chips looked generic |
| 19/10/2026 | Lists scroll through TanStack Virtual with server pages of 50 (§5) | Numbered pages of 20, 50 or 100 rows (default 50), in the URL. Each page still renders through TanStack Virtual. | Hashir: scrolling through thousands of orders is bad |
| 20/10/2026 | Not covered | Auth screens use a split screen: graphite panel with a one-line product statement and four plain facts (left), form with logo and footer (right). No illustration or gradient. | Hashir: a lone centred card on an empty page looked unfinished; he chose the panel on the left |
| 20/10/2026 | Not covered | Form errors and notices are inline: icon plus coloured text, no tinted box or border | Hashir: tinted alert boxes read as AI slop |
| 19/10/2026 | Selected rows use `brand-100` (§2) | Selected rows and active filter chips use `selected #E9EEF6`; checkboxes are graphite | Hashir: a second green for selection was confusing |

| 14/11/2026 | Not covered | Same-buyer groups: every member row has the light petrol tint (`brand-50`), a 4 px petrol rail and a thin bracket; the first row has the chip and the others show "2 of 3". | Hashir: the first version (rail and chip only) was hard to see |
| 14/11/2026 | One icon set, no brand colours | Channel marks are small inline SVG logos (Amazon, eBay) in their own brand colours, only inside the 18 px mark, always next to the channel name. The Website mark is a generic graphite cart (T-0307): it must never be a shop's own logo; a per-workspace logo comes with the website connection in M11 (ADR-057) | Hashir: the a, e, w letters looked unprofessional |
| 14/11/2026 | Status colours only for status | Rating stars are golden (`#FFA41C` fill, `#E47911` outline; empty `#C9CED6`), the industry standard | Hashir |
| 14/11/2026 | Orders list columns | Items, Ship to and Shipping start hidden in Columns, so the SKU column and same-buyer notes fit at 1440 px | S2, for C2 and C3 |
| 14/11/2026 | Not covered | Ship together lets the user untick orders for that one label, or take an order out of its group for good | Hashir; recorded in PS-021 for S1 to confirm |

The first mock company's badge hue moved from teal to indigo, so a company badge never resembles the accent (TEN-2 rule).
