# OmniBridge client preview, 21/10/2026

Design mock-ups of every main area, in click-through order. All data is synthetic: the companies, accounts, people, orders and figures are invented for the preview. Screens are 1440 x 900 (desktop) unless marked tablet (820 x 1180). These images are for review only; they are not test references (ADR-046).

Regenerate with the dev server running: `node apps/ui/scripts/client-preview.mjs docs/design/client-preview/20261021`.

| File | What it shows |
|---|---|
| `01-sign-in.png` | Sign in: email and password, then a code from an authenticator app (two-step sign-in is required for everyone). |
| `02-home.png` | Home: what needs action first (authorisation lost, oversold, tracking), then today's orders, sales, dispatch and reminders. |
| `03-orders.png` | Orders list: saved views with counts, filters, status with progress ticks, ship-by, numbered pages. Buyer details are masked. |
| `04-order-detail.png` | One order: items, profit breakdown, history, full ship-to address (each view is logged), label and notes. |
| `05-shipping-desk.png` | Shipping desk: pick orders due today, choose carrier and service, create labels in a batch. |
| `06-stock-list.png` | Stock & Catalogue: every Master SKU with status, available and on-hand stock, days of cover (estimate), listings per channel, VAT type and COGS. |
| `07-stock-list-tablet.png` | The same stock list on a tablet: fewer columns, larger touch targets. |
| `08-stock-unmapped-listings.png` | Unmapped listings: channel listings whose SKU matches no Master SKU, with a suggested match and a Map button. |
| `09-sku-detail.png` | One SKU: stock numbers, stock per channel listing (buffer, quantity on the channel, last push), stock by location (own stock vs Amazon FBA), movements, COGS history and reorder settings. |
| `10-sku-detail-tablet.png` | The same SKU page on a tablet, in one column. |
| `11-sales-profit.png` | Sales & Profit: period presets and comparison, six key figures, contribution profit by day, how the profit is made, and a breakdown by company, channel account, SKU or cluster. Provisional figures are marked. |
| `12-finance-vat-quarter.png` | Finance, VAT quarters: VAT period per company (with a warning until it is confirmed), the list of periods, and the settlement statement, from output VAT to the amount owed to HMRC. |
| `13-finance-expenses.png` | Finance, expenses: supplier, category and company, invoice date, paid, unpaid or overdue, net, VAT and gross, and the invoice file. |
| `14-finance-profit-and-loss.png` | Finance, profit and loss: income, cost of sales, gross profit, overheads and net profit against the previous period. |
| `15-account-health-amazon.png` | Account Health, Amazon: one card per account with status, health rating and each metric against its target, with the data age. |
| `16-account-health-ebay.png` | Account Health, eBay: seller level, current and projected values and the next evaluation date. Amazon and eBay are never shown side by side. |
| `17-users.png` | Users (admin only): each person's role, tabs, companies, two-step sign-in and status. |
| `18-user-tabs-and-companies.png` | One user's access: role, then ticks for the 12 tabs and for each company. A new user starts with none. |
| `19-connections.png` | Connections (admin only): one card per channel, ads and carrier account with status, last call, token refresh, auth failures, API usage and the kill switch. |
| `20-customer-service-messages.png` | Customer Service, eBay messages: inbox with unread counts, the thread, saved replies and a plain-text reply. |
| `21-customer-service-feedback.png` | Customer Service, feedback: eBay rating counts and latest feedback with Reply; Amazon feedback for display only. |
| `22-amazon-review-requests.png` | Amazon review requests: switched on or off per account, with the latest results. |
| `23-advertising-campaigns.png` | Advertising (Amazon Ads): totals and every campaign with budget, spend, sales, ACOS, ROAS, clicks, CPC and orders. |
| `24-advertising-rules.png` | Advertising rules: condition, action, schedule and safety caps, with a dry run before switching on. |
| `25-negative-keyword-finder.png` | Negative keyword finder: search terms that cost money and sold nothing, to add as negatives after confirming. |
| `26-forecasting.png` | Forecasting: SKUs by reorder urgency, with days of cover, blended sales rate, reorder point and suggested order. |
| `27-reminders.png` | Reminders: overdue, today, coming up and done, with snooze and repeat. "Do not store customer details here" is shown. |
| `28-notes.png` | Notes: private or shared notes with the same customer-details warning. |
| `29-notifications.png` | The notification panel behind the bell: unread first, each with severity, company and how reliable the signal is. |
| `30-audit-log.png` | Audit Log (admin only): every change with who, when, IP address, before and after, and the reason. Nobody can edit it. |
| `31-settings-workspace.png` | Settings, workspace: time zone, currency, default VAT rate and how long customer details are kept. |
| `32-settings-notifications.png` | Settings, notifications: which alerts are also emailed; critical alerts are always on for admins. |
| `33-settings-my-account.png` | Settings, my account: password, two-step sign-in, and where you are signed in, with "Sign out everywhere". |
| `34-password-change.png` | Change password, shown when a password is over a year old, with the password rules ticked off as you type. |
