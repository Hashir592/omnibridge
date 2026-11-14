# OmniBridge client preview, round 2 (12/11/2026)

The client's seven changes (C1 to C7, `docs/plan/client-changes-20261112.md`) as mock-ups, in click-through order. All data is synthetic. Every screen is 1440 x 900. These images are for review only; they are not test references (ADR-046).

Regenerate with the dev server running: `node apps/ui/scripts/client-preview.mjs docs/design/client-preview/20261112 changes`.

| File | Change | What it shows |
|---|---|---|
| `01-home-orders-today-quick-view.png` | C1 | Home, Orders today: the eBay chevron is open, showing today's latest 10 eBay orders (ref, time, company, total, status; no buyer details) and "View all 15". One channel opens at a time; Esc closes it. |
| `02-orders-sku-column-and-same-buyer-group.png` | C2, C3 | Orders: the new SKU column (first SKU, "+1" opens every SKU and quantity, unmapped lines marked). Three orders from one buyer sit together with a petrol rail and bracket, the "Same buyer · 3 orders" chip and the group's warning. |
| `03-orders-same-buyer-menu.png` | C3 | The chip's menu: the orders in the group, its warnings (different ship-by dates, one Next Day order, a shortened address), and Ship together, Show only this group, Not the same buyer. |
| `04-orders-related-order-not-shown.png` | C3 | With the Due today filter, one member is shown with "+2 related orders not shown"; clicking it shows the whole group. |
| `05-ship-together-dialog.png` | C3 | Ship together: one label for the group, with the summed weight plus one packaging allowance, the earliest ship-by, and the highest service needed (Next Day), which can be changed. |
| `06-not-the-same-buyer-dialog.png` | C3 | Not the same buyer: dismisses the group for good, with a reason kept in the audit log. |
| `07-shipping-desk-same-buyer-group.png` | C3 | The shipping desk shows the same group: adjacent rows, rail and bracket, chip and warning, each row with its own checkbox. |
| `08-order-detail-same-buyer-panel.png` | C3 | Order detail: the "Same buyer" panel links the other orders in the group. |
| `09-order-detail-profit-ex-and-inc-vat.png` | C4 | Order detail, Profit: one table with Ex VAT, VAT and Inc VAT (profit £13.43 / £2.70 / £16.13), the margin line and the note on net VAT; estimated fees are marked. |
| `10-account-health-amazon-seller-feedback.png` | C5 | Account Health, Amazon: each account card now has Seller feedback: 12-month stars and rating count, positive/neutral/negative for 30 days, 90 days and 12 months, the newest comments with order links, and "Reply or ask for removal in Seller Central". |
| `11-account-health-recovery-estimate.png` | C5 | On an amber or red metric, a line marked Estimate says when it recovers on its own (for example, when late shipments leave the 30-day window). The eBay tab is unchanged. |
| `12-customer-service-amazon-messages.png` | C6 | Customer Service, Amazon messages: one inbox per Amazon account, kept apart from eBay, with unread counts, "Reply due in 5 h" timers, the thread, mark unread or done, and a plain-text reply with a 4,000-character counter. |
| `13-connections-amazon-buyer-messages-setup.png` | C6 | Connections: each Amazon card has a Buyer messages panel with its own inbound address, the two Seller Central steps (Buyer Messages address, approved sender) and a Send test check. |
| `14-stock-list-manual-and-mixed.png` | C7 | Stock list: BB-BAM-M100 shows the Manual badge and the next SKU shows Mixed. |
| `15-sku-detail-manual-allocation.png` | C7 | BB-BAM-M100 with Stock sync on Manual: an allocation per merchant-fulfilled listing, sold since set and the live target; one listing is capped by stock and one allocation is used up; FBA cannot be set. "Allocated 260 · Available 186" with a plain warning, and Save with a confirm. |
| `16-sku-detail-back-to-auto-results.png` | C7 | Back to Auto: each listing is pushed straight away and the results are shown (sent, held by the eBay revision limit, failed and retrying). |
