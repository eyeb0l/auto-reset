# Dashboard design

The full-screen reference is `dashboard-concept.png`, generated with the built-in image generation tool before implementation. It is a visual specification; its numbers and reset labels are illustrative, while the app reads the actual account data.

The prompt requested a complete simple Auto Reset dashboard with cool gray `#f6f7f9` background, white panels, dark ink text, emerald accents, centered content, no sidebar, no illustrations, and native interactive text and controls. It specified the exact heading “Make every reset count.”, the supporting sentence, current usage bars, banked reset count and next expiry, automatic reset settings, an available-reset table, an activity list, and the local-login footer. The final prompt also required responsive continuation and matching empty/error states without invented account metrics.

## Design system

- Background: cool gray `#f6f7f9`; surface: white; text: `#111827`; secondary text: `#778399`; border: `#dfe5ec`.
- Accent: emerald `#089d4e`; banked panel: `#eef9f2` with `#bde7cd` border. No image overlay, gradient, or background media.
- Typography: bundled Inter with system sans-serif fallback; 38px primary heading, 18px section headings, 14px labels and controls, 12px captions and table headers.
- Centered content, 2:1 overview columns, open header, 11px panel radii, 6px controls, 12–24px spacing. Mobile overview stacks; the compact banked summary splits internally, settings use two columns, and the reset table scrolls inside its boundary.
- Outline refresh icons use consistent SVG geometry and stroke widths. Green or muted circular dots identify connection/reset state. All icons inherit their surrounding text color.

## Copy and component inventory

Header: Auto Reset, connection state. Intro: heading, supporting sentence, Refresh. Overview: Current usage and Banked resets. Automation: Automatic resets, Enabled/Paused switch, “Apply the oldest reset before it expires.”, Apply before expiry, Check interval, Save settings. Reset table: Available resets, Reset/Expires/Status/Action, Apply now. Activity: Time/Action. Footer: “Uses your local Codex CLI login.”

Reusable components own the header, usage windows, banked summary, automation form, credit table, activity list, and refresh icon. The App component coordinates API requests and live state.

Intentional dynamic differences: window number and labels follow Codex; dates, titles, percentages, counts and activity follow the current account; save is disabled until settings change; errors and uncertain-attempt recovery add necessary notices; backend refusals appear as activity/notifications; every watched expiring credit is labeled Scheduled until it is Due soon. There are no standalone raster assets in the functional UI.

## Visual and interaction verification

Verification uses Playwright Chromium because no built-in Browser/IAB tool is exposed in this session. The native reference size is 1487 × 1058; mobile is checked at 390 × 844. Concept and implementation screenshots are inspected with `view_image`.

Final screenshots are `dashboard-desktop.png` and `dashboard-mobile.png`, captured by Playwright using full-page PNG screenshots with animations disabled. The desktop viewport is the native reference size, 1487 × 1058. The mobile viewport is 390 × 844. Screenshots use simulated account data so the main reference screen can be compared consistently. A separate live read-only check confirmed the actual account's weekly window, two full resets, connection state, and no mobile document overflow. No actual credit was consumed.

Both the reference and latest implementation screenshots were inspected directly with `view_image`. The implementation was faithfully verified against the reference. No material visual mismatches remain.

| Comparison | Reference evidence | Final render / resolution |
| --- | --- | --- |
| Layout | Centered header; intro; 2:1 usage/banked overview; settings, reset table, activity, footer | Preserved in order and aligned to the same main column. Corrected a too-narrow content column and excess vertical spacing. |
| Typography | Bold headline, compact section headings, restrained labels and captions | Bundled Inter locally; matched headline scale and control typography. Corrected the initial Linux fallback font's width and weight. |
| Palette | Cool gray page, white surfaces, emerald controls and pale green banked panel | Explicit colors match; no gradients, image overlays, or decorative media added. |
| Copy | Auto Reset; exact main heading and subtitle; Refresh; section headings; settings labels; footer | Above-the-fold copy matches the inventory. Values, window names and connection state are intentionally live. No unrelated labels or sections were introduced. |
| Containers | Small-radius panels, thin borders, a flat table and plain activity rows | Preserved; reduced initial panel padding and table row height to match the reference's density. |
| Icons and controls | Outline refresh mark, compact circular status dots, enabled switch, outlined and green buttons | Matching SVG geometry and stroke weight; corrected refresh alignment. Switch, selects, Refresh, Save settings and Apply now all respond. |
| Progress bars | Two labeled remaining-usage bars | The app uses the exact percentage as CSS width. The generated reference's illustrative bar lengths do not exactly match its numeric labels, so numerical accuracy is an intentional difference. |
| Responsive layout | A compact primary utility screen | At 390px, overview stacks, settings stay readable, the banked summary remains compact, and the table scrolls internally. No page overflow; controls were exercised in the mobile browser. |

Remaining intentional differences: current account data replaces illustrative values; all watched expiring credits are Scheduled until Due soon rather than assigning a decorative Watching state to later credits; Save settings is disabled until there is a change; necessary empty, error and pending-attempt states appear as data requires. The concept has no raster UI assets to extract, so all functional content is native HTML/CSS/React.

Functional verification: **17 service tests** and **6 Playwright browser tests** passed. The browser path included changing the expiry window, pausing automation, saving settings, refreshing, applying a simulated reset, verifying updated usage and counts, mobile scrolling/actions, empty/count-only responses, and stale-data error handling. Production build passed. Browser/IAB was unavailable; Playwright Chromium provided the browser verification and screenshots.
