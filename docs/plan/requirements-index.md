# Requirements index (coverage checklist)

Source: `docs/PRD.md` v1.4. One line per requirement ID, grouped by PRD section. This file is the checklist that `scripts/verify.sh` uses. Every ID must map to one owning module (`docs/plan/MODULES.md`) and to at least one task. Once the ID is built, it must also map to at least one test that names it, for example `it('[TEN-1] blocks cross-workspace reads')`.

Totals:

- 297 PRD requirement IDs (8 added in v1.4)
- 28 acceptance tests (AT-1…AT-28, PRD §12.2)
- 10 capacity targets (CAP-1…CAP-10, PRD §9.1, added in v1.2)

Summaries are shortened. The PRD text always wins.

## §2.1 Hierarchy
- TEN-1 — Every business record (company, SKU, order, expense, note, etc.) MUST carry workspace_id.
- TEN-2 — A workspace has 1..n companies. A company has: legal name, trading name, company number (optional), VAT number (optional), registered address, VAT…
- TEN-3 — A company has 0..n channel accounts. Each channel account belongs to exactly one company.
- TEN-4 — No workspace, company or account name is hard-coded anywhere. All appear from data.
- TEN-5 — A company switcher sits in the top bar: each company the user may see, plus Combined (all of the user's permitted companies).
- TEN-6 — Workspace settings: timezone (default Europe/London), currency fixed GBP, default VAT rate 20%, PII retention (fixed and shown read-only: live…

## §2.2 Onboarding and sign-up
- TEN-7 — v1 onboarding is invite-only. A platform admin creates a workspace and invites its first admin by email.
- TEN-8 — Open self sign-up MUST be built (sign-up page, email verification, workspace creation wizard) but sit behind a platform feature flag…
- TEN-9 — First-run wizard for a new workspace admin: set up MFA → create companies → connect channels → connect carriers → invite users.
- TEN-10 — Billing is not built. The schema MUST include a plan field on the workspace (value free_internal at launch) and a place for limits…

## §2.3 Accounts and login
- USR-1 — One named login per person, identified by email. Shared logins are prohibited and the UI says so on the invite screen.
- USR-2 — A person may belong to more than one workspace and picks one after login.
- USR-3 — Passwords: minimum 12 characters, must not contain the user's name or email local part, checked against a breached-password list, last 10…
- USR-4 — MFA is mandatory for every user (TOTP authenticator app; 10 single-use recovery codes).
- USR-5 — Lockout after 10 failed attempts within 15 minutes; locked for 15 minutes; admins and the user are notified.
- USR-6 — Sessions: idle timeout 30 minutes, absolute lifetime 12 hours, sign out on all devices from the profile page.
- USR-7 — Password reset by email link valid 30 minutes; resetting does not bypass MFA.
- USR-8 — Removing a user or changing their permissions takes effect immediately (active sessions are revoked).
- USR-9 — Quarterly access review: every 90 days each workspace admin gets a task listing all users and their permissions to confirm or change.
- USR-10 — Employees (payroll records) are never users.

## §2.4 Roles and permissions
- PERM-1 — Two roles only: Admin and Child. No other tiers, no developer role. Developers who need access are added as named Admins in that workspace.
- PERM-2 — Admin: every tab, every company, all settings, user management, connections, finance edits, deletes.
- PERM-3 — Child: the admin ticks (a) which tabs and (b) which companies the child may see.
- PERM-4 — Tabs that can be ticked: Home, Orders, Shipping, Stock & Catalogue, Customer Service, Account Health, Advertising, Sales & Profit, Forecasting,…
- PERM-5 — Within a ticked tab a child can view and do normal operational actions (create labels, adjust stock, reply to messages, enter expenses).
- PERM-6 — Least privilege: a new child starts with no tabs and no companies.
- PERM-7 — At least one admin must always exist per workspace; the last admin cannot be removed or demoted.

## §2.5 Safety controls on actions
- SAFE-1 — Any action that writes to more than one channel account at once (bulk stock push, bulk ad change, bulk tracking re-send) MUST show a confirmation…
- SAFE-2 — Kill switch per channel account: an admin can pause all automated writes to one account (stock, tracking, ads, review requests) without affecting…
- SAFE-3 — Global maintenance switch (platform admin) pauses all outbound writes for all workspaces.

## §2.6 Audit log
- AUD-1 — Append-only audit log per workspace: timestamp (UTC), user, action, entity type and ID, before/after values for edits, IP address, typed reason…
- AUD-2 — Logged events include: logins and failures, MFA changes, user and permission changes, connection added/removed/re-authorised, kill switch changes,…
- AUD-3 — Audit entries never contain buyer PII. Retention: 6 years for finance events, 12 months minimum for all others.
- AUD-4 — Admins can view, filter and export the audit log. Nobody can edit or delete it.

## §2.7 Platform admin console (dev team)
- PLAT-1 — Separate area at /platform, open only to platform admin accounts (MFA required; IP allowlist via VPN).
- PLAT-2 — Functions: create, suspend and archive workspaces; send invites; feature flags (public_signup, per-workspace module toggles); view per-workspace…
- PLAT-3 — Platform admins cannot see tenant orders, customers, finance or messages from the console.
- PLAT-4 — App-level secrets (Amazon LWA client ID/secret, Ads client ID/secret, eBay keyset, verification tokens) are managed only here and stored in the…

## §3.0 Rules for every integration
- INT-1 — Every integration lives behind an adapter interface (ChannelAdapter, AdsAdapter, ShippingProvider).
- INT-2 — All outbound calls go through a central job queue with per-provider, per-account rate governors (section 9.3).
- INT-3 — All provider tokens and secrets are encrypted in the secrets store (section 8).
- INT-4 — Every channel account shows on the Connections page: provider, company, status (Active / Needs re-authorisation / Paused / Error / Disconnected),…
- INT-5 — Every API response used for business data is validated against a schema.
- INT-6 — Each record keeps its origin tag (amazon, amazon_ads, ebay, website, evri, dpd, manual) and channel_account_id, so all data from one source can be…
- INT-7 — No scraping, no headless browsers, no screen automation of any marketplace or carrier website, ever.
- INT-8 — All polling uses incremental cursors ("updated since") stored per account, with a 5-minute overlap window and de-duplication by external ID.

## §3.1 Amazon Selling Partner API (SP-API)
- AMZ-1 — One public SP-API application, registered under the Operator's developer profile in the Solution Provider Portal.
- AMZ-2 — The app stays in Draft (unlisted) at launch. Amazon allows a maximum of 25 seller OAuth authorisations for an unlisted app.
- AMZ-3 — Roles requested in one submission (adding a role later forces resubmission and re-authorisation): Product Listing (stock quantity updates);…
- AMZ-4 — Endpoints: SP-API EU https://sellingpartnerapi-eu.amazon.com; UK marketplace ID A1F83G8C2ARO7P; consent page…
- AMZ-5 — Login URI https://app.omnibridge.co.uk/connect/amazon/login and Redirect URI https://app.omnibridge.co.uk/connect/amazon/callback, both HTTPS and…
- AMZ-6 — Flow: An admin picks the company and clicks Connect Amazon. The server creates a state value: random 256 bits, bound to the user session and…
- AMZ-7 — The same selling partner ID cannot be connected to two workspaces. A second attempt is refused with a clear message.
- AMZ-8 — Re-authorising stores the new refresh token as active and keeps the old one inactive for 7 days (multi-token store), then deletes it.
- AMZ-9 — Rate limits are token buckets per app–seller–region and per operation.
- AMZ-10 — The LWA client secret expires every 180 days. Rotation is manual in the Solution Provider Portal.
- AMZ-11 — Access keys unused for 90 days are deleted by Amazon. The weekly keepalive per account prevents this.
- AMZ-12 — Amazon sends no revocation signal. If token refresh fails with invalid_grant, or calls fail with authorisation errors 3 times in 1 hour, mark the…
- AMZ-13 — Revoked or disconnected account: all data from that Amazon account MUST be deleted within 30 days (DPP 1.7).
- AMZ-14 — Own Evri/DPD labels on Amazon orders do not get Buy Shipping claims protection.

## §3.2 Amazon Ads API
- ADS-1 — One Ads API application registered by the Operator as a tool provider.
- ADS-2 — Each company connects its own Ads account by OAuth: authorisation-code grant, scope advertising::campaign_management, EU API host…
- ADS-3 — Data rules: Ingest aggregate data only (campaign, ad group, keyword/target, search term, advertised product, by day).
- ADS-4 — Reports use the asynchronous reporting API (v3): at most 31 days per request; on connect, backfill as far back as Amazon allows (about 95 days for…
- ADS-5 — If the Ads app is refused, the module offers a fallback: upload of Amazon Ads console report CSVs into the same warehouse (reporting only, no…
- ADS-6 — Before any dev team member touches live Ads data, written confidentiality and data-use terms at least as strict as the Amazon Advertising…

## §3.3 eBay APIs
- EBAY-1 — One eBay developer keyset registered by the Operator. Each company connects its eBay account(s) through eBay OAuth consent as "Your Users".
- EBAY-2 — Gate before any production call: the Marketplace Account Deletion endpoint https://app.omnibridge.co.uk/webhooks/ebay/account-deletion must be…
- EBAY-3 — RuName settings: display title "OmniBridge"; privacy policy URL https://omnibridge.co.uk/privacy; accept URL…
- EBAY-4 — Scopes: sell.inventory, sell.fulfillment, sell.finances, sell.analytics.readonly, sell.account.readonly, commerce.identity.readonly,…
- EBAY-5 — Tokens: access token 2 h, refreshed on expiry or on an invalid-token error.
- EBAY-6 — Operations table: orders (getOrders, 5 min), tracking, stock (Inventory bulk vs Trading ReviseInventoryStatus), listings, fees, messages, feedback, health (100/day cap), notifications.
- EBAY-7 — Each listing is detected as Inventory-API-managed or not on discovery, and the correct stock call is used per listing.
- EBAY-8 — Daily call governor per API, app-wide: non-urgent jobs stop at 80% of the daily cap and everything stops at 95%.
- EBAY-9 — Revision limit: at most 250 revisions per listing per day.
- EBAY-10 — Freshness: listing data shown in the UI must be at most 6 h old, other eBay content at most 24 h; otherwise show its age.
- EBAY-11 — eBay restrictions: No ML or AI on eBay data.; No performance comparison between eBay and other channels.; No eBay data pushed into any website.;…

## §3.4 Shipping carriers (shared rules)
- SHIP-1 — A carrier account belongs to one company (usually the fulfilment provider) and can ship orders of any company in the same workspace.
- SHIP-2 — All carrier calls go out from the production server's one fixed IPv4 address, which carriers allowlist.
- SHIP-3 — ShippingProvider interface: listServices(from, to, parcels), createShipment(order, parcels, service, options) returning {trackingNumbers[],…
- SHIP-4 — Carrier error responses are shown to the user in plain words, together with the raw code.

## §3.5 Evri
- EVRI-1 — Uses the Evri Business Accounts API (myHermes spec v1.4). The base URL is a setting, defaulting to the spec's host.
- EVRI-2 — Connect flow: The admin logs into Evri.; The admin copies the single-use authorisation code from the browser address bar.
- EVRI-3 — Create parcels: POST /parcels.
- EVRI-4 — 32-character limits on address lines 1–4, first name, last name, delivery instructions and safe place.
- EVRI-5 — Labels: GET /labels/{barcode} with Accept: application/pdf,application/json (without application/json, errors come back as 406).
- EVRI-6 — Evri has no void, no status endpoint and no API pickups. "Void" in OmniBridge is an internal status that adds the parcel to a "Voided labels to…
- EVRI-7 — Contacts for the runbook: IT.integration@evri.com (send full request and response plus screenshots) and evriclientdesk@evri.com (redirect URI…

## §3.6 DPD
- DPD-1 — DPD UK (Geopost UK) API, base URL https://api.dpd.co.uk. DPD UK and DPD Local are separate services with separate credentials, so the carrier…
- DPD-2 — Authentication: Login with POST /user/?action=login, HTTP Basic credentials and header GEOClient: account/{accountNumber}.
- DPD-3 — Operations: GET /shipping/network/ to find valid service (network) codes for the addresses and parcels.; POST /shipping/shipment to create a…
- DPD-4 — DPD gives no separate test credentials. Test shipments are not charged if their labels are never scanned.
- DPD-5 — Default service, parcel weight rules and collection address are set per carrier account.

## §3.7 Website connector (JeezMart first)
- WEB-1 — Setup: the admin creates a Website channel account under a company and gets a connection ID, an inbound API key (shown once) and a signing secret.
- WEB-2 — Signing (both directions): Headers Authorization: Bearer {apiKey}, X-OB-Timestamp (Unix seconds), X-OB-Signature = hex HMAC-SHA256 of timestamp +…
- WEB-3 — Inbound (website → OmniBridge), base https://app.omnibridge.co.uk/api/v1/website/{connectionId}: POST /orders upserts by externalOrderId.
- WEB-4 — Outbound (OmniBridge → website), base = the website base URL: PUT /omnibridge/stock with [ {externalSku, quantity} ], in batches of up to 100.;…
- WEB-5 — Delivery: outbound retries back off from 1 min up to 24 h, then go to the dead-letter queue with an alert.
- WEB-6 — The JeezMart side of this contract is built by the dev team in the JeezMart codebase.

## §3.8 Tracking push loop (all channels)
- TRK-1 — When a label is created, a tracking job is queued for the order's channel (Amazon shipment confirmation, eBay shipping fulfilment, website…
- TRK-2 — Retries at 1, 5, 15, 60, 180 and 360 minutes. If the channel has not confirmed within 4 hours, raise a hard alert on the order and on the Home…
- TRK-3 — The order shows the tracking state: Pending / Sent / Confirmed / Failed, with the last error.

## §4.0 Home
- HOME-1 — The Home tab shows: orders today by channel; orders awaiting dispatch, with how many are past their ship-by date; sales and units for today, 7…
- HOME-2 — Each tile links to the filtered list behind it. A child only sees tiles for tabs they have.
- HOME-3 — Quick view of today's orders per channel on the Home card; no buyer details.

## §4.1 Catalogue (Master SKUs)
- CAT-1 — Master SKU fields: SKU code (unique per workspace), title; short description (used as the carrier item description); barcode (optional),…
- CAT-2 — VAT type is one of four: Standard 20%, Reduced 5%, Zero-rated 0%, No VAT (exempt or outside scope).
- CAT-3 — Bundles contain several units of one Master SKU only, for example a 3-pack of SKU A.
- CAT-4 — COGS is entered by hand per Master SKU, one value per SKU, with an effective-from date.
- CAT-5 — Channel listing mapping: On connect and daily, each channel's listings are discovered (channel account, external SKU, listing ID/ASIN/item ID,…
- CAT-6 — Orders containing an unmapped listing are flagged "Unmapped item". They still appear in orders and shipping, but they do not move stock until the…

## §4.2 Inventory
- INV-1 — Each non-bundle Master SKU has one on hand number. Reserved = units in orders that are not yet dispatched or cancelled.
- INV-2 — Quantity pushed to a merchant-fulfilled listing = max(0, available − safety buffer).
- INV-3 — Stock movements: order placed: reserve; order cancelled: release; order dispatched: on hand −qty and reserved −qty; refund with "return to stock"…
- INV-4 — After any movement, stock is recalculated and the new quantities are queued for every affected listing on every other channel.
- INV-5 — Change log: every movement records timestamp, Master SKU, change, new on hand, reason, source (order ref or user), and the channel listings pushed…
- INV-6 — If an order makes available fall below 0, the order is flagged Oversold and an alert is raised.
- INV-7 — A nightly reconciliation compares each listing's quantity on the channel with the expected quantity.
- INV-8 — A failed stock push retries (3.0 rules). After the last retry the listing gets a "Sync failed" badge and an alert.
- INV-9 — FBA stock is not managed by OmniBridge. FBA listings show "Fulfilled by Amazon" and are excluded from pushes.
- INV-10 — Manual allocation per Master SKU or listing; target = min(manual qty − sold since set, available − buffer); back to Auto re-syncs all.

## §4.3 Orders
- ORD-1 — One list for all channels and companies. Columns: channel icon, company badge, order ref, placed date/time; status, item count, total gross,…
- ORD-2 — Filters: company, channel account, status, date range, ship-by (today / overdue), flag, and search by order ref or SKU.
- ORD-3 — Normalised statuses, with the raw channel status also kept: Pending payment; Awaiting dispatch; Label created; Dispatched; Delivered (if the…
- ORD-4 — Two-tier storage, which is mandatory: The order record (permanent, no PII) holds:; IDs, channel account, company; timestamps: placed, paid,…
- ORD-5 — In lists, PII is masked (for example "J. S***, G2"). It is shown in full only on the order detail page and the shipping desk, to users with the…
- ORD-6 — The order detail page shows lines, money breakdown, status history, labels and tracking, the tracking push state, and internal notes.
- ORD-7 — Returns view: Amazon returns from the returns report (reason, status, A-to-z flag, inferred claim deadline labelled Estimate), plus refunds from…
- ORD-8 — Order export to CSV contains no PII.
- ORD-9 — Same-buyer groups: same channel account, exact normalised buyer and address match in pii-vault, same London day or 3 h across midnight.

## §4.4 Shipping desk
- SHP-1 — A queue of orders awaiting dispatch, filtered by company, channel and ship-by, sorted by ship-by date.
- SHP-2 — Labels for one order or many (up to 200 per batch): Pick the carrier account and service.
- SHP-3 — Shipping rules are an ordered list per workspace. Each rule has conditions (channel, company, total weight range, item count, destination postcode…
- SHP-4 — On label creation: the order goes to Label created, then Dispatched (setting auto_dispatch_on_label, default on).
- SHP-5 — Reprint fetches the existing label. "Void" marks it void in OmniBridge, returns the order to Awaiting dispatch and adds it to the reconcile list.
- SHP-6 — Optional packing slip PDF (setting): order ref, items, quantities, and the delivery name and address rendered on demand.
- SHP-7 — Label cost: a per-service cost table per carrier account, entered by the admin, is used for profit.
- SHP-8 — Partial dispatch (some lines now, the rest later) SHOULD be supported where the channel allows it.
- SHP-9 — Ship together: one label for a same-buyer group, same tracking pushed to each order, label cost split to the penny.

## §4.5 Customer service
- CS-1 — eBay messages: a two-way inbox per eBay account, with: conversation list with unread counts; thread view and plain-text reply; mark read, unread…
- CS-2 — Message content is buyer personal data. It is stored in the PII store and deleted 30 days after the conversation's last activity.
- CS-3 — eBay seller feedback: lists new feedback by rating; alerts on neutral and negative; lets users reply from the dashboard (RespondToFeedback); shows…
- CS-4 — Amazon seller feedback: new feedback from the daily report, with an alert on ratings of 3 or below.
- CS-5 — Amazon review requests: A daily job per Amazon account, switched on and off per account.; Candidate orders are those where today is between…
- CS-6 — Amazon buyer messages through the email relay: inbox per account, reply to the relay only, content in the PII store, 30-day deletion.

## §4.6 Account health
- HLT-1 — Amazon screen, one card per Amazon account: account status; Order Defect Rate, Late Shipment Rate, Pre-fulfilment Cancel Rate, Valid Tracking…
- HLT-2 — eBay screen, one card per eBay account: seller level; transaction defect rate; cases closed without seller resolution; late delivery rate
- HLT-3 — Amazon and eBay are on separate screens. No chart or table may put eBay and Amazon performance metrics side by side.
- HLT-4 — Alerts fire when a metric changes band, when account status changes, and when a report fails to parse.
- HLT-5 — Data age is shown on every card ("updated 3 h ago").
- HLT-6 — Amazon seller feedback on each Amazon account card: stars, counts for 30 d / 90 d / 12 m, newest comments.
- HLT-7 — (SHOULD) Estimate of when an amber or red Amazon metric recovers, from own merchant-fulfilled orders.

## §4.7 Advertising (Amazon Ads; module flag)
- AD-1 — Campaign list per company and Ads profile: type (SP / SB / SD), state, budget; spend, sales, ACOS, ROAS, impressions, clicks, CTR, CPC, orders;…
- AD-2 — Edits: campaign state, daily budget, keyword and target bids, add keywords, add negative keywords (exact and phrase), and create Sponsored…
- AD-3 — Rules engine: Scope: campaigns, ad groups or keywords.; Condition: one or more metric thresholds over a lookback window, for example ACOS above…
- AD-4 — Negative keyword finder: search terms with spend of at least £X and zero orders over N days (both settings) are listed as suggestions.
- AD-5 — Warehouse: Daily aggregates are kept for as long as the Ads account stays connected.; On disconnect they are deleted within 30 days.; The last N…
- AD-6 — Ad spend per Master SKU comes from the advertised-product report and feeds Sales & Profit.

## §4.8 Sales & Profit dashboard
- PRF-1 — Tiles and a time chart for the selected period: gross sales, units, orders, refunds; output VAT, channel fees (net of reclaimable VAT), ad spend;…
- PRF-2 — Contribution profit = (gross sales − refunds) − output VAT − channel fees (net of VAT) − ad spend − COGS − label cost.
- PRF-3 — Breakdown by company, channel account, Master SKU and custom clusters (saved groups of channel accounts).
- PRF-4 — Cross-channel views compare money only: revenue, cost, profit, margin.
- PRF-5 — Figures that depend on provisional or estimated data carry a marker.
- PRF-6 — Order profit card with Ex VAT, VAT and Inc VAT columns.

## §4.9 Forecasting
- FC-1 — Per Master SKU (bundle sales converted to component units): velocity over 7, 30 and 90 days; blended velocity = 0.5 × v7 + 0.3 × v30 + 0.2 × v90;…
- FC-2 — Low-stock alert when days of cover falls below lead time + safety days.
- FC-3 — Only statistical formulas. No ML or AI model of any kind in v1. A code-level guard rejects any future model input that includes eBay-origin data.

## §4.10 Reminders and Notes
- TOOL-1 — Reminders: title, details, due date and time; recurrence: none, daily, weekly, monthly or yearly; assignee: yourself or another user in the…
- TOOL-2 — Notes: title and body (simple formatting). Private by default, with an option to share with the workspace.
- TOOL-3 — Both show the banner "Do not store customer details here". Before saving, a simple check for postcodes, phone numbers and email addresses warns…

## §5.1 Principles
- FIN-1 — All money is GBP, stored as integer pence. Rounding is half-up to the penny.
- FIN-2 — Every finance figure can be shown per company and combined, and every total can be traced to the rows behind it (drill-down).
- FIN-3 — Every create, edit and delete in Finance goes to the audit log with before and after values.
- FIN-4 — Finance records never contain buyer PII.
- FIN-5 — VAT treatment is a setting on each channel account: seller_accounts_for_vat (default) or marketplace_accounts_for_vat.

## §5.2 VAT on sales (output VAT)
- VAT-1 — Tax point = the date the order was placed (accountant). That date decides the VAT quarter.
- VAT-2 — Each order line takes its VAT rate from its Master SKU's VAT type, as a snapshot when the order is placed.
- VAT-3 — Calculation per order: Group the lines by VAT rate.; Deduct discounts from each group, pro-rata to the group's goods value.; Add shipping charged…
- VAT-4 — Zero-rated sales and No VAT sales both have VAT 0. They are reported as two separate lines in every VAT report.
- VAT-5 — Refunds reduce VAT at the original sale's rate. A refund tied to lines uses those lines' rates.
- VAT-6 — An order cancelled before payment is captured is excluded from VAT. An order cancelled after a refund is handled as a refund.
- VAT-7 — Changing a SKU's VAT type affects only orders placed after the change.

## §5.3 Channel fees and fee VAT
- FEE-1 — Fees are pulled automatically: Amazon from the Finances API and settlement reports; eBay from the Finances API.
- FEE-2 — Fee VAT: Amazon charges 20% UK VAT on most fees, which is reclaimable input VAT.
- FEE-3 — Reverse-charged fees (for example some fees invoiced from Luxembourg) are recorded as both reverse-charge output VAT and equal input VAT, net…
- FEE-4 — Payouts are recorded per channel account: payout ID, period, gross sales, fees, refunds, reserves, net paid, date.

## §5.4 Expenses and purchases
- EXP-1 — Expense fields: company; supplier; category; invoice date; due date (optional); amount, with a VAT-inclusive / VAT-exclusive toggle; VAT rate; VAT…
- EXP-2 — Suppliers and categories have no fixed list. A name is typed the first time and offered from a dropdown after that.
- EXP-3 — Supplier record: name, VAT number (optional), bank details (optional, encrypted, visible to admins only, since a sole trader's bank details are…
- EXP-4 — By default, stock purchases and overheads are booked to the workspace's purchasing company (Jeez).
- EXP-5 — Unpaid-bill reminders: 3 days before the due date, on the due date, then every 7 days while overdue.
- EXP-6 — Attachments: PDF, JPG or PNG, up to 10 MB each, virus-scanned on upload, kept 6 years from the invoice date, then deleted.
- EXP-7 — Stock purchases are not linked to SKUs and do not change stock. Stock-in is a separate manual action (INV-3).

## §5.5 Recurring expenses
- REC-1 — Recurring template: every expense field, plus frequency (daily, weekly, monthly, quarterly, yearly), start date, optional end date, and "mark as…
- REC-2 — On each due date the system creates the expense entry automatically and notifies the Finance users of that company each time.
- REC-3 — Editing a template changes future entries only. Pausing or ending a template stops future entries.

## §5.6 Supplier invoice import (no in-system OCR)
- IMP-1 — Staff read invoices with an outside AI tool (for example ChatGPT) and bring the data in by: (a) CSV upload in the OmniBridge template; (b) pasting…
- IMP-2 — Template columns: company, supplier, supplier_vat_number, invoice_number, invoice_date, due_date, category, description, amount,…
- IMP-3 — The import shows a preview grid before saving, with checks: required fields and date formats; VAT arithmetic (gross = net + VAT within £0.01);…
- IMP-4 — The import page has a ready-to-copy prompt that tells the outside AI tool to output exactly this template.

## §5.7 Intercompany transfers
- ICT-1 — Record fields: from company, to company, date, description; type: Fulfilment service / Overhead recharge / Stock recharge / Other; one or more…
- ICT-2 — Effects: The "to" company gets an expense and the "from" company gets recharge income, both in the P&L.; Lines with 20% or 0% create output VAT…
- ICT-3 — Every transfer produces a PDF "Intercompany transfer record" (both companies' details, lines, VAT where present, reference number).
- ICT-4 — Edit and delete are admin-only. They need a confirmation dialog and a typed reason of at least 10 characters.
- ICT-5 — Optional monthly stock recharge suggestion (setting, default on): it adds up the COGS of each other company's sales whose stock the purchasing…

## §5.8 VAT quarters and settlement
- VQ-1 — Each company has a VAT period setting: quarterly stagger 1 (quarters end Mar, Jun, Sep, Dec), stagger 2 (Apr, Jul, Oct, Jan), stagger 3 (May, Aug,…
- VQ-2 — VAT settlement per company per period: output VAT by rate, zero-rated and No VAT lines, refunds, intercompany, reverse charge; settlement = payable − claimable.
- VQ-3 — Locking: an admin marks a period Filed, which locks it. Records dated in a locked period cannot be created, edited or deleted.
- VQ-4 — The settlement screen has date and period filters, a breakdown per channel account, and drill-down to the rows behind each figure.

## §5.9 Profit and loss
- PL-1 — P&L per company for a month, quarter, year or custom range: Income: net sales (ex VAT) by channel, less net refunds; intercompany recharge…
- PL-2 — P&L basis setting, default COGS basis : product cost comes from COGS on items sold, and the Stock purchases category is left out of the P&L, so…
- PL-3 — The combined P&L is the sum of the selected companies' P&Ls with intercompany income and expense removed on both sides.
- PL-4 — The Finance P&L and the Sales & Profit dashboard (4.8) are separate views.

## §5.10 Employees and payroll (records only)
- PAY-1 — Employee record: name, internal reference number, role, Remote/Onsite (a label only), company (default Jeez), start date, end date, active status.
- PAY-2 — Monthly payroll record per employee: month, payment date, total cost to business, net paid, external payroll provider reference.
- PAY-3 — Never stored: National Insurance number, bank details, home address, date of birth, phone.
- PAY-4 — No PAYE, NI or statutory calculation. Payroll totals feed the P&L as overhead in the employee's company.
- PAY-5 — Employees have no login. Only admins and children with the Finance tab for that company can see payroll.
- PAY-6 — Payroll records are kept 6 years, then deleted.

## §5.11 Exports for the accountant (Xero)
- XP-1 — Six CSV reports, each for one company or combined, for any date range or VAT period: Payout summary per channel: payout ID, channel account,…
- XP-2 — Optional Xero manual-journal CSV format (setting, off by default). The journals MUST balance (debits = credits), and an account-code mapping table…
- XP-3 — Still waiting on the accountant, but not blocking: whether there is one Xero organisation per company; whether A2X or Link My Books is already…

## §6. Notifications, alerts and reminders
- NTF-1 — Every notification records: severity (Critical / Warning / Info), type, company, channel account, linked record, signal label, created time, and…
- NTF-2 — Recipients: workspace admins, plus children whose ticked tabs and companies cover the linked record.
- NTF-3 — Email is sent through a transactional email service with EU hosting, from notifications@omnibridge.co.uk.
- NTF-4 — Users choose email on or off per type. Critical alerts cannot be switched off for admins.
- NTF-5 — Duplicates are suppressed. The same type for the same record raises one notification, which is updated in place.

## §7.1 Roles (who is responsible)
- DP-1 — Each workspace customer is the controller of its own customers' and staff data.
- DP-2 — The Operator is the processor for every workspace. The dev team's company in Pakistan is a sub-processor.
- DP-3 — eBay's data protection terms treat the developer as an independent controller of eBay data and as an importer from the first production call…

## §7.2 PII store
- DP-4 — The PII store is physically separate from the main database: its own database, its own credentials and its own encryption keys.
- DP-5 — It holds: buyer name, address, postcode, phone and email; buyer channel IDs and usernames; delivery instructions; eBay message contents; eBay…
- DP-6 — Each record is encrypted at application level (AES-256-GCM, a per-workspace data key wrapped by a master key held outside the database).
- DP-7 — Only the services that need PII can reach the store, and only for these purposes: Read: shipping label creation, order detail view and the eBay…
- DP-8 — PII never appears in: logs; error trackers; analytics; exports; emails; notifications; the main database; backups of the main database

## §7.4 Deletion service
- DEL-1 — One deletion service handles every trigger: a scheduled PII expiry (hourly job); an order cancellation; a UK GDPR erasure request; an eBay…
- DEL-2 — Deletion is a hard delete, not a flag. It cannot be reversed even with the highest database privilege.
- DEL-3 — Each run logs the time, the trigger, the scope (counts and IDs) and the result.
- DEL-4 — Erasure requests: an admin enters the buyer's identifiers, the system finds every match in the PII store and deletes it.
- DEL-5 — Subject access requests: an admin can export everything held about one buyer (PII store matches plus the linked order records) as a file.

## §7.5 Before real data
- DP-9 — Production runs on synthetic test data only until every one of these is signed: data processing agreements in the chain: each company and the…
- DP-10 — If the risk assessment ever finds a significant risk, the IDTA requires access from Pakistan to be suspended.
- DP-11 — Each controller company checks whether it needs to pay the ICO data protection fee and keeps a record of processing.

## §8.1 Application
- SEC-1 — HTTPS only, TLS 1.2 or higher, HSTS. Secure, HttpOnly, SameSite cookies.
- SEC-2 — Standard web protections: a strict Content Security Policy; output encoding; parameterised queries; file uploads checked by type and size and…
- SEC-3 — Server-side authorisation checks on every request (workspace, role, tab, company).
- SEC-4 — Dependency and code scanning run in CI before every release. A release with critical findings is blocked.
- SEC-5 — No secrets in code, config files in the repo, container images or logs.
- SEC-6 — Provider tokens and secrets are encrypted at rest (AES-256-GCM, envelope encryption).

## §8.2 Infrastructure
- SEC-7 — Separate production and staging environments on separate servers, with separate credentials and separate data.
- SEC-8 — Only ports 80 and 443 face the internet (80 redirects to 443). SSH and admin tools are reachable only through a VPN or bastion with key-based…
- SEC-9 — Protection at the edge and on the host: a web application firewall in front of the app; intrusion detection on the host; host firewall that denies…
- SEC-10 — Automatic security updates. Vulnerability scans at least every 30 days.
- SEC-11 — Encrypted backups of both databases daily, stored in a second, geographically separate location in the EU (never in a US region).
- SEC-12 — Logs are kept 12 months or more, with no PII, and reviewed at least every 2 weeks.
- SEC-13 — A network diagram and an asset inventory are kept current and reviewed every quarter.

## §8.3 People and process
- SEC-14 — Everyone with production access has their own named account, MFA, a signed confidentiality agreement and yearly security training.
- SEC-15 — Developer computers have screen lock at 15 minutes or less, disk encryption and anti-malware, and never hold production PII.
- SEC-16 — Change management: every change goes through a pull request reviewed by a second developer.
- SEC-17 — Incident response plan, reviewed every 6 months: detection; containment; notification of Amazon at security@amazon.com within 24 hours of a…
- SEC-18 — Written policies to keep (drafted by the dev team): information security policy; access control policy; retention schedule (7.3); incident…

## §9.2 Architecture constraints
- NFR-1 — One web application (UI + API) and separate background workers, all containerised.
- NFR-2 — One main relational database (multi-tenant, workspace_id on every row) and one separate PII database (7.2).
- NFR-3 — A durable job queue that persists jobs across restarts. Jobs are idempotent, retry with backoff, have a dead-letter queue and are scheduled with…
- NFR-4 — Long work (syncs, reports, exports, label batches, imports) always runs in workers.
- NFR-5 — File storage for labels, invoice attachments and export files: encrypted, served only through signed short-lived links after a permission check.
- NFR-6 — Server-side caching may be used for dashboards. Cache keys include workspace_id and the user's permitted companies.
- NFR-7 — Times are stored in UTC and shown in Europe/London. Dates for VAT use the London date.
- NFR-8 — The UI is responsive. It is built for desktop first, and the shipping desk and orders also work on a tablet.
- NFR-9 — English (UK) only, with UK date format (DD/MM/YYYY) and £ formatting.

## §9.3 Rate governors (asymmetric by design)
- RL-1 — Amazon: per seller and per operation, reacting to 429 with exponential backoff and full jitter (AMZ-9).
- RL-2 — eBay: a hard daily budget per API across the whole app (EBAY-8) and per listing (EBAY-9).
- RL-3 — The Amazon and eBay governors are separate code paths. They never share one retry helper.
- RL-4 — Carriers and websites: a concurrency cap per account (default 4 parallel requests) and backoff on 429 or 5xx.
- RL-5 — The platform console shows usage against limits for every provider, account and API, in real time.

## §9.4 Hosting and operations
- OPS-1 — Production: one netcup VPS 2000 G12.5 in Germany (8 shared vCores, 16 GB RAM, 256 GB SSD), shared with JeezMart (9.5).
- OPS-2 — The fixed IPv4 address is permanent. It is the address that Evri and DPD allowlist.
- OPS-3 — Deployment: CI builds images, runs tests and scans, and deploys to staging automatically and to production on approval.
- OPS-4 — Monitoring: uptime checks on the public site and app (each server watches the other, plus one free external checker; see OPS-11), alerts on…
- OPS-5 — Runbooks are kept for: Amazon client secret rotation; Amazon or eBay re-authorisation; Evri re-authorisation; DPD login failures; restore from…
- OPS-6 — Daily health digest to platform admins: jobs failed, API usage, credentials expiring in the next 30 days, deletion runs.

## §9.5 Shared production server (OmniBridge + JeezMart)
- OPS-7 — OmniBridge must run correctly whether or not JeezMart is on the server.
- OPS-8 — Isolation: each app has its own Docker Compose project, container networks, databases and database roles, secrets, deploy pipeline, backups, and…
- OPS-9 — Only these are shared: the host OS; the Docker engine; the firewall; the fixed IPv4 addresses; one edge reverse proxy that terminates TLS and…
- OPS-10 — Resource budget: Every OmniBridge container has explicit memory and CPU limits.; PostgreSQL, the workers and any cache are tuned to those limits,…
- OPS-11 — Fully self-hosted. PostgreSQL, auth, job queue, cache and file storage run on the server or as libraries inside the app.
- OPS-12 — JeezMart and OmniBridge talk only through the signed website contract (3.7), even on the same server.

## §10.1 Domains
- WWW-1 — The domain is registered at GoDaddy, and its DNS stays at GoDaddy.

## §10.2 Pages
- WWW-2 — Every page footer reads: "OmniBridge is operated by [OPERATOR_LEGAL_NAME], company number [OPERATOR_COMPANY_NUMBER], registered office…
- WWW-3 — There are no tracking or advertising scripts. Analytics, if any, must be cookieless and self-hosted.
- WWW-4 — The public site has no login wall and no "under construction" pages at the moment of Amazon's review.

## §10.3 Legal content (drafted by the dev team, reviewed by the client)
- WWW-5 — The privacy policy covers: who the Operator is; what data is processed and from where (Amazon, Amazon Ads, eBay, websites, carriers); why; the…
- WWW-6 — The terms of service cover: the service, and accounts with no shared logins; acceptable use; customer responsibilities for their channel accounts;…
- WWW-7 — Users accept the current terms and privacy policy on first login and again after a material change.

## §10.4 Email
- MAIL-1 — Mailboxes on omnibridge.co.uk use Zoho Mail Lite with 2 paid users: the client and the developer.
- MAIL-2 — System email (invites, password reset, alerts, reminders) goes through a pay-per-use transactional sending service with EU hosting, from…
- MAIL-3 — Email templates are plain and branded. They carry no buyer PII and no secrets.

## §9.1 Capacity and speed (CAP IDs added in v1.2)
- CAP-1 — Today's volume: 1,000–2,000 orders per week.
- CAP-2 — Design capacity: 20,000 orders per week; bursts of 20 orders per minute.
- CAP-3 — Tenants (design): 100 workspaces, 1,000 channel accounts, 500 concurrent users.
- CAP-4 — Catalogue (design): 50,000 Master SKUs and 200,000 listings per workspace.
- CAP-5 — Stock push after a sale: 95% sent within 2 minutes (excluding eBay holds and throttling).
- CAP-6 — A new order is visible in OmniBridge within 5 minutes of the channel.
- CAP-7 — Page load p95 under 1 s at design capacity; list APIs paginate (default 50 rows).
- CAP-8 — A batch of 50 labels is created and printable within 2 minutes, subject to carrier speed.
- CAP-9 — Availability 99.5% monthly, excluding announced maintenance.
- CAP-10 — Recovery: RPO 24 h (main data), RTO 8 h.

## §12.2 Acceptance tests (each MUST pass)
- AT-1 — A user of workspace A cannot read or change any record of workspace B through any API route; one automated test per route.
- AT-2 — A child with tabs {Orders} and company {Sidson} sees only Sidson orders, including Combined view, search, exports and notifications; other tabs return 403.
- AT-3 — Login is impossible without MFA; 10 failures lock the account for 15 min; removing a user ends their sessions immediately.
- AT-4 — Selling 1 unit on any channel lowers every other mapped MFN listing within 2 minutes (staging, without throttling).
- AT-5 — A bundle of 3 shows floor(available ÷ 3) and cannot be created with two different SKUs.
- AT-6 — Changing COGS does not change the profit of orders placed before the change.
- AT-7 — The 241st revision of one eBay listing in a day is held and released after the reset; the eBay governor never sends above 95% of any cap.
- AT-8 — An order's PII is gone from the PII DB at day 25 after delivery (or dispatch), and from backups (after restore + tombstones) and logs by day 30; live copy at once on confirmed cancellation.
- AT-9 — No buyer PII in the main DB, logs, error tracker, exports or emails; an automated marker scan proves it.
- AT-10 — An eBay account-deletion POST deletes that user's PII; the challenge GET returns the correct hash with no BOM.
- AT-11 — A revoked Amazon account shows Needs re-authorisation within 1 h of the first failure and schedules deletion for day 21; re-authorising cancels it.
- AT-12 — Evri: a 200 response with one INVALID parcel shows that parcel failed; a 33-character line re-flows or is flagged; a reprint creates no new parcel.
- AT-13 — Every label leads to a channel tracking push; a push not confirmed in 4 h raises a critical alert.
- AT-14 — Website connector: a replayed idempotency key creates no duplicate; a bad signature or a timestamp more than 5 min off is rejected.
- AT-15 — VAT: £12 standard + £6 zero + £3 shipping gives £2.33 VAT on the standard group and £0 on the zero group; Zero-rated and No VAT are reported separately.
- AT-16 — A £6 refund on a £12 standard line reduces output VAT by £1.00 in the refund date's quarter.
- AT-17 — A filed VAT quarter blocks edits; a late fee posts to the next open quarter; unlocking needs a reason and is logged.
- AT-18 — An intercompany edit without a typed reason is refused; history shows old values and the reason; Combined P&L removes both sides.
- AT-19 — A recurring monthly expense creates its entry on the due date and sends a notification.
- AT-20 — CSV import rejects gross ≠ net + VAT by more than £0.01 and flags a duplicate supplier + invoice number.
- AT-21 — The six exports open in a spreadsheet, match the settlement and P&L screens, and contain no PII.
- AT-22 — Amazon and eBay health screens never show each other's metrics side by side.
- AT-23 — The public site has no login wall, a valid certificate, privacy, terms and contact pages, and the Operator footer.
- AT-24 — A restore from backup works within 8 hours and deleted PII does not reappear; first drill on production before go-live, later drills on staging.
- AT-25 — A load test at design capacity (§9.1) meets the page and stock-push targets; runs on production before go-live with synthetic data.
- AT-26 — Same-buyer groups: midnight case, account and name rules, one label under concurrency, penny split.
- AT-27 — Manual allocation: limit, cap by stock, back to Auto re-syncs within 2 minutes.
- AT-28 — Amazon buyer messages: routing, rejection of bad mail, replies to the relay only, 30-day deletion.
