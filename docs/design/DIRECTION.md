# OmniBridge design direction

From S1, 18 Oct 2026. This is the starting brief for S2. S2 refines it with Hashir, then records the final tokens in `docs/design/README.md`. Decisions here are recorded as ADR-036 (palette and type) and ADR-037 (design workflow) in `docs/DECISIONS.md`.

## 1. What the UI must feel like

A calm, fast, professional back office that people use for hours a day: packing staff on a tablet at the shipping desk, admins reading profit and VAT figures.

**Dense but readable.** Show real data, not decoration. Every screen should answer "what do I need to act on?" first.

## 2. Colour (decided by S1; S2 may tune shades, not the roles)

**We keep the JeezMart navy, and we do not use the orange as an accent.**

- **Why navy:** it is calm, trustworthy and accessible on white. It also suits finance figures.
- **Why no orange:**
  - In a back office, orange means *warning*. Design systems such as Salesforce Spark and J.P. Morgan Salt reserve it for warnings and keep accents out of the status colours.
  - OmniBridge shows many alerts (Oversold, Tracking not confirmed, health amber), so an orange "Create label" button would compete with them.
  - OmniBridge is also a multi-tenant product, not the JeezMart shop. It should not wear the shop's brand.

| Token | Value | Use |
|---|---|---|
| `brand-900` | `#1B2A6B` | Primary buttons, active navigation, brand mark |
| `brand-600` | `#3550C8` (tune for 4.5:1 on white) | Links, focus rings, selected states, info |
| `brand-100` | `#DDE5FC` | Selected rows, active filter chips, subtle highlights |
| `ink` | `#0B1221` | Body text |
| `ink-muted` | slate ~`#5B6475` (≥4.5:1 on white) | Secondary text, column headers |
| `surface` | `#F0F2F5` | App background |
| `card` | `#FFFFFF` | Panels, tables, dialogs |
| `border` | slate ~`#D9DDE4` | Dividers, inputs |
| `success` | green ~`#15803D` | Confirmed, Delivered, healthy |
| `warning` | amber ~`#B45309` | Warning alerts, amber health |
| `danger` | red ~`#B91C1C` | Critical alerts, destructive actions, red health |

**Rules:**

- Status colours are used **only** for status, and always with an icon **and** a text label. Colour is never the only signal (WCAG 2.1 AA).
- Company badges (TEN-2 badge colour) come from a separate muted categorical set of 8 hues: teal, violet, cyan, magenta, olive, brown, indigo, slate. They must never look like a status colour.
- No gradients, glass effects or coloured shadows. One accent family (navy) only.
- Light theme first. Keep the tokens dark-mode-ready, and ship dark mode only after the client signs off the light theme.

## 3. Type and numbers

- **Font:** Inter (variable, OFL-1.1), self-hosted with `@fontsource-variable/inter`. No Google Fonts calls, because the CSP is strict.
- **Sizes:**
  - base 14 px
  - table text 13 px
  - labels 12 px
  - page titles 20–24 px
  - weights 400 / 500 / 600 only
- **Numbers:** every number, money and date uses `font-variant-numeric: tabular-nums`, so columns line up. Order refs and IDs also use the slashed-zero feature (`zero`).
- **Alignment:** money and quantities are right-aligned. Pounds are shown as £1,234.56; dates as DD/MM/YYYY; times in Europe/London (NFR-9).
- **Icons:** one icon set only, lucide-react 1.55.0 (ISC). No emoji in the UI.

## 4. Layout and density

- **App shell:** left sidebar showing only the tabs the user may see. The top bar holds the company switcher with "Combined" (TEN-5), global search (Ctrl+K command palette) and the notification bell.
- **Spacing:** a 4 px grid. Corner radius 6 px on controls and 8 px on cards, used consistently, not "rounded everything".
- **Tables:**
  - default row 36 px, "comfortable" 44 px
  - sticky header, first column pinned
  - thin row dividers (no zebra by default)
  - secondary info as subtext under the main value, rather than an extra column
- **Toolbar above every list:** search, filters (shown as removable chips), column picker, export, and bulk actions that appear only when rows are selected.
- **Filters** live in the URL, so a filtered list can be shared and the back button works.
- **Tablet:** the shipping desk and orders must work on a tablet (NFR-8). Touch targets are at least 40 px there.

## 5. Speed budget (S4 checks these)

- Initial JavaScript ≤ 200 KB gzip. Each tab is a separate code-split route, prefetched on hover.
- Lists of any size render through TanStack Virtual, with server pagination at 50 rows.
- Show a skeleton only if loading takes longer than 300 ms. No layout shift when data arrives.
- Use optimistic updates for small edits (mark read, toggle).
- Motion is at most 150 ms and only for state changes such as open/close or toast. It respects `prefers-reduced-motion`.
  - **No GSAP, Lenis, scroll effects or parallax** anywhere in the app.
  - The public site (M06) may use light, CSS-only motion.
- Target Lighthouse Performance ≥ 90 and Accessibility 100 on a production build served locally.

## 6. Anti-"AI slop" checklist (reject a screen that does any of these)

- big hero cards, giant numbers or decorative illustrations on working screens
- gradients, glass, glow, neon, or many accent colours
- emoji, mixed icon sets, or icons with no label where the meaning is not obvious
- generic copy ("Supercharge your workflow"). Use plain operational words ("3 orders past ship-by").
- inconsistent spacing, radius or font sizes between similar elements
- empty states with no next action. Every empty state says what to do.
- hidden critical information. Alerts that need action are visible without hovering.

## 7. Skills S2 should use

These help with taste. **They never override this document, the speed budget or WCAG.**

- `/frontend-design`: overall direction and avoiding templated looks.
- `/design-taste-frontend`: the anti-slop pre-flight check before showing Hashir a screen.
- `/apple-design`: restraint, typography and feedback (not its gesture or spring animations).
- `/minimalist-ui` and `/ui-ux-pro-max`: palettes, spacing and component review, as needed.
- Do **not** use skills that push heavy motion (GSAP, scroll storytelling) for the app.

## 8. Sources

- [Salesforce Spark design system: colour usage](https://deploy-preview-1018--spark-design-system.netlify.com/using-spark/foundations/color)
- [J.P. Morgan Salt: semantic use of colour](https://main.saltdesignsystem.com/salt/foundations/color/semantic-use-of-color)
- [SAP Fiori: semantic colours](https://www.sap.com/design-system/fiori-design-web/v1-142/foundations/best-practices/ui-elements/how-to-use-semantic-colors)
- [Data tables for enterprise finance (density)](https://dev.to/deeflect/data-tables-are-the-hardest-ui-problem-nobody-talks-about-2dan)
- [Data table guide 2026](https://lollypop.design/blog/2026/march/the-ultimate-guide-to-designing-user-friendly-data-tables/?p=24042)
- [Inter font: tabular numbers, OFL](https://github.com/rsms/inter)
