# OmniBridge PRD v1.3 (Locked Source of Truth)

Oct 17, 2026 · @Raja

## 0. Document control

This PRD is the single locked source of truth for OmniBridge v1. It replaces every earlier SRS (v1.0–v1.4), the Source of Truth v1.0, Research Summaries v1.0/v2.0, the Project Context file and the teammate PRD. Where any older document disagrees, this one wins.

**Status:** Locked v1.3, 18 Oct 2026 (first locked as v1.0 on 17 Oct 2026). Changes only through a numbered change log entry (section 13.6).

### 0.1 How to use this document (for humans and coding agents)

- Every requirement has an ID (for example `ORD-12`). Code, tests and tickets must reference these IDs.
- **MUST** = required for v1. **SHOULD** = build unless it blocks a MUST. **MAY** = optional.
- Items marked **\[Claude default\]** were chosen by Claude, not by the client or the accountant. They are safe defaults, built as editable settings, and listed together in section 13.2 so the client can change them.
- Items marked **\[Verify in testing\]** depend on a platform behaviour that official docs do not settle. Build the configurable version and confirm in sandbox or first live use.
- Items marked **\[Third-party source\]** come from non-official sources and must be checked against the official spec when it arrives.
- The tech stack is **not** fixed here. The coding agent chooses it, within the constraints in section 9 (single server, Docker, Germany, one fixed IP, separate encrypted PII store, background job queue).
- Names Jeez, Sidson, Kyyz and JeezMart are **seed data only**. Nothing in code, UI or database schema may hard-code them.

### 0.2 Naming

| Term | Meaning |
| --- | --- |
| OmniBridge | The product. Public site and app on `omnibridge.co.uk`. |
| Operator | The legal company that runs OmniBridge and holds the Amazon developer profile, the Amazon Ads app and the eBay developer account. Placeholder: `[OPERATOR_LEGAL_NAME]`, `[OPERATOR_COMPANY_NUMBER]`, `[OPERATOR_REGISTERED_ADDRESS]`. Expected to be Sidson; to be confirmed by the client. |
| Dev team | The developers in Pakistan who build and run OmniBridge for the Operator. Named security contact: Hashir. |
| Platform admin | A member of the dev team using the platform admin console (section 2.7). |
| Workspace | One customer business (a tenant). All its data is isolated from other workspaces. |
| Company | A legal entity inside a workspace, with its own VAT registration and its own channel accounts. |
| Channel account | One connected seller account: an Amazon seller account, an Amazon Ads account, an eBay account, or a website. |
| Fulfilment provider | The company in a workspace that packs and ships for the others (Jeez at launch). |
| Master SKU | One product in the workspace catalogue; channel listings map to it. |
| PII | Personal data of buyers (name, address, phone, email, buyer IDs, postcode). Lives only in the PII store. |
| Admin / Child | The two workspace roles (section 2.4). |

### 0.3 Launch configuration (seed data)

- One workspace: "Jeez Group".
- Three companies: Jeez (fulfilment provider, owns all stock purchases, staff and overheads, owns JeezMart), Sidson, Kyyz. Each is separately VAT-registered.
- Channel accounts: one Amazon UK seller account and one Amazon Ads account per company; eBay accounts linked per company (count set at connection time); JeezMart website under Jeez.
- Carriers: one Evri account and one DPD account, both owned by Jeez and used for all three companies' orders.
- Volume: 1,000–2,000 orders per week across all channels today.

## 1. Product overview

OmniBridge is a multi-tenant SaaS back office for UK sellers who sell on Amazon, eBay and their own website. It brings stock, orders, shipping labels, account health, Amazon advertising, profit and a finance/VAT ledger into one dashboard. It launches with one workspace (three companies) but is built so any number of workspaces, companies and channel accounts can be added by clicking, with no developer involved.

### 1.1 Goals

1. **One stock number per product** that flows to every channel automatically, so nothing oversells.
2. **One order list and one shipping desk** for all channels and companies, with Evri and DPD labels printed in one click and tracking sent back to the channel.
3. **Self-service connections**: a workspace admin links Amazon, Amazon Ads and eBay through each platform's own OAuth consent screen, and a website through an API key. No passwords are ever entered into OmniBridge.
4. **True profit and VAT figures** per company and combined, ready for the accountant's Xero.
5. **Compliance by design** with the Amazon SP-API Data Protection Policy and Acceptable Use Policy, the Amazon Ads agreements, the eBay API License Agreement and UK GDPR.
6. **Efficient and safe**: stays inside every API limit, survives restarts, and runs on one server.

### 1.2 Users

| User | What they do |
| --- | --- |
| Workspace admin | Connects channels and carriers, manages users and settings, sees everything in the workspace. |
| Child user (staff) | Uses only the tabs and companies the admin ticked: packing, labels, stock, messages, finance entry. |
| Platform admin (dev team) | Creates workspaces, watches system health, handles credentials and incidents. Has no access to tenant business data unless added to that workspace as a user. |
| Accountant | Not a user in v1. Receives CSV exports. |

### 1.3 v1 scope (all MUST unless marked)

| Area | In v1 |
| --- | --- |
| Tenancy | Workspaces, companies, invite-only onboarding, open sign-up built but switched off |
| Users | Admin and Child roles; tab and company ticks; MFA; audit log |
| Connections | Amazon SP-API (public app, OAuth), Amazon Ads (OAuth), eBay (OAuth), website connector (JeezMart first), Evri, DPD |
| Catalogue | Master SKUs, channel listing mapping, same-SKU bundles, VAT type, COGS history |
| Inventory | Master stock, manual stock-in and adjustments, safety buffer per channel, auto-push, change log |
| Orders | Unified order list, two-tier storage (non-PII record + PII store), returns view |
| Shipping | Evri and DPD labels, batch printing, tracking push with confirmation loop |
| Customer service | eBay two-way messages, eBay seller-feedback alerts and replies, Amazon seller-feedback alerts, Amazon review requests |
| Account health | Amazon and eBay health screens, returns and A-to-z mirror |
| Advertising | Amazon Ads campaign manager, rules, negative keyword finder, performance warehouse (conditional on Amazon approving the Ads app) |
| Analytics | Sales and profit dashboard, ad spend per SKU, forecasting and reorder alerts |
| Finance | Sales VAT, fee VAT, expenses and supplier invoices, recurring expenses, intercompany transfers, payroll records, VAT settlement per quarter, P&L, six CSV exports |
| Workspace tools | Notification centre, Reminders, Notes |
| Public site | Landing pages, privacy policy, terms, contact, Amazon/eBay OAuth pages |
| Platform admin console | Workspaces, health, jobs, rate-limit dashboards, credential expiry |

### 1.4 Not in v1 (named so nothing is added or removed silently)

| Item | Reason |
| --- | --- |
| Amazon buyer message counter (email parsing) | Parked by the client; not needed for launch |
| Two-way Amazon buyer messaging | Impossible: Amazon's Messaging API is send-only |
| Amazon and eBay product review alerts | No API exists; scraping is forbidden. Seller feedback replaces it |
| Website product reviews | Client does not want them |
| Responding to A-to-z claims | No API; stays in Seller Central |
| In-system OCR of invoices | Replaced by outside extraction plus CSV/paste import (section 5.6) |
| Billing, plans, payments | v1 has no billing; schema is ready for it |
| Shopify, WooCommerce and other website connectors | Later; the connector contract (3.5) is generic |
| HMRC/MTD submission, 9-box return, PAYE/NI calculation | Figures only; Xero stays the accounting system |
| Bank feeds or bank statement import | Client: "just a figure" |
| Foreign currency, non-UK marketplaces, imports | UK and GBP only |
| Mixed-product bundles | Client: never two different products in a bundle |
| Purchases linked to SKUs / automatic stock-in from purchases | Client: stock-in is manual |
| ML or AI models on any channel data | v1 has none; on eBay data it is permanently banned |
| Cross-platform performance comparisons (eBay defect rate vs Amazon ODR, conversion rates) | eBay licence forbids it; money comparisons only |
| Any scraping or browser automation of Seller Central, Seller Hub or the Ads console | Forbidden by Amazon and eBay terms |
| Programmatic Amazon secret rotation via AWS SQS | Manual rotation in v1 |
| Employee logins | Employees are records, not users |

## 2. Tenancy, users and permissions

The hierarchy is Platform → Workspace → Company → Channel account. Inside a workspace there are only two roles, Admin and Child, and the admin ticks which tabs and which companies each child can see.

### 2.1 Hierarchy

- **TEN-1** Every business record (company, SKU, order, expense, note, etc.) MUST carry `workspace_id`. Every query MUST be scoped by it at the data-access layer, not only in the UI. A request can never read or write another workspace's rows. Automated tests MUST prove this for every API route.
- **TEN-2** A workspace has 1..n companies. A company has: legal name, trading name, company number (optional), VAT number (optional), registered address, VAT quarter stagger (section 5.8), `is_fulfilment_provider` flag, `is_purchasing_company` flag, colour/badge for the UI. Defaults when only one company exists: it is both fulfilment provider and purchasing company.
- **TEN-3** A company has 0..n channel accounts. Each channel account belongs to exactly one company. Once a channel account has any orders, its company MUST NOT change (client decision). An admin may archive it instead.
- **TEN-4** No workspace, company or account name is hard-coded anywhere. All appear from data.
- **TEN-5** A company switcher sits in the top bar: each company the user may see, plus **Combined** (all of the user's permitted companies). Every list, chart and report respects it.
- **TEN-6** Workspace settings: timezone (default Europe/London), currency fixed GBP, default VAT rate 20%, PII retention (fixed and shown read-only: live copy deleted 25 days after delivery so every copy, including backups, is gone by day 30; section 7.3), notification preferences.

### 2.2 Onboarding and sign-up

- **TEN-7** v1 onboarding is **invite-only**. A platform admin creates a workspace and invites its first admin by email. The invite link expires in 72 hours **\[Claude default\]**.
- **TEN-8** Open self sign-up MUST be built (sign-up page, email verification, workspace creation wizard) but sit behind a platform feature flag `public_signup`, **off** at launch.
- **TEN-9** First-run wizard for a new workspace admin: set up MFA → create companies → connect channels → connect carriers → invite users. Each step can be skipped and resumed.
- **TEN-10** Billing is not built. The schema MUST include a `plan` field on the workspace (value `free_internal` at launch) and a place for limits (`max_channel_accounts`, `max_users`), enforced only if set.

### 2.3 Accounts and login

- **USR-1** One named login per person, identified by email. Shared logins are prohibited and the UI says so on the invite screen.
- **USR-2** A person may belong to more than one workspace and picks one after login.
- **USR-3** Passwords: minimum 12 characters, must not contain the user's name or email local part, checked against a breached-password list, last 10 passwords cannot be reused, maximum age 365 days, minimum age 1 day.
- **USR-4** MFA is mandatory for every user (TOTP authenticator app; 10 single-use recovery codes). Login is impossible without completing MFA setup.
- **USR-5** Lockout after 10 failed attempts within 15 minutes; locked for 15 minutes; admins and the user are notified **\[Claude default for the duration\]**.
- **USR-6** Sessions: idle timeout 30 minutes, absolute lifetime 12 hours, sign out on all devices from the profile page **\[Claude default\]**.
- **USR-7** Password reset by email link valid 30 minutes; resetting does not bypass MFA.
- **USR-8** Removing a user or changing their permissions takes effect immediately (active sessions are revoked). Policy: access is removed within 24 hours of someone leaving.
- **USR-9** Quarterly access review: every 90 days each workspace admin gets a task listing all users and their permissions to confirm or change. Completion is logged.
- **USR-10** Employees (payroll records) are never users.

### 2.4 Roles and permissions

- **PERM-1** Two roles only: **Admin** and **Child**. No other tiers, no developer role. Developers who need access are added as named Admins in that workspace.
- **PERM-2** Admin: every tab, every company, all settings, user management, connections, finance edits, deletes.
- **PERM-3** Child: the admin ticks (a) which tabs and (b) which companies the child may see. A child sees nothing else, including in Combined view, search, exports and notifications.
- **PERM-4** Tabs that can be ticked: Home, Orders, Shipping, Stock & Catalogue, Customer Service, Account Health, Advertising, Sales & Profit, Forecasting, Finance, Reminders, Notes. Connections, Users, Settings and Audit Log are admin-only.
- **PERM-5** Within a ticked tab a child can view and do normal operational actions (create labels, adjust stock, reply to messages, enter expenses). Actions marked "admin-only" in their sections stay admin-only (for example editing an intercompany transfer, locking a VAT quarter, deleting records, bulk changes across more than one channel account).
- **PERM-6** Least privilege: a new child starts with no tabs and no companies.
- **PERM-7** At least one admin must always exist per workspace; the last admin cannot be removed or demoted.

### 2.5 Safety controls on actions

- **SAFE-1** Any action that writes to more than one channel account at once (bulk stock push, bulk ad change, bulk tracking re-send) MUST show a confirmation that names each affected account.
- **SAFE-2** Kill switch per channel account: an admin can pause all automated writes to one account (stock, tracking, ads, review requests) without affecting others. Reads continue. Paused state shows as a red banner on that account everywhere.
- **SAFE-3** Global maintenance switch (platform admin) pauses all outbound writes for all workspaces.

### 2.6 Audit log

- **AUD-1** Append-only audit log per workspace: timestamp (UTC), user, action, entity type and ID, before/after values for edits, IP address, typed reason where required.
- **AUD-2** Logged events include: logins and failures, MFA changes, user and permission changes, connection added/removed/re-authorised, kill switch changes, stock adjustments, catalogue and COGS changes, every finance create/edit/delete, intercompany edits, VAT quarter lock/unlock, exports, deletions run by the deletion service, ad changes.
- **AUD-3** Audit entries never contain buyer PII. Retention: 6 years for finance events, 12 months minimum for all others **\[Claude default: keep all 6 years\]**.
- **AUD-4** Admins can view, filter and export the audit log. Nobody can edit or delete it.

### 2.7 Platform admin console (dev team)

- **PLAT-1** Separate area at `/platform`, open only to platform admin accounts (MFA required; IP allowlist via VPN **\[Claude default\]**).
- **PLAT-2** Functions: create, suspend and archive workspaces; send invites; feature flags (`public_signup`, per-workspace module toggles); view per-workspace counts (users, channel accounts, orders per day) without business detail; job queue status and dead-letter queue; API usage vs limits per provider and per account; credential expiry calendar (Amazon client secret, eBay refresh tokens, Evri token, DPD session); system health; incident banner.
- **PLAT-3** Platform admins cannot see tenant orders, customers, finance or messages from the console. There is no impersonation in v1.
- **PLAT-4** App-level secrets (Amazon LWA client ID/secret, Ads client ID/secret, eBay keyset, verification tokens) are managed only here and stored in the secrets store (section 8).

## 3. Integrations

OmniBridge connects to six outside systems. Amazon, Amazon Ads and eBay are linked by OAuth consent through one Operator-owned app each. Websites use a signed API contract. Evri and DPD use per-workspace carrier accounts called from the server's one fixed IP.

### 3.0 Rules for every integration

- **INT-1** Every integration lives behind an adapter interface (`ChannelAdapter`, `AdsAdapter`, `ShippingProvider`). Business modules never call a provider API directly.
- **INT-2** All outbound calls go through a central job queue with per-provider, per-account rate governors (section 9.3). No request is fired from a web request handler except the OAuth exchanges.
- **INT-3** All provider tokens and secrets are encrypted in the secrets store (section 8). Nothing is hard-coded, logged or committed. Test and production credentials are separate.
- **INT-4** Every channel account shows on the **Connections** page: provider, company, status (Active / Needs re-authorisation / Paused / Error / Disconnected), last successful call, last token refresh, consecutive auth failures, API usage today vs limit, and a kill switch.
- **INT-5** Every API response used for business data is validated against a schema. Unknown fields are ignored; missing required fields raise a parser alert instead of a crash. Parsers are versioned.
- **INT-6** Each record keeps its **origin tag** (`amazon`, `amazon_ads`, `ebay`, `website`, `evri`, `dpd`, `manual`) and `channel_account_id`, so all data from one source can be found and deleted.
- **INT-7** No scraping, no headless browsers, no screen automation of any marketplace or carrier website, ever. If the API cannot do it, the feature is out of scope.
- **INT-8** All polling uses incremental cursors ("updated since") stored per account, with a 5-minute overlap window and de-duplication by external ID.

### 3.1 Amazon Selling Partner API (SP-API)

**Registration (done outside the code, by people)**

- **AMZ-1** One **public** SP-API application, registered under the Operator's developer profile in the Solution Provider Portal. Sidson's owner (primary user) completes the first registration and identity check. Raja is then added through Permissions Management → "Add Employee" with Admin rights, completes his own identity check, and runs the developer profile, role requests, security answers and the architecture review. The administrator email on file is `developer@omnibridge.co.uk`, which the dev team can read.
- **AMZ-2** The app stays in Draft (unlisted) at launch. Amazon allows a maximum of 25 seller OAuth authorisations for an unlisted app. The platform console shows authorisations used out of 25 and warns at 20. Listing on the Selling Partner Appstore (about 3–4 weeks review) is required before passing 25.
- **AMZ-3** Roles requested in **one** submission (adding a role later forces resubmission and re-authorisation):
  - Product Listing (stock quantity updates)
  - Inventory and Order Tracking (orders, returns report)
  - Direct-to-Consumer Shipping (Restricted): delivery name, address and phone for labels
  - Finance and Accounting (fees, settlements)
  - Buyer Solicitation (review requests)
  - Selling Partner Insights (account health and seller feedback reports)
  - Not requested: Buyer Communication (Amazon messaging is parked); Tax Invoicing / Tax Remittance. **\[Verify in testing\]** that the recipient name comes with the shipping address under Direct-to-Consumer Shipping alone. If it does not, add Tax Invoicing before the submission is sent.
  - Before submitting, check every operation in section 3.1 against Amazon's role-to-operation table.

**Connecting a seller (OAuth website authorisation workflow)**

- **AMZ-4** Endpoints: SP-API EU `https://sellingpartnerapi-eu.amazon.com`; UK marketplace ID `A1F83G8C2ARO7P`; consent page `https://sellercentral.amazon.co.uk/apps/authorize/consent`; LWA token `https://api.amazon.com/auth/o2/token`.
- **AMZ-5** Login URI `https://app.omnibridge.co.uk/connect/amazon/login` and Redirect URI `https://app.omnibridge.co.uk/connect/amazon/callback`, both HTTPS and registered in the app. Both pages send `Referrer-Policy: no-referrer`.
- **AMZ-6** Flow:
  1. An admin picks the company and clicks **Connect Amazon**. The server creates a `state` value: random 256 bits, bound to the user session and company, valid 10 minutes, single use.
  2. The browser goes to the consent page with `application_id`, `state` and `version=beta` while the app is in Draft.
  3. If Amazon calls the Login URI first, verify the session and redirect back to `amazon_callback_uri` with `amazon_state`, `state` and `redirect_uri`.
  4. Amazon redirects to the Redirect URI with `state`, `selling_partner_id` and `spapi_oauth_code`. Reject a missing or mismatched `state`.
  5. Within 5 minutes, exchange the code for a refresh token at LWA. Store it encrypted against a new Amazon channel account, with the selling partner ID and authorisation date.
  6. Run a first call (marketplace participations). Confirm the UK marketplace, then start the initial sync jobs.
- **AMZ-7** The same selling partner ID cannot be connected to two workspaces. A second attempt is refused with a clear message.
- **AMZ-8** Re-authorising stores the new refresh token as active and keeps the old one inactive for 7 days (multi-token store), then deletes it.

**Operations used**

| Need | Operation | Cadence |
| --- | --- | --- |
| New and changed orders | Orders API v2026-01-01 search/get orders (no Restricted Data Token needed for PII) with `lastUpdatedAfter` | Poll every 2 min per account **\[Claude default\]**; optional push below |
| Order push (optional) | Notifications API `ORDER_CHANGE` to an Amazon SQS queue in eu-west-1 | Only if the Operator configures an AWS account; the system must work fully without it |
| Ship confirmation and tracking | Orders API shipment confirmation (`confirmShipment` or its v2026 successor) with carrier name, tracking number, ship date | On label creation, through the tracking loop (3.8) |
| Stock quantity | Listings Items API `patchListingsItem` on `fulfillment_availability` (merchant-fulfilled only); for more than 20 SKUs at once, a `JSON_LISTINGS_FEED` via Feeds API | Event-driven (4.2) |
| Listing discovery for SKU mapping | Report `GET_MERCHANT_LISTINGS_ALL_DATA` | On connect, then daily |
| Fees and payouts | Finances API transactions; settlement report `GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2` | Every 6 h; settlements when available |
| Account health | Report `GET_V2_SELLER_PERFORMANCE_REPORT` (format may change; version the parser) | Daily **\[Verify in testing\]** whether more often is allowed |
| Seller feedback | Report `GET_SELLER_FEEDBACK_DATA` | Daily |
| Returns and A-to-z flag | Report `GET_XML_RETURNS_DATA_BY_RETURN_DATE` (max 60 days per request) | Daily |
| Review requests | Solicitations `getSolicitationActionsForOrder` then `createProductReviewAndSellerFeedbackSolicitation` | Daily job (4.6) |
| Keepalive | Sellers API marketplace participations | Weekly per account |

FBA listings and FBA orders are shown read-only. OmniBridge never writes FBA stock. Delivery-date field names in Orders v2026-01-01 are **\[Verify in testing\]**.

**Limits and credentials**

- **AMZ-9** Rate limits are token buckets per app–seller–region and per operation. On HTTP 429, retry with exponential backoff and full jitter (base 1 s, max 60 s, up to 8 attempts), then requeue. Use `x-amzn-RateLimit-Limit` when present, but never depend on it. Run jobs for different sellers in parallel.
- **AMZ-10** The LWA client secret expires every 180 days. Rotation is manual in the Solution Provider Portal. The secrets store holds `current` and `next` during Amazon's 7-day overlap. Platform reminders go out on day 150, 165 and 173, and on every Amazon notice email. Runbook: rotate early in the week, never on a Friday.
- **AMZ-11** Access keys unused for 90 days are deleted by Amazon. The weekly keepalive per account prevents this.
- **AMZ-12** Amazon sends no revocation signal. If token refresh fails with `invalid_grant`, or calls fail with authorisation errors 3 times in 1 hour, mark the account **Needs re-authorisation** and alert the workspace admins and platform admins. Refresh-token lifetime is disputed in Amazon's docs, so also warn admins 330 days after authorisation to re-authorise.
- **AMZ-13** Revoked or disconnected account: all data from that Amazon account MUST be deleted within 30 days (DPP 1.7). The deletion service schedules it for day 21 **\[Claude default\]**, so the follow-up purge of older backups (SEC-11) also finishes inside the 30 days. Re-authorising before then cancels it. The only exception is the statutory finance subset (section 7.3), kept separately with no PII.
- **AMZ-14** Own Evri/DPD labels on Amazon orders do not get Buy Shipping claims protection. The tracking loop (3.8) must therefore be reliable, and the UI shows a one-line note on Amazon orders.

### 3.2 Amazon Ads API

- **ADS-1** One Ads API application registered by the Operator as a tool provider. It uses a Login with Amazon security profile whose Privacy Notice URL is `https://omnibridge.co.uk/privacy`. The whole Advertising module is behind a module flag. It switches on only after Amazon approves the app.
- **ADS-2** Each company connects its own Ads account by OAuth: authorisation-code grant, scope `advertising::campaign_management`, EU API host `https://advertising-api-eu.amazon.com`, EU token endpoint `https://api.amazon.co.uk/auth/o2/token`. After consent, list profiles and let the admin pick the UK profile(s) for that company.
- **ADS-3** Data rules:
  - Ingest aggregate data only (campaign, ad group, keyword/target, search term, advertised product, by day). Never user-level impression or click data.
  - Store Campaign Details (configuration) and Performance Data (metrics) in separate, tagged tables.
  - Use ad data only inside the workspace that owns it. Never share it with other workspaces, never sell it, and never feed it to outside services.
  - A company's ad data is visible only to users permitted for that company.
- **ADS-4** Reports use the asynchronous reporting API (v3): at most 31 days per request; on connect, backfill as far back as Amazon allows (about 95 days for Sponsored Products, shorter for others **\[Verify in testing\]**); daily refresh that re-pulls the trailing provisional window (setting, default 14 days **\[Verify in testing\]**).
- **ADS-5** If the Ads app is refused, the module offers a fallback: upload of Amazon Ads console report CSVs into the same warehouse (reporting only, no campaign editing).
- **ADS-6** Before any dev team member touches live Ads data, written confidentiality and data-use terms at least as strict as the Amazon Advertising Agreement MUST be signed (Agreement 6.B).

### 3.3 eBay APIs

- **EBAY-1** One eBay developer keyset registered by the Operator. Each company connects its eBay account(s) through eBay OAuth consent as "Your Users". The keyset is never shared.
- **EBAY-2** **Gate before any production call:** the Marketplace Account Deletion endpoint `https://app.omnibridge.co.uk/webhooks/ebay/account-deletion` must be live and subscribed. Its rules:
  - It uses a verification token of 32–80 characters.
  - It answers the challenge `GET` with JSON `{"challengeResponse": SHA-256 hex of challengeCode + verificationToken + endpoint}`, with no byte-order mark.
  - It verifies the `X-EBAY-SIGNATURE` on `POST`s and returns 200 within 3 s.
  - It queues the deletion of that user's data, which must be irreversible.
- **EBAY-3** RuName settings: display title "OmniBridge"; privacy policy URL `https://omnibridge.co.uk/privacy`; accept URL `https://app.omnibridge.co.uk/connect/ebay/callback`; decline URL `https://app.omnibridge.co.uk/connect/ebay/declined`. The same `state` rules apply as for Amazon.
- **EBAY-4** Scopes: `sell.inventory`, `sell.fulfillment`, `sell.finances`, `sell.analytics.readonly`, `sell.account.readonly`, `commerce.identity.readonly`, `commerce.notification.subscription`, plus the Message API scope. Trading API calls use the same OAuth user token.
- **EBAY-5** Tokens: access token 2 h, refreshed on expiry or on an invalid-token error. Refresh token about 18 months; it is revoked if the seller changes their eBay password or username. Warn admins 30 days before expiry. On revocation (`AUTHORIZATION_REVOCATION` topic or refresh failure), mark the account Needs re-authorisation.
- **EBAY-6** Operations:

| Need | API | Notes |
| --- | --- | --- |
| Orders | Fulfillment `getOrders` filtered by `lastmodifieddate` | Poll every 5 min per account **\[Claude default\]** |
| Tracking upload | Fulfillment `createShippingFulfillment` | Via the tracking loop |
| Stock (Inventory-API listings) | Inventory `bulkUpdatePriceQuantity` | Batch size per call **\[Verify in testing\]** (docs say 1 or 25) |
| Stock (Seller Hub / legacy listings) | Trading `ReviseInventoryStatus` (up to 4 items per call) | Counts against Trading's 5,000/day |
| Listing discovery | Trading `GetMyeBaySelling` / Inventory `getInventoryItems` | On connect, then daily |
| Fees and payouts | Finances `getTransactions`, `getPayouts` | Every 6 h |
| Messages | Message API: conversations, send, update | Push via `NEW_MESSAGE` / `BUYER_QUESTION`; poll every 15 min as backup |
| Seller feedback | Trading `GetFeedback`, `RespondToFeedback` | Poll every 2 h + notification |
| Health | Analytics `getSellerStandardsProfile` (program `PROGRAM_UK`, cycles CURRENT and PROJECTED) | Hard cap: 100 calls/day for the whole app; 1 refresh per account per day + on notification |
| Notifications | Notification API subscriptions | Account deletion, authorisation revocation, messages, seller standards topics |

- **EBAY-7** Each listing is detected as Inventory-API-managed or not on discovery, and the correct stock call is used per listing.
- **EBAY-8** Daily call governor per API, app-wide: non-urgent jobs stop at 80% of the daily cap and everything stops at 95%. eBay must never be exceeded. Daily limits reset at midnight US Pacific time. `getRateLimits` and `getUserRateLimits` are read hourly into the platform console. Apply for the Application Growth Check early, after activating eBay developer support.
- **EBAY-9** Revision limit: at most 250 revisions per listing per day.
  - Debounce stock writes per listing (60 s) and skip writes that change nothing.
  - Alert at 200 revisions.
  - Hold further writes at 240 and release them after the reset, with a "stock may be stale until midnight" badge on that listing.
- **EBAY-10** Freshness: listing data shown in the UI must be at most 6 h old, other eBay content at most 24 h; otherwise show its age.
- **EBAY-11** eBay restrictions:
  - No ML or AI on eBay data.
  - No performance comparison between eBay and other channels.
  - No eBay data pushed into any website.
  - eBay buyer usernames and IDs live only in the PII store and are deleted with it.
  - On termination, destroy all eBay data within 10 days.

### 3.4 Shipping carriers (shared rules)

- **SHIP-1** A carrier account belongs to one company (usually the fulfilment provider) and can ship orders of any company in the same workspace. Admins enter carrier accounts themselves (Connections → Carriers).
- **SHIP-2** All carrier calls go out from the production server's one fixed IPv4 address, which carriers allowlist. Developer machines never call carriers directly; testing goes through the staging server or a tunnel.
- **SHIP-3** `ShippingProvider` interface: `listServices(from, to, parcels)`, `createShipment(order, parcels, service, options)` returning `{trackingNumbers[], carrierShipmentRef, labels[]}`, `getLabel(ref, format)`, and capability flags `canVoid`, `canTrack`, `needsManifest`.
- **SHIP-4** Carrier error responses are shown to the user in plain words, together with the raw code. Carrier PII sent is limited to what the label needs.

### 3.5 Evri

- **EVRI-1** Uses the Evri Business Accounts API (myHermes spec v1.4). The base URL is a setting, defaulting to the spec's host. The account must be a live **credit** account; the client will switch before integration testing. Spec credentials are secrets and never appear in code, the repo or client documents.
- **EVRI-2** Connect flow:
  1. The admin logs into Evri.
  2. The admin copies the single-use authorisation code from the browser address bar. It is valid 72 h.
  3. The admin pastes it into OmniBridge.
  4. The server exchanges it at `/oauth/token` and stores the token encrypted.

  Token lifetime is undocumented and there is no refresh. A 401 marks the carrier account Needs re-authorisation, with an alert and the runbook link.
- **EVRI-3** Create parcels: `POST /parcels`.
  - `clientUID` = `{orderRef}-{parcelNo}`, unique (a duplicate returns 400).
  - `deliveryReference` = channel order ID.
  - `weightKg`, `itemDescription` and `estimatedParcelValuePounds` are always set.
  - A 200 response can still hold failed parcels, so check every `parcelSummaries[].status` (CREATED or INVALID) and `errors[]`.
- **EVRI-4** 32-character limits on address lines 1–4, first name, last name, delivery instructions and safe place. Email max 80, phone max 32. Algorithm:
  1. Split into words.
  2. Re-flow overflow into the next empty address line.
  3. If it still does not fit, cut at a word boundary and flag the order "Address shortened". A user must confirm before the label is created.

  Unit-test this against real UK address shapes.
- **EVRI-5** Labels: `GET /labels/{barcode}` with `Accept: application/pdf,application/json` (without `application/json`, errors come back as 406). The format is a workspace setting (THERMAL default; DEFAULT, TWO\_PER\_PAGE, LARGE\_SINGLE, LARGE\_MULTI). A 403 on this call means the label is not printable (for example, already delivered). Reprints fetch by barcode and never create a new parcel.
- **EVRI-6** Evri has no void, no status endpoint and no API pickups. "Void" in OmniBridge is an internal status that adds the parcel to a "Voided labels to reconcile" list. The barcode is the tracking number.
- **EVRI-7** Contacts for the runbook: IT.integration@evri.com (send full request and response plus screenshots) and evriclientdesk@evri.com (redirect URI allowlisting).

### 3.6 DPD

This section is based on **\[Third-party source\]** evidence. Build it behind the `ShippingProvider` interface and confirm it against the official spec from the DPD account manager before go-live.

- **DPD-1** DPD UK (Geopost UK) API, base URL `https://api.dpd.co.uk`. DPD UK and DPD Local are separate services with separate credentials, so the carrier account stores which one. Credentials (username, password, account number) come from MyDPD or the DPD representative. At launch, one master DPD account under Jeez ships all three companies' orders.
- **DPD-2** Authentication:
  - Login with `POST /user/?action=login`, HTTP Basic credentials and header `GEOClient: account/{accountNumber}`. This returns a `geoSession`.
  - Later calls send `GEOSession` and `GEOClient`.
  - Re-login on 401.
  - The session is never stored longer than needed.
- **DPD-3** Operations:
  - `GET /shipping/network/` to find valid service (network) codes for the addresses and parcels.
  - `POST /shipping/shipment` to create a shipment; it returns the shipment ID and parcel numbers.
  - `GET /shipping/shipment/{shipmentId}/label/` with `Accept` set to `text/html` (laser/A4) or a thermal printer language (`text/vnd.citizen-clp` or `text/vnd.eltron-epl`). The format is a workspace setting.
- **DPD-4** DPD gives no separate test credentials. Test shipments are not charged if their labels are never scanned. Test labels must be marked and never handed to a driver. If DPD requires label approval before going live, that step goes in the go-live checklist.
- **DPD-5** Default service, parcel weight rules and collection address are set per carrier account.

### 3.7 Website connector (JeezMart first)

OmniBridge and JeezMart keep **separate databases**. JeezMart tells OmniBridge about orders through signed API calls, and OmniBridge sends JeezMart stock and tracking through signed calls to JeezMart. The contract is generic, so other custom websites can use it later.

- **WEB-1** Setup: the admin creates a Website channel account under a company and gets a connection ID, an inbound API key (shown once) and a signing secret. The admin enters the website's base URL and the website's API key for outbound calls.
- **WEB-2** Signing (both directions):
  - Headers `Authorization: Bearer {apiKey}`, `X-OB-Timestamp` (Unix seconds), `X-OB-Signature` = hex HMAC-SHA256 of `timestamp + "." + rawBody`, and `Idempotency-Key`.
  - Reject timestamps more than 5 minutes off.
  - Same idempotency key = same result.
- **WEB-3** Inbound (website → OmniBridge), base `https://app.omnibridge.co.uk/api/v1/website/{connectionId}`:
  - `POST /orders` upserts by `externalOrderId`. Body:
    - status, placedAt, currency GBP
    - lines `[ {externalSku, title, quantity, unitPriceGross} ]`
    - shippingGross, discountGross
    - buyer `{name, email, phone}` and shippingAddress `{name, line1..line4, city, county, postcode, country}`
  - `POST /orders/{externalOrderId}/cancel`
  - `POST /orders/{externalOrderId}/refunds` with `{refundId, amountGross, lines?, reason, refundedAt}`
  - `POST /products` (optional) pushes website SKUs for mapping.
  - Responses: 200/201 with the OmniBridge ID; 409 on an idempotency conflict; 422 with field errors.
- **WEB-4** Outbound (OmniBridge → website), base = the website base URL:
  - `PUT /omnibridge/stock` with `[ {externalSku, quantity} ]`, in batches of up to 100.
  - `POST /omnibridge/orders/{externalOrderId}/shipment` with `{carrier, service, trackingNumbers[], shippedAt}`.
  - `GET /omnibridge/orders?updatedSince=` is used for nightly reconciliation of missed calls.
- **WEB-5** Delivery: outbound retries back off from 1 min up to 24 h, then go to the dead-letter queue with an alert. Inbound calls are processed asynchronously after a fast 2xx.
- **WEB-6** The JeezMart side of this contract is built by the dev team in the JeezMart codebase. No eBay data is ever sent to the website.

### 3.8 Tracking push loop (all channels)

- **TRK-1** When a label is created, a tracking job is queued for the order's channel (Amazon shipment confirmation, eBay shipping fulfilment, website shipment call).
- **TRK-2** Retries at 1, 5, 15, 60, 180 and 360 minutes. If the channel has not confirmed within 4 hours **\[Claude default\]**, raise a hard alert on the order and on the Home dashboard. After the last retry the job goes to the dead-letter queue, and an admin can re-send it.
- **TRK-3** The order shows the tracking state: Pending / Sent / Confirmed / Failed, with the last error.

## 4. Functional modules

Each module below is one tab, except Catalogue and Inventory, which share the Stock & Catalogue tab. Every tab respects the company switcher and the user's permitted companies.

### 4.0 Home

- **HOME-1** The Home tab shows:
  - orders today by channel
  - orders awaiting dispatch, with how many are past their ship-by date
  - sales and units for today, 7 days and 30 days
  - open alerts, by severity (authorisation lost, tracking not confirmed, oversold, health amber/red, low stock, stale eBay listings)
  - reminders due today
  - pending tasks (access review, address-shortened orders, voided labels to reconcile)
- **HOME-2** Each tile links to the filtered list behind it. A child only sees tiles for tabs they have.

### 4.1 Catalogue (Master SKUs)

- **CAT-1** Master SKU fields:
  - SKU code (unique per workspace), title
  - short description (used as the carrier item description)
  - barcode (optional), manufacturer (free text, then reused from a dropdown)
  - weight in grams, dimensions (optional), image URL (optional)
  - VAT type, COGS (with history)
  - active flag
  - reorder settings: lead time days, safety days, target cover days
- **CAT-2** VAT type is one of four: **Standard 20%**, **Reduced 5%**, **Zero-rated 0%**, **No VAT** (exempt or outside scope). Zero-rated and No VAT are always kept as separate categories. The rates themselves are a workspace table with effective dates, so a future rate change does not need code.
- **CAT-3** Bundles contain several units of **one** Master SKU only, for example a 3-pack of SKU A. A bundle:
  - has no stock of its own: available = floor(component available ÷ pack size)
  - inherits the component's VAT type, which is locked
  - has COGS = component COGS × pack size

  Mixed-product bundles cannot be created.
- **CAT-4** COGS is entered by hand per Master SKU, one value per SKU, with an effective-from date. Each order line stores a snapshot of the COGS in effect when the order was placed. Changing COGS never changes past profit. COGS can be bulk-imported by CSV.
- **CAT-5** Channel listing mapping:
  - On connect and daily, each channel's listings are discovered (channel account, external SKU, listing ID/ASIN/item ID, title, MFN or FBA, Inventory-API-managed flag for eBay).
  - A listing is matched automatically to a Master SKU when its external SKU equals the Master SKU code exactly. Everything else goes to an **Unmapped listings** queue for manual mapping.
  - One listing maps to exactly one Master SKU. A Master SKU can have many listings.
  - Mappings can be bulk-imported and exported by CSV.
  - An unmapped listing never receives stock writes.
- **CAT-6** Orders containing an unmapped listing are flagged "Unmapped item". They still appear in orders and shipping, but they do not move stock until the listing is mapped. Mapping later back-fills the stock movement.

### 4.2 Inventory

- **INV-1** Each non-bundle Master SKU has one **on hand** number. Reserved = units in orders that are not yet dispatched or cancelled. Available = on hand − reserved.
- **INV-2** Quantity pushed to a merchant-fulfilled listing = max(0, available − safety buffer). Bundles use floor((available − buffer) ÷ pack size). The safety buffer is set per channel account (default) and can be overridden per listing. The default buffer is 0.
- **INV-3** Stock movements:
  - order placed: reserve
  - order cancelled: release
  - order dispatched: on hand −qty and reserved −qty
  - refund with "return to stock" ticked: on hand +qty
  - manual stock-in: on hand +qty, with an optional supplier/notes field (not linked to purchases)
  - manual adjustment with a required reason: Damaged / Count correction / Lost / Other + text
  - stock-take CSV import
- **INV-4** After any movement, stock is recalculated and the new quantities are queued for every affected listing on every other channel. Target: 95% of pushes sent within 2 minutes, not counting eBay revision holds and provider throttling.
- **INV-5** Change log: every movement records timestamp, Master SKU, change, new on hand, reason, source (order ref or user), and the channel listings pushed with their result. It can be filtered and exported. It is kept 3 years **\[Claude default\]**.
- **INV-6** If an order makes available fall below 0, the order is flagged **Oversold** and an alert is raised.
- **INV-7** A nightly reconciliation compares each listing's quantity on the channel with the expected quantity. Drift is corrected automatically, logged and reported. Repeated drift on the same listing raises an alert.
- **INV-8** A failed stock push retries (3.0 rules). After the last retry the listing gets a "Sync failed" badge and an alert.
- **INV-9** FBA stock is not managed by OmniBridge. FBA listings show "Fulfilled by Amazon" and are excluded from pushes.

### 4.3 Orders

- **ORD-1** One list for all channels and companies. Columns:
  - channel icon, company badge, order ref, placed date/time
  - status, item count, total gross, ship-by date
  - shipping status, tracking state
  - flags: Oversold, Unmapped item, Address shortened, Tracking not confirmed, FBA
- **ORD-2** Filters: company, channel account, status, date range, ship-by (today / overdue), flag, and search by order ref or SKU. Buyer name or postcode search works only while the PII still exists.
- **ORD-3** Normalised statuses, with the raw channel status also kept:
  - Pending payment
  - Awaiting dispatch
  - Label created
  - Dispatched
  - Delivered (if the channel reports it)
  - Cancelled
  - Partly refunded / Refunded
  - Returned
- **ORD-4** **Two-tier storage**, which is mandatory:
  - The **order record** (permanent, no PII) holds:
    - IDs, channel account, company
    - timestamps: placed, paid, ship-by, dispatched, delivered
    - lines: Master SKU, external SKU, qty, unit gross, VAT rate snapshot, VAT amount, COGS snapshot
    - shipping charged, discounts, refunds, fees, status, ship-to country

    It never holds name, address, postcode, phone, email, buyer username or ID, or IP address.
  - The **PII record** (separate encrypted store, 7.2) holds: name, address lines, town, county, postcode, country, phone, email, buyer channel ID or username, delivery instructions.
- **ORD-5** In lists, PII is masked (for example "J. S\*\*\*, G2"). It is shown in full only on the order detail page and the shipping desk, to users with the Orders or Shipping tab. Every full PII view is logged (user, order, time).
- **ORD-6** The order detail page shows lines, money breakdown, status history, labels and tracking, the tracking push state, and internal notes. The notes field warns: no customer details. When PII has been deleted, the page says "Customer details deleted on {date} under the 30-day rule".
- **ORD-7** Returns view: Amazon returns from the returns report (reason, status, A-to-z flag, inferred claim deadline labelled **Estimate**), plus refunds from every channel. It is read-only.
- **ORD-8** Order export to CSV contains no PII.

### 4.4 Shipping desk

- **SHP-1** A queue of orders awaiting dispatch, filtered by company, channel and ship-by, sorted by ship-by date.
- **SHP-2** Labels for one order or many (up to 200 per batch):
  1. Pick the carrier account and service. Defaults come from shipping rules.
  2. Confirm parcel count and weight. Weight defaults to the sum of SKU weights plus a packaging allowance setting.
  3. Create the labels.
  4. Get one merged print file in the workspace's label format.
- **SHP-3** Shipping rules are an ordered list per workspace. Each rule has conditions (channel, company, total weight range, item count, destination postcode prefix) and an action (carrier account + service). The first match wins, and a manual override is always allowed **\[Claude default\]**.
- **SHP-4** On label creation: the order goes to Label created, then Dispatched (setting `auto_dispatch_on_label`, default on **\[Claude default\]**). Stock moves and the tracking job is queued.
- **SHP-5** Reprint fetches the existing label. "Void" marks it void in OmniBridge, returns the order to Awaiting dispatch and adds it to the reconcile list. It never calls a carrier void that does not exist.
- **SHP-6** Optional packing slip PDF (setting): order ref, items, quantities, and the delivery name and address rendered on demand. It is never stored.
- **SHP-7** Label cost: a per-service cost table per carrier account, entered by the admin, is used for profit **\[Claude default\]**. Carrier APIs do not return the price.
- **SHP-8** Partial dispatch (some lines now, the rest later) SHOULD be supported where the channel allows it. Otherwise one label set per order.

### 4.5 Customer service

- **CS-1** eBay messages: a two-way inbox per eBay account, with:
  - conversation list with unread counts
  - thread view and plain-text reply
  - mark read, unread and archived
  - a link to the order when there is one
  - saved reply templates (SHOULD)

  Counts are exact (native).
- **CS-2** Message content is buyer personal data. It is stored in the PII store and deleted 30 days after the conversation's last activity **\[Claude default\]**. Conversation metadata (dates, order ref, status) is kept.
- **CS-3** eBay seller feedback:
  - lists new feedback by rating
  - alerts on neutral and negative
  - lets users reply from the dashboard (`RespondToFeedback`)
  - shows rating counts for 30 days, 6 months and 12 months

  The rating and comment are kept. The buyer username is kept in the PII store only.
- **CS-4** Amazon seller feedback: new feedback from the daily report, with an alert on ratings of 3 or below. It is display-only, because there is no reply API.
- **CS-5** Amazon review requests:
  - A daily job per Amazon account, switched on and off per account.
  - Candidate orders are those where today is between (earliest delivery date + 5 days) and (latest delivery date + 30 days), with no request sent yet, and not cancelled or fully refunded **\[Claude default to skip refunded\]**.
  - For each candidate, call `getSolicitationActionsForOrder`. If a solicitation is allowed, send it.
  - Maximum one per order, ever. Record the result: Sent / Not eligible / Error.
  - Optional per-SKU exclusion list.
  - The job uses order IDs only, never PII.

### 4.6 Account health

- **HLT-1** Amazon screen, one card per Amazon account:
  - account status
  - Order Defect Rate, Late Shipment Rate, Pre-fulfilment Cancel Rate, Valid Tracking Rate, policy-violation counts
  - account health rating, where the report provides it

  Each metric shows its value, period and green/amber/red against thresholds the admin can edit. The defaults are Amazon's published targets.
- **HLT-2** eBay screen, one card per eBay account:
  - seller level
  - transaction defect rate
  - cases closed without seller resolution
  - late delivery rate

  It shows current and projected cycles and the next evaluation date (around the 20th). Only eBay's own values are shown, with no composite score. Valid Tracking Rate is not shown (US-only).
- **HLT-3** Amazon and eBay are on **separate screens**. No chart or table may put eBay and Amazon performance metrics side by side.
- **HLT-4** Alerts fire when a metric changes band, when account status changes, and when a report fails to parse.
- **HLT-5** Data age is shown on every card ("updated 3 h ago").

### 4.7 Advertising (Amazon Ads; module flag)

- **AD-1** Campaign list per company and Ads profile:
  - type (SP / SB / SD), state, budget
  - spend, sales, ACOS, ROAS, impressions, clicks, CTR, CPC, orders
  - date range filters and period comparison

  Drill down into ad groups, keywords/targets, search terms and advertised products.
- **AD-2** Edits: campaign state, daily budget, keyword and target bids, add keywords, add negative keywords (exact and phrase), and create Sponsored Products campaigns (auto or manual) with a wizard. SB and SD: state and budget edits (SHOULD). All edits go through the queue, are written to the audit log, and need confirmation when they are bulk.
- **AD-3** Rules engine:
  - **Scope:** campaigns, ad groups or keywords.
  - **Condition:** one or more metric thresholds over a lookback window, for example ACOS above 40% and clicks of at least 20 over 14 days.
  - **Action:** bid down or up by a %, pause, set budget, or add an exact negative.
  - **Schedule:** daily at a set time, or day-of-week budget schedules.
  - **Safety caps:** maximum % change per run, and minimum and maximum bid.
  - **Dry-run preview** before enabling.
  - **Run log** of every change made.

  Amazon-native target-ROAS and portfolio budgets are used only if the API supports them **\[Verify in testing\]**. The rules engine does not depend on them.
- **AD-4** Negative keyword finder: search terms with spend of at least £X and zero orders over N days (both settings) are listed as suggestions. Applying them needs confirmation.
- **AD-5** Warehouse:
  - Daily aggregates are kept for as long as the Ads account stays connected.
  - On disconnect they are deleted within 30 days **\[Claude default\]**.
  - The last N days (default 14) are flagged **Provisional**.
- **AD-6** Ad spend per Master SKU comes from the advertised-product report and feeds Sales & Profit. At order level it is labelled **Allocated estimate**.

### 4.8 Sales & Profit dashboard

- **PRF-1** Tiles and a time chart for the selected period:
  - gross sales, units, orders, refunds
  - output VAT, channel fees (net of reclaimable VAT), ad spend
  - COGS, label cost
  - **contribution profit** and margin %
- **PRF-2** Contribution profit = (gross sales − refunds) − output VAT − channel fees (net of VAT) − ad spend − COGS − label cost. Overheads are in the Finance P&L (5.9), which is a separate view.
- **PRF-3** Breakdown by company, channel account, Master SKU and custom clusters (saved groups of channel accounts). Comparison against the previous period and the same period last year. Presets: today, yesterday, 7 days, 30 days, this month, last month, this quarter, custom.
- **PRF-4** Cross-channel views compare money only: revenue, cost, profit, margin. No conversion, defect or other performance ratios across channels.
- **PRF-5** Figures that depend on provisional or estimated data carry a marker.

### 4.9 Forecasting

- **FC-1** Per Master SKU (bundle sales converted to component units):
  - velocity over 7, 30 and 90 days
  - blended velocity = 0.5 × v7 + 0.3 × v30 + 0.2 × v90 **\[Claude default\]**
  - days of cover = available ÷ blended velocity
  - reorder point = blended velocity × (lead time + safety days)
  - suggested order quantity = blended velocity × target cover days − available (minimum 0)
- **FC-2** Low-stock alert when days of cover falls below lead time + safety days. Shown as a list sorted by urgency, exportable to CSV.
- **FC-3** Only statistical formulas. No ML or AI model of any kind in v1. A code-level guard rejects any future model input that includes eBay-origin data.

### 4.10 Reminders and Notes

- **TOOL-1** Reminders:
  - title, details, due date and time
  - recurrence: none, daily, weekly, monthly or yearly
  - assignee: yourself or another user in the workspace
  - in-app notification and email at the due time
  - complete, snooze (1 h, tomorrow, next week)
- **TOOL-2** Notes: title and body (simple formatting). Private by default, with an option to share with the workspace.
- **TOOL-3** Both show the banner "Do not store customer details here". Before saving, a simple check for postcodes, phone numbers and email addresses warns the user **\[Claude default\]**.

## 5. Finance module

The Finance tab produces VAT and profit figures for each company and for the combined group, for the accountant to use in Xero. It never files with HMRC and never calculates tax or National Insurance on pay. The accountant set the core VAT rules: standard VAT scheme for all companies, a sale counts on the order date, refunds and discounts reduce VAT at the original rate, and VAT is rounded on the order total.

### 5.1 Principles

- **FIN-1** All money is GBP, stored as integer pence. Rounding is half-up to the penny **\[Claude default\]**.
- **FIN-2** Every finance figure can be shown per company and combined, and every total can be traced to the rows behind it (drill-down).
- **FIN-3** Every create, edit and delete in Finance goes to the audit log with before and after values.
- **FIN-4** Finance records never contain buyer PII.
- **FIN-5** VAT treatment is a setting on each channel account: `seller_accounts_for_vat` (default) or `marketplace_accounts_for_vat`. This covers a possible future HMRC change for marketplaces. With the second setting, sales count in profit but not in output VAT.

### 5.2 VAT on sales (output VAT)

- **VAT-1** Tax point = the date the order was placed (accountant). That date decides the VAT quarter.
- **VAT-2** Each order line takes its VAT rate from its Master SKU's VAT type, as a snapshot when the order is placed. Prices from channels are VAT-inclusive.
- **VAT-3** Calculation per order:
  1. Group the lines by VAT rate.
  2. Deduct discounts from each group, pro-rata to the group's goods value.
  3. Add shipping charged to the customer (it is part of the sale price), split across the groups pro-rata to goods value. If all lines share one rate, shipping takes that rate **\[Claude default for the split\]**.
  4. For each group, VAT = gross × rate ÷ (1 + rate), rounded once on that group total, not per line.
  5. Net = gross − VAT.

```latex
\text{VAT}_{group} = \operatorname{round}\left( G_{group} \times \frac{r}{1+r} \right), \qquad G_{group} = \text{goods}_{group} - \text{discount}_{group} + \text{shipping}_{group}
```

- **VAT-4** Zero-rated sales and No VAT sales both have VAT 0. They are reported as two separate lines in every VAT report.
- **VAT-5** Refunds reduce VAT at the original sale's rate. A refund tied to lines uses those lines' rates. A refund without line detail is split across the original order's rate groups, pro-rata to their gross. A refund counts in the VAT quarter of the refund date **\[Claude default\]**.
- **VAT-6** An order cancelled before payment is captured is excluded from VAT. An order cancelled after a refund is handled as a refund.
- **VAT-7** Changing a SKU's VAT type affects only orders placed after the change.

### 5.3 Channel fees and fee VAT

- **FEE-1** Fees are pulled automatically: Amazon from the Finances API and settlement reports; eBay from the Finances API. Fees are stored per order where the channel gives an order link, otherwise per account per day. Examples: referral, FBA, per-item, advertising if charged through settlement, subscription, and other.
- **FEE-2** Fee VAT: Amazon charges 20% UK VAT on most fees, which is reclaimable input VAT. A **fee-type mapping table** (editable per channel) says, for each fee type, whether it carries UK VAT, is reverse-charged, or carries no VAT.
  - If the API gives the VAT amount, use it.
  - Otherwise derive it from the mapping. **\[Verify in testing\]** whether Amazon and eBay data separate fee VAT per line.
- **FEE-3** Reverse-charged fees (for example some fees invoiced from Luxembourg) are recorded as both reverse-charge output VAT and equal input VAT, net zero, and shown on separate lines.
- **FEE-4** Payouts are recorded per channel account: payout ID, period, gross sales, fees, refunds, reserves, net paid, date.

### 5.4 Expenses and purchases

- **EXP-1** Expense fields:
  - company; supplier; category
  - invoice date; due date (optional)
  - amount, with a **VAT-inclusive / VAT-exclusive toggle**; VAT rate; VAT amount (calculated automatically, editable to match the invoice)
  - invoice number (optional); supplier VAT number (optional)
  - status Paid / Unpaid; paid date
  - notes; attachments
- **EXP-2** Suppliers and categories have no fixed list. A name is typed the first time and offered from a dropdown after that. Seed categories:
  - Stock purchases (by manufacturer)
  - Rent, Utilities, Packaging & consumables, Postage & carriage
  - Software & subscriptions, Professional fees, Other

  Payroll and Intercompany are system categories.
- **EXP-3** Supplier record: name, VAT number (optional), bank details (optional, encrypted, visible to admins only, since a sole trader's bank details are personal data).
- **EXP-4** By default, stock purchases and overheads are booked to the workspace's purchasing company (Jeez). Booking an expense to a different company, or moving it, is allowed. It needs a confirmation step and a typed reason that is kept in the audit history.
- **EXP-5** Unpaid-bill reminders: 3 days before the due date, on the due date, then every 7 days while overdue **\[Claude default\]**. In-app and email to users with the Finance tab for that company.
- **EXP-6** Attachments: PDF, JPG or PNG, up to 10 MB each **\[Claude default\]**, virus-scanned on upload, kept 6 years from the invoice date, then deleted.
- **EXP-7** Stock purchases are not linked to SKUs and do not change stock. Stock-in is a separate manual action (INV-3).

### 5.5 Recurring expenses

- **REC-1** Recurring template: every expense field, plus frequency (daily, weekly, monthly, quarterly, yearly), start date, optional end date, and "mark as paid automatically" (for direct debits).
- **REC-2** On each due date the system creates the expense entry automatically and notifies the Finance users of that company each time. Entries stay fully editable.
- **REC-3** Editing a template changes future entries only. Pausing or ending a template stops future entries.

### 5.6 Supplier invoice import (no in-system OCR)

- **IMP-1** Staff read invoices with an outside AI tool (for example ChatGPT) and bring the data in by:
  - (a) CSV upload in the OmniBridge template
  - (b) pasting a table (CSV or tab-separated) into a box
  - (c) the manual expense form
- **IMP-2** Template columns: `company, supplier, supplier_vat_number, invoice_number, invoice_date, due_date, category, description, amount, amount_includes_vat (Y/N), vat_rate, vat_amount, status, paid_date`.
- **IMP-3** The import shows a preview grid before saving, with checks:
  - required fields and date formats
  - VAT arithmetic (gross = net + VAT within £0.01)
  - unknown company
  - possible duplicates (same supplier + invoice number, or same supplier + date + amount)

  Rows with errors cannot be saved until they are fixed or removed. Invoice PDFs are attached after import.
- **IMP-4** The import page has a ready-to-copy prompt that tells the outside AI tool to output exactly this template **\[Claude default\]**. It also shows the rule: never paste customer details into outside AI tools.

### 5.7 Intercompany transfers

- **ICT-1** Record fields:
  - from company, to company, date, description
  - type: Fulfilment service / Overhead recharge / Stock recharge / Other
  - one or more lines, each with a net amount and a VAT treatment: **Standard 20%**, **Zero 0%**, or **Internal transfer, no VAT** (chosen per line, as the accountant asked)
- **ICT-2** Effects:
  - The "to" company gets an expense and the "from" company gets recharge income, both in the P&L.
  - Lines with 20% or 0% create output VAT for the from-company and input VAT for the to-company, in the quarter of the transfer date.
  - Internal lines have no VAT effect.
  - Transfers never change customer sales VAT.
- **ICT-3** Every transfer produces a PDF "Intercompany transfer record" (both companies' details, lines, VAT where present, reference number). The record and the PDF are stored together.
- **ICT-4** Edit and delete are **admin-only**. They need a confirmation dialog and a typed reason of at least 10 characters. The reason is kept permanently in the transfer's history, which is shown on the record, and in the audit log. The PDF is regenerated with a new version number.
- **ICT-5** Optional monthly **stock recharge suggestion** (setting, default on): it adds up the COGS of each other company's sales whose stock the purchasing company bought, and creates a **draft** transfer for an admin to confirm. Nothing is posted without confirmation **\[Claude default\]**.

### 5.8 VAT quarters and settlement

- **VQ-1** Each company has a VAT period setting: quarterly stagger 1 (quarters end Mar, Jun, Sep, Dec), stagger 2 (Apr, Jul, Oct, Jan), stagger 3 (May, Aug, Nov, Feb), or monthly.
  - **\[Claude default, not the accountant's\]:** all three launch companies start on **stagger 1 (Mar/Jun/Sep/Dec)**.
  - This MUST be shown as an editable, highlighted setting until an admin confirms each company's real stagger from its HMRC VAT account.
- **VQ-2** VAT settlement per company per period:

| Line | Source |
| --- | --- |
| Output VAT on sales, by rate (20%, 5%) | 5.2 |
| Net sales at 0% (zero-rated) | 5.2 |
| Net sales with No VAT | 5.2 |
| Less VAT on refunds | 5.2 |
| Intercompany output VAT | 5.7 |
| Reverse-charge output VAT | 5.3 |
| **VAT payable** | sum |
| Input VAT on expenses | 5.4 |
| Input VAT on channel fees | 5.3 |
| Intercompany input VAT | 5.7 |
| Reverse-charge input VAT | 5.3 |
| **VAT claimable** | sum |
| **Settlement = payable − claimable** | positive = owed to HMRC, negative = repayment |

- **VQ-3** Locking: an admin marks a period **Filed**, which locks it. Records dated in a locked period cannot be created, edited or deleted. A late item for a locked period (for example a fee that arrives later) is posted to the next open period as an adjustment, labelled with its original date **\[Claude default\]**. Unlocking is admin-only, needs a typed reason and is logged.
- **VQ-4** The settlement screen has date and period filters, a breakdown per channel account, and drill-down to the rows behind each figure.

### 5.9 Profit and loss

- **PL-1** P&L per company for a month, quarter, year or custom range:
  - **Income:** net sales (ex VAT) by channel, less net refunds; intercompany recharge income.
  - **Cost of sales:** COGS (order-line snapshots), channel fees (net of reclaimable VAT), ad spend, label costs.
  - **Gross profit.**
  - **Overheads:** expenses by category (net of reclaimable VAT), payroll total cost, intercompany expenses.
  - **Net profit.**
- **PL-2** P&L basis setting, default **COGS basis** **\[Claude default, pending the accountant\]**: product cost comes from COGS on items sold, and the Stock purchases category is left out of the P&L, so stock cost is never counted twice. Stock purchases appear in their own Purchases report instead. The alternative "Purchases basis" uses stock purchases and ignores COGS.
- **PL-3** The combined P&L is the sum of the selected companies' P&Ls with intercompany income and expense removed on both sides.
- **PL-4** The Finance P&L and the Sales & Profit dashboard (4.8) are separate views.

### 5.10 Employees and payroll (records only)

- **PAY-1** Employee record: name, internal reference number, role, Remote/Onsite (a label only), company (default Jeez), start date, end date, active status.
- **PAY-2** Monthly payroll record per employee: month, payment date, total cost to business, net paid, external payroll provider reference.
- **PAY-3** Never stored: National Insurance number, bank details, home address, date of birth, phone. The form has no fields for them.
- **PAY-4** No PAYE, NI or statutory calculation. Payroll totals feed the P&L as overhead in the employee's company.
- **PAY-5** Employees have no login. Only admins and children with the Finance tab for that company can see payroll.
- **PAY-6** Payroll records are kept 6 years, then deleted.

### 5.11 Exports for the accountant (Xero)

- **XP-1** Six CSV reports, each for one company or combined, for any date range or VAT period:
  1. **Payout summary per channel:** payout ID, channel account, period, gross sales, refunds, fees, fee VAT, other, net paid, date.
  2. **VAT summary:** every line of the settlement table (VQ-2), by period.
  3. **Expenses register:** every expense with VAT split, status and attachment file names. An optional ZIP holds the attachments.
  4. **Monthly payroll summary:** per employee and total.
  5. **Intercompany register:** every transfer with lines, VAT treatment and edit history count.
  6. **P&L:** as in 5.9.
- **XP-2** Optional Xero manual-journal CSV format (setting, off by default). The journals MUST balance (debits = credits), and an account-code mapping table is editable per company.
- **XP-3** Still waiting on the accountant, but not blocking: whether there is one Xero organisation per company; whether A2X or Link My Books is already used (if so, report 1 is not needed); whether the six reports are enough. Build all six now.

## 6. Notifications, alerts and reminders

All alerts land in one notification centre (bell icon). Critical alerts are also emailed. Every alert says how reliable its signal is: **Native** (straight from the platform), **Derived** (calculated by OmniBridge) or **Estimate**.

- **NTF-1** Every notification records: severity (Critical / Warning / Info), type, company, channel account, linked record, signal label, created time, and state (Unread / Read / Resolved). A notification resolves itself automatically when its condition clears.
- **NTF-2** Recipients: workspace admins, plus children whose ticked tabs and companies cover the linked record. Platform-level alerts go to platform admins.
- **NTF-3** Email is sent through a transactional email service with EU hosting, from `notifications@omnibridge.co.uk` **\[Claude default\]**. SPF, DKIM and DMARC are set at GoDaddy. Emails never contain buyer PII: they say what happened and link to the app.
- **NTF-4** Users choose email on or off per type. Critical alerts cannot be switched off for admins.
- **NTF-5** Duplicates are suppressed. The same type for the same record raises one notification, which is updated in place.

| Type | Severity | Signal | Trigger |
| --- | --- | --- | --- |
| Channel authorisation lost / needs re-auth | Critical | Native/Derived | AMZ-12, EBAY-5, EVRI-2 |
| Deletion scheduled for disconnected account | Critical | Derived | AMZ-13 |
| Tracking not confirmed in 4 h | Critical | Derived | TRK-2 |
| Account status change (Amazon) / seller level change (eBay) | Critical | Native | HLT-4 |
| Health metric changed band | Warning | Native | HLT-4 |
| Oversold | Critical | Derived | INV-6 |
| Stock sync failed / drift | Warning | Derived | INV-7, INV-8 |
| eBay listing held by revision limit | Warning | Derived | EBAY-9 |
| eBay API usage above 80% | Warning (platform) | Derived | EBAY-8 |
| Low stock / reorder | Info | Derived | FC-2 |
| New eBay message | Info | Native | CS-1 |
| Neutral/negative eBay feedback; Amazon feedback of 3 or below | Warning | Native | CS-3, CS-4 |
| Return with A-to-z flag | Warning | Native, deadline Estimate | ORD-7 |
| Unpaid bill due / overdue | Info / Warning | Derived | EXP-5 |
| Recurring expense created | Info | Derived | REC-2 |
| Ads rule run made changes | Info | Derived | AD-3 |
| Report or parser failure | Warning (platform) | Derived | INT-5 |
| Amazon client secret rotation due (day 150/165/173) | Critical (platform) | Derived | AMZ-10 |
| Amazon authorisations at 20 of 25 | Warning (platform) | Derived | AMZ-2 |
| Quarterly access review due | Info | Derived | USR-9 |
| Reminder due | Info | n/a | TOOL-1 |

## 7. Data protection, retention and deletion

Buyer personal data is kept in a separate encrypted store. Every copy of it, including backups, is gone within 30 days after delivery, or 30 days after dispatch if the delivery date is unknown, with no exceptions. To achieve this, the live copy is deleted at day 25 and PII backups keep only 3 days. Cancelled orders lose it as soon as the cancellation is confirmed. Until the data agreements are signed, only test data is used.

### 7.1 Roles (who is responsible)

- **DP-1** Each workspace customer is the **controller** of its own customers' and staff data. At launch, that means each of Jeez, Sidson and Kyyz for its own customers. Jeez acts as a processor for Sidson's and Kyyz's orders because it fulfils them.
- **DP-2** The Operator is the **processor** for every workspace. The dev team's company in Pakistan is a **sub-processor**. netcup (hosting) and the email provider are sub-processors. Evri and DPD receive delivery data as carriers.
- **DP-3** eBay's data protection terms treat the developer as an independent controller of eBay data and as an importer from the first production call (Pakistan has no UK adequacy). The Operator accepts this when activating the eBay keyset.

### 7.2 PII store

- **DP-4** The PII store is physically separate from the main database: its own database, its own credentials and its own encryption keys.
- **DP-5** It holds:
  - buyer name, address, postcode, phone and email
  - buyer channel IDs and usernames
  - delivery instructions
  - eBay message contents
  - eBay feedback buyer usernames

  Nothing else.
- **DP-6** Each record is encrypted at application level (AES-256-GCM, a per-workspace data key wrapped by a master key held outside the database). Disk encryption is applied as well.
- **DP-7** Only the services that need PII can reach the store, and only for these purposes:
  - **Read:** shipping label creation, order detail view and the eBay inbox.
  - **Write:** order and message ingestion.
  - **Delete:** the deletion service.
  - **Search:** erasure requests (DEL-4) and subject access requests (DEL-5).
  - **Masked values** for lists (ORD-5), computed on request and never stored.

  Every read and search is logged without the PII itself.
- **DP-8** PII never appears in:
  - logs
  - error trackers
  - analytics
  - exports
  - emails
  - notifications
  - the main database
  - backups of the main database

  Developers never copy production PII to their own computers.

### 7.3 Retention schedule

| Data | Kept for | Then |
| --- | --- | --- |
| Buyer PII on delivered orders | Live copy: 25 days after delivery (25 days after dispatch if delivery unknown). Every copy including backups: gone by day 30 | Hard delete |
| Buyer PII on cancelled orders | Until cancellation is confirmed by the channel, at most 30 days after the order was placed | Hard delete |
| Buyer PII on orders never dispatched or cancelled | Until dispatch or cancellation; alert at 30 days; hard limit 90 days after placement **\[Claude default\]** | Hard delete |
| eBay message contents | 30 days after the conversation's last activity **\[Claude default\]** | Hard delete |
| Order records (no PII) and statutory finance fields | 6 years after the end of the VAT period | Delete |
| Expenses, invoice files, intercompany, payroll | 6 years | Delete |
| Stock change log | 3 years **\[Claude default\]** | Delete |
| Ads warehouse | While connected; within 30 days of disconnect | Delete |
| Amazon data after revocation or disconnect | Deleted by day 21; older main-database backups purged within days after, so all copies are gone within Amazon's 30-day limit; only the statutory finance subset stays | Delete |
| eBay data after account deletion notice | Within 30 days; tax fields only if legally required | Delete |
| All eBay data after eBay API termination | 10 days | Delete and certify |
| Audit and security logs | 6 years finance events; at least 12 months everything else **\[Claude default: 6 years for all\]** | Delete |
| Notifications | 12 months **\[Claude default\]** | Delete |

### 7.4 Deletion service

- **DEL-1** One deletion service handles every trigger:
  1. a scheduled PII expiry (hourly job)
  2. an order cancellation
  3. a UK GDPR erasure request
  4. an eBay `MARKETPLACE_ACCOUNT_DELETION` notice
  5. an Amazon revocation, disconnect or notice
  6. an eBay termination
  7. workspace closure
- **DEL-2** Deletion is a hard delete, not a flag. It cannot be reversed even with the highest database privilege. Backups of the PII store keep at most 3 daily snapshots, and hidden backup files are removed after 1 day **\[Claude default\]**. With the live copy deleted at day 25, no copy survives past day 30. A tombstone list of deleted IDs is applied after any restore, so deleted data never comes back.
- **DEL-3** Each run logs the time, the trigger, the scope (counts and IDs) and the result. It never logs the deleted values. On request, an admin can download a deletion certificate for a channel account.
- **DEL-4** Erasure requests: an admin enters the buyer's identifiers, the system finds every match in the PII store and deletes it. The admin gets a confirmation. Requests must be completed within 1 month. Finance records with no PII are kept under the legal-obligation exception.
- **DEL-5** Subject access requests: an admin can export everything held about one buyer (PII store matches plus the linked order records) as a file.

### 7.5 Before real data

- **DP-9** Production runs on synthetic test data only until every one of these is signed:
  - data processing agreements in the chain: each company and the Operator; the Operator and the dev team company; Sidson and Kyyz with Jeez for fulfilment
  - a UK International Data Transfer Agreement (IDTA) and a transfer risk assessment for access from Pakistan, covering customer and staff data
  - netcup's data processing agreement
  - developer confidentiality agreements, including the Amazon Ads flow-down
  - the OmniBridge terms of use, which include eBay's third-party-beneficiary clause
- **DP-10** If the risk assessment ever finds a significant risk, the IDTA requires access from Pakistan to be suspended. The runbook covers how production access is cut off and restored.
- **DP-11** Each controller company checks whether it needs to pay the ICO data protection fee and keeps a record of processing. The Operator keeps a processor record.

## 8. Security requirements

Security follows the Amazon SP-API Data Protection Policy (DPP), the strictest rulebook the platform is bound by, so meeting it also covers eBay's controls and UK GDPR. The named security contact for Amazon incidents is Hashir.

### 8.1 Application

- **SEC-1** HTTPS only, TLS 1.2 or higher, HSTS. Secure, HttpOnly, SameSite cookies. CSRF protection on every state-changing request.
- **SEC-2** Standard web protections:
  - a strict Content Security Policy
  - output encoding
  - parameterised queries
  - file uploads checked by type and size and virus-scanned
  - rate limiting on login, sign-up, password reset and the public APIs
- **SEC-3** Server-side authorisation checks on every request (workspace, role, tab, company). The UI is never trusted.
- **SEC-4** Dependency and code scanning run in CI before every release. A release with critical findings is blocked.
- **SEC-5** No secrets in code, config files in the repo, container images or logs. Secrets live in an encrypted secrets store (a self-hosted vault or encrypted environment injected at runtime). The coding agent picks one. Each one has a documented owner and rotation date.
- **SEC-6** Provider tokens and secrets are encrypted at rest (AES-256-GCM, envelope encryption). The master key never sits in the same place as the database. Programmatic credentials are rotated at least every 12 months, and Amazon's client secret every 180 days.

### 8.2 Infrastructure

- **SEC-7** Separate **production** and **staging** environments on separate servers, with separate credentials and separate data. Staging only ever holds synthetic data **\[Claude default: a second, smaller netcup server, VPS 1000 G12.5 with 8 GB\]**. The load test and the first restore drill run on the production server before go-live, while it still holds only synthetic data.
- **SEC-8** Only ports 80 and 443 face the internet (80 redirects to 443). SSH and admin tools are reachable only through a VPN or bastion with key-based login and MFA. Every privileged command is logged.
- **SEC-9** Protection at the edge and on the host:
  - a web application firewall in front of the app
  - intrusion detection on the host
  - host firewall that denies by default
  - containers on separate internal networks: web, workers, main database, PII database
  - anti-malware on the server
- **SEC-10** Automatic security updates. Vulnerability scans at least every 30 days. Critical findings fixed within 7 days and high within 30 days. A penetration test before go-live and then every year.
- **SEC-11** Encrypted backups of both databases daily, stored in a second, geographically separate location in the EU (never in a US region).
  - **Location:** Backblaze B2, EU Central region. Data is encrypted on our server before upload, and no key leaves our side.
  - **Separation:** main and PII each have their own bucket, key and password.
  - **Ransomware protection:** the key held on the server cannot delete or overwrite existing backups, and pruning runs off-server.
  - **Main database retention:** 7 daily + 4 weekly + 6 monthly snapshots. After any account-level deletion run, older main snapshots are purged, so deleted provider data also leaves backups within the provider's deadline.
  - **PII backups** follow DEL-2.
  - **Restore tests:** a restore is tested every quarter.
- **SEC-12** Logs are kept 12 months or more, with no PII, and reviewed at least every 2 weeks. Alerts fire on unusual logins, mass exports, mass PII views, and on canary records: fake PII records whose access triggers an alarm.
- **SEC-13** A network diagram and an asset inventory are kept current and reviewed every quarter.

### 8.3 People and process

- **SEC-14** Everyone with production access has their own named account, MFA, a signed confidentiality agreement and yearly security training. Access is removed within 24 hours of leaving. Access is reviewed every quarter.
- **SEC-15** Developer computers have screen lock at 15 minutes or less, disk encryption and anti-malware, and never hold production PII.
- **SEC-16** Change management: every change goes through a pull request reviewed by a second developer. Production deploys go through CI only, and the deploy log is kept.
- **SEC-17** Incident response plan, reviewed every 6 months:
  - detection
  - containment
  - notification of Amazon at `security@amazon.com` within 24 hours of a security incident involving Amazon data
  - notification of eBay and affected controllers as their terms require
  - ICO notification within 72 hours when required
  - post-incident review
- **SEC-18** Written policies to keep (drafted by the dev team):
  - information security policy
  - access control policy
  - retention schedule (7.3)
  - incident response plan
  - business-change notice policy (tell Amazon within 30 days of organisational changes)
  - subcontractor risk assessment, yearly
  - records of processing

## 9. Non-functional requirements

OmniBridge runs as one Docker deployment on one netcup server in Germany with one fixed IPv4 address. It is sized for 10 times today's volume, and every outside call goes through a durable job queue with rate governors.

&#91;embedded content: OmniBridge architecture · one server, two databases\]

Every call to an outside system leaves from the workers through the one fixed IP. Inbound webhooks and OAuth returns arrive at the web app. Buyer data only ever sits in the separate PII database.

### 9.1 Capacity and speed

| ID | Measure | Target |
| --- | --- | --- |
| **CAP-1** | Order volume (today) | 1,000–2,000 orders per week |
| **CAP-2** | Design capacity | 20,000 orders per week; bursts of 20 orders per minute |
| **CAP-3** | Tenants (design) | 100 workspaces, 1,000 channel accounts, 500 concurrent users |
| **CAP-4** | Catalogue (design) | 50,000 Master SKUs and 200,000 listings per workspace |
| **CAP-5** | Stock push after a sale | 95% sent within 2 minutes (excluding eBay holds and throttling) |
| **CAP-6** | New order visible in OmniBridge | Within 5 minutes of the channel, set by the polling cadences |
| **CAP-7** | Page load (lists, dashboards) | p95 under 1 s at design capacity; list APIs paginate (default 50 rows) |
| **CAP-8** | Label batch of 50 | Created and printable within 2 minutes, subject to carrier speed |
| **CAP-9** | Availability | 99.5% monthly, excluding announced maintenance |
| **CAP-10** | Recovery | RPO 24 h (main data), RTO 8 h |

### 9.2 Architecture constraints

The coding agent chooses the stack. These constraints are fixed:

- **NFR-1** One web application (UI + API) and separate background workers, all containerised. They can run on one server now and be split later without code changes.
- **NFR-2** One main relational database (multi-tenant, `workspace_id` on every row) and one separate PII database (7.2). There is no shared-database link to JeezMart.
- **NFR-3** A durable job queue that persists jobs across restarts. Jobs are idempotent, retry with backoff, have a dead-letter queue and are scheduled with cron-like timing. Each job records its workspace, channel account and attempt count.
- **NFR-4** Long work (syncs, reports, exports, label batches, imports) always runs in workers. The UI shows progress and the result when done.
- **NFR-5** File storage for labels, invoice attachments and export files: encrypted, served only through signed short-lived links after a permission check. Generated labels carry the delivery name and address, so they count as PII. They are stored only inside the PII boundary (section 7.2), encrypted with the PII keys and never backed up. They are deleted at the earlier of 30 days after creation or the order's PII deletion, and are regenerated from the carrier on demand.
- **NFR-6** Server-side caching may be used for dashboards. Cache keys include `workspace_id` and the user's permitted companies.
- **NFR-7** Times are stored in UTC and shown in Europe/London. Dates for VAT use the London date.
- **NFR-8** The UI is responsive. It is built for desktop first, and the shipping desk and orders also work on a tablet. It meets WCAG 2.1 AA for contrast and keyboard use. It uses a professional, calm back-office style. The design system is chosen with the client from mock-ups.
- **NFR-9** English (UK) only, with UK date format (DD/MM/YYYY) and £ formatting.

### 9.3 Rate governors (asymmetric by design)

- **RL-1** Amazon: per seller and per operation, reacting to 429 with exponential backoff and full jitter (AMZ-9). Sellers run in parallel.
- **RL-2** eBay: a hard daily budget per API across the whole app (EBAY-8) and per listing (EBAY-9). Calls are counted before they are sent. eBay must never be exceeded.
- **RL-3** The Amazon and eBay governors are separate code paths. They never share one retry helper.
- **RL-4** Carriers and websites: a concurrency cap per account (default 4 parallel requests **\[Claude default\]**) and backoff on 429 or 5xx.
- **RL-5** The platform console shows usage against limits for every provider, account and API, in real time.

### 9.4 Hosting and operations

- **OPS-1** Production: one netcup **VPS 2000 G12.5** in Germany (8 shared vCores, 16 GB RAM, 256 GB SSD), shared with JeezMart (9.5).
  - JeezMart is planned at no more than 3 GB RAM and 2 cores.
  - Scale vertically first. The planned upgrade is a **VPS 4000 G12.5**. It is taken only when monitoring meets a trigger in the server-upgrade runbook (`docs/ops/runbooks/server-upgrade.md`) after tuning is exhausted.
  - Staging runs on a second, smaller server (SEC-7).
- **OPS-2** The fixed IPv4 address is permanent. It is the address that Evri and DPD allowlist. It must survive a server rebuild, upgrade or replacement. All carrier and website calls therefore leave from a **netcup failover IPv4**, which can be moved to another server, and never from the server's main IP. If the failover IP is ever lost, the runbook covers re-allowlisting with Evri and DPD.
- **OPS-3** Deployment: CI builds images, runs tests and scans, and deploys to staging automatically and to production on approval. Database migrations run forward-only and are tested on staging first. Deployments have zero downtime where possible, with a maintenance banner otherwise.
- **OPS-4** Monitoring: uptime checks on the public site and app (each server watches the other, plus one free external checker; see OPS-11), alerts on errors, queue depth, dead-letter growth, disk, memory, certificate expiry and backup failures. Alerts go to the dev team. Error tracking is scrubbed of PII.
- **OPS-5** Runbooks are kept for:
  - Amazon client secret rotation
  - Amazon or eBay re-authorisation
  - Evri re-authorisation
  - DPD login failures
  - restore from backup
  - cutting off Pakistan access (DP-10)
  - incident response
  - eBay deletion endpoint failure
- **OPS-6** Daily health digest to platform admins: jobs failed, API usage, credentials expiring in the next 30 days, deletion runs.

### 9.5 Shared production server (OmniBridge + JeezMart)

The production netcup server will also host the JeezMart website. Another developer moves JeezMart there later, and that move is out of scope. Both apps share one machine to cut cost, so OmniBridge must be lean, and neither app may affect the other.

- **OPS-7** OmniBridge must run correctly whether or not JeezMart is on the server.
- **OPS-8** Isolation: each app has its own Docker Compose project, container networks, databases and database roles, secrets, deploy pipeline, backups, and Linux user and directory. There are no shared schemas and no cross-database queries. Deploying, restarting, overloading or crashing one app never touches the other.
- **OPS-9** Only these are shared:
  - the host OS
  - the Docker engine
  - the firewall
  - the fixed IPv4 addresses
  - one edge reverse proxy that terminates TLS and routes by domain, with the web application firewall inside it
  - the host security layer (VPN, intrusion detection, automatic updates)
  - **one** ClamAV daemon that serves both apps' upload scanning and the host malware scan

  Each app reaches the shared ClamAV daemon over its own network. Each app's proxy routes live in their own config file, so each app changes only its own routes.
- **OPS-10** Resource budget:
  - Every OmniBridge container has explicit memory and CPU limits.
  - PostgreSQL, the workers and any cache are tuned to those limits, with connection pooling.
  - Background concurrency is capped.
  - Heavy jobs (backfills, reconciliations, large exports) run throttled in low-traffic hours.
  - The total OmniBridge budget is written in the architecture document.
- **OPS-11** Fully self-hosted. PostgreSQL, auth, job queue, cache and file storage run on the server or as libraries inside the app. No Vercel, Supabase, Firebase or other managed backend. The only outside services are:

- the transactional email sender (MAIL-2)
- the off-server encrypted backup location (SEC-11)
- one free external uptime checker, which only polls the public site and `/healthz` and never sees PII Prefer mature, industry-standard open-source tools that use little memory. No Kubernetes, Kafka, Elasticsearch or other heavy infrastructure.
- **OPS-12** JeezMart and OmniBridge talk only through the signed website contract (3.7), even on the same server. Traffic may use an internal network, but signing and idempotency stay on.

## 10. Public website, legal pages and email

The public site at `omnibridge.co.uk` must be open without login, use valid HTTPS, show the Operator's name, the app name and logo, and carry a privacy policy, terms and a contact method. Amazon and eBay check this before approving the apps.

### 10.1 Domains

- **WWW-1** The domain is registered at GoDaddy, and its DNS stays at GoDaddy.
  - `omnibridge.co.uk` and `www` serve the public site (www redirects to the bare domain).
  - `app.omnibridge.co.uk` serves the logged-in app, the OAuth pages, webhooks and the public APIs.
  - Both point at the production server's fixed IP.
  - TLS certificates renew automatically.

### 10.2 Pages

| Page | Path | Content |
| --- | --- | --- |
| Home | `/` | What OmniBridge does (multichannel stock, orders, shipping, ads, profit, VAT figures for UK sellers); screenshots; "Request access" button |
| Features | `/features` | One block per module (section 4 and 5) |
| Security & data | `/security` | Plain-English summary: EU hosting in Germany, encryption, 30-day deletion of customer details, MFA, no passwords ever asked for |
| Privacy policy | `/privacy` | Full policy (10.3) |
| Terms of service | `/terms` | Full terms (10.3) |
| Cookies | `/cookies` | Only essential cookies are used |
| Contact | `/contact` | `support@omnibridge.co.uk`, `privacy@omnibridge.co.uk`, a contact form (stored in the app, emailed to support), the registered address |
| Sign in | `app.omnibridge.co.uk/login` | Login + MFA |
| Sign up | `app.omnibridge.co.uk/signup` | Behind the `public_signup` flag; when off it shows "Request access" |
| eBay declined | `app.omnibridge.co.uk/connect/ebay/declined` | Friendly message + retry |

- **WWW-2** Every page footer reads: "OmniBridge is operated by `[OPERATOR_LEGAL_NAME]`, company number `[OPERATOR_COMPANY_NUMBER]`, registered office `[OPERATOR_REGISTERED_ADDRESS]`". The values are platform settings, not hard-coded. This must match the company on the Amazon developer profile.
- **WWW-3** There are no tracking or advertising scripts. Analytics, if any, must be cookieless and self-hosted **\[Claude default: none in v1\]**.
- **WWW-4** The public site has no login wall and no "under construction" pages at the moment of Amazon's review.

### 10.3 Legal content (drafted by the dev team, reviewed by the client)

- **WWW-5** The privacy policy covers:
  - who the Operator is
  - what data is processed and from where (Amazon, Amazon Ads, eBay, websites, carriers)
  - why
  - the 30-day buyer data rule
  - retention (7.3)
  - sub-processors (netcup Germany, the email provider, Evri, DPD, the dev team in Pakistan under an IDTA)
  - international transfers
  - security
  - data subject rights and how to use them
  - contact `privacy@`
  - the ICO complaint route
  - the date of the last update
- **WWW-6** The terms of service cover:
  - the service, and accounts with no shared logins
  - acceptable use
  - customer responsibilities for their channel accounts
  - the data processing terms, which are incorporated
  - the eBay terms required for "Your Users", including eBay as third-party beneficiary
  - Amazon data rules passed on to workspace users
  - liability, suspension and termination
  - English law
- **WWW-7** Users accept the current terms and privacy policy on first login and again after a material change. Acceptance is logged with the version.

### 10.4 Email

- **MAIL-1** Mailboxes on `omnibridge.co.uk` use **Zoho Mail Lite with 2 paid users**: the client and the developer.
  - The addresses below are free aliases on those 2 users. No more users are added.
  - MX, SPF, DKIM and DMARC records are set at GoDaddy.
  - Do not run a mail server on the app server.
  - `developer@`: Amazon's administrator email on file, Amazon and eBay developer notices. The dev team must read it daily because Amazon closes cases after 5 days without a reply.
  - `support@` and `privacy@`: public contacts.
  - `security@`: incident contact.
  - `notifications@`: sender address for system email (MAIL-2); replies land in the developer's mailbox.
  - No other paid email spend.
- **MAIL-2** System email (invites, password reset, alerts, reminders) goes through a pay-per-use transactional sending service with EU hosting, from `notifications@omnibridge.co.uk`, with SPF, DKIM and DMARC.
  - It must cost under about €2 per month at our volume.
  - Default: Scaleway Transactional Email. Fallback: Brevo's free tier.
  - The sending domain needs DNS records only, not mailboxes.
- **MAIL-3** Email templates are plain and branded. They carry no buyer PII and no secrets. Links expire as set in section 2.

## 11. Data model

The entities below are the minimum the build needs. The coding agent may add fields and tables but must not merge the PII database into the main one, or drop `workspace_id`, origin tags or snapshot fields. Every main-database table except platform tables has `id` (UUID), `workspace_id`, `created_at`, `updated_at`.

### 11.1 Main database

| Entity | Key fields |
| --- | --- |
| Workspace | name, plan, limits, settings (timezone, label formats, auto\_dispatch\_on\_label, P&L basis, provisional days), status |
| Company | legal\_name, trading\_name, company\_number, vat\_number, address, vat\_period (stagger1/2/3/monthly), vat\_period\_confirmed (bool), is\_fulfilment\_provider, is\_purchasing\_company, badge\_colour |
| User | email, name, password hash, MFA secret (encrypted), recovery codes (hashed), status, last\_login |
| Membership | user\_id, workspace\_id, role (admin/child), tabs\[\], company\_ids\[\] |
| Invite | email, workspace\_id, role, tabs\[\], company\_ids\[\], token hash, expires\_at |
| ChannelAccount | company\_id, provider (amazon/amazon\_ads/ebay/website), external\_id (selling partner ID / eBay user / Ads profile / website connection), display\_name, status, paused (kill switch), vat\_treatment, default\_safety\_buffer, last\_success\_at, last\_refresh\_at, auth\_failures, authorised\_at, deletion\_scheduled\_at |
| Credential | channel\_account\_id or carrier\_account\_id, kind, encrypted\_value, is\_active, expires\_at, rotated\_at |
| CarrierAccount | company\_id, carrier (evri/dpd), variant (DPD UK/DPD Local), account\_number, settings (default service, label format, collection address), status, service\_cost\_table |
| ShippingRule | priority, conditions (json), carrier\_account\_id, service\_code |
| MasterSku | sku, title, short\_description, barcode, manufacturer, weight\_g, dims, vat\_type, is\_bundle, component\_sku\_id, pack\_size, active, lead\_time\_days, safety\_days, target\_cover\_days |
| CogsHistory | master\_sku\_id, cogs\_pence, effective\_from, entered\_by |
| VatRate | vat\_type, rate, effective\_from |
| Listing | channel\_account\_id, external\_sku, external\_listing\_id, title, fulfilment (MFN/FBA), inventory\_managed, master\_sku\_id (nullable), safety\_buffer\_override, last\_pushed\_qty, last\_pushed\_at, revisions\_today, held\_until |
| StockLevel | master\_sku\_id, on\_hand, reserved |
| StockMovement | master\_sku\_id, delta, on\_hand\_after, reason, source\_type, source\_id, user\_id, note |
| Order | channel\_account\_id, company\_id, external\_order\_id, origin, status, raw\_status, placed\_at, paid\_at, ship\_by\_at, dispatched\_at, delivered\_at, cancelled\_at, currency, goods\_gross, shipping\_gross, discount\_gross, total\_gross, ship\_to\_country, flags\[\], pii\_ref (UUID into PII DB), pii\_deleted\_at, tracking\_state |
| OrderLine | order\_id, listing\_id, master\_sku\_id, external\_sku, quantity, unit\_gross, line\_gross, vat\_type\_snapshot, vat\_rate\_snapshot, vat\_amount, cogs\_snapshot\_pence |
| Refund | order\_id, external\_refund\_id, amount\_gross, vat\_amount, lines(json), refunded\_at, return\_to\_stock |
| ReturnRecord | order\_id, reason, status, a\_to\_z\_flag, claim\_created\_at, estimated\_deadline |
| Shipment | order\_id, carrier\_account\_id, service, parcels, weight\_g, tracking\_numbers\[\], carrier\_ref, client\_uid, label\_file\_ref, status (created/voided), cost\_pence |
| TrackingPush | order\_id, shipment\_id, channel\_account\_id, state, attempts, last\_error, confirmed\_at |
| Fee | channel\_account\_id, order\_id (nullable), fee\_type, amount\_pence, vat\_pence, vat\_treatment (uk\_vat/reverse\_charge/none), posted\_at, source\_ref |
| Payout | channel\_account\_id, external\_id, period\_start, period\_end, gross, fees, refunds, reserves, net, paid\_at |
| ConversationMeta | channel\_account\_id, external\_conversation\_id, order\_id, last\_activity\_at, unread, status, pii\_ref |
| Feedback | channel\_account\_id, external\_id, rating, comment, left\_at, reply\_text, replied\_at, pii\_ref |
| Solicitation | order\_id, state (sent/not\_eligible/error), checked\_at, sent\_at |
| HealthSnapshot | channel\_account\_id, metric, value, period, band, captured\_at, parser\_version |
| AdsCampaignDetail / AdsAdGroup / AdsKeyword / AdsTarget | channel\_account\_id, profile\_id, external\_id, settings (budget, bids, state, match type), tag = campaign\_details |
| AdsPerformanceDaily | channel\_account\_id, level, entity\_id, date, impressions, clicks, spend, sales, orders, units, provisional, tag = performance\_data |
| AdsRule / AdsRuleRun | definition json, schedule, caps, enabled / run time, changes json |
| Supplier | name, vat\_number, bank\_details\_encrypted |
| Expense | company\_id, supplier\_id, category, invoice\_date, due\_date, amount\_entered, entered\_includes\_vat, vat\_rate, net\_pence, vat\_pence, gross\_pence, invoice\_number, status, paid\_date, notes, recurring\_template\_id, period\_locked |
| Attachment | owner\_type, owner\_id, file\_ref, mime, size, sha256, delete\_after |
| RecurringTemplate | expense fields + frequency, start, end, auto\_paid, next\_run\_at, active |
| IntercompanyTransfer | from\_company\_id, to\_company\_id, date, type, reference, version, pdf\_file\_ref |
| IntercompanyLine | transfer\_id, description, net\_pence, vat\_treatment, vat\_pence |
| VatPeriod | company\_id, start, end, status (open/filed), filed\_at, filed\_by |
| Employee | name, internal\_ref, role, work\_mode (remote/onsite), company\_id, start\_date, end\_date, active |
| PayrollRecord | employee\_id, month, payment\_date, total\_cost\_pence, net\_paid\_pence, provider\_ref |
| Reminder / Note | owner, assignee, title, body, due\_at, recurrence, shared |
| Notification | type, severity, signal, company\_id, entity, state, recipients |
| AuditEvent | user\_id, action, entity, before, after, reason, ip, at (append-only) |
| DeletionRun | trigger, scope, counts, started\_at, finished\_at, result |
| Job | type, workspace\_id, channel\_account\_id, payload, state, attempts, run\_at, last\_error |
| SyncCursor | channel\_account\_id, stream, cursor\_value, updated\_at |

### 11.2 PII database (separate)

| Entity | Key fields |
| --- | --- |
| BuyerContact | pii\_ref (UUID), workspace\_id, origin, channel\_account\_id, name, address lines 1–4, town, county, postcode, country, phone, email, buyer\_channel\_id, delivery\_instructions (all encrypted per field), delete\_after |
| MessageContent | pii\_ref, conversation external ID, messages json (encrypted), delete\_after |
| FeedbackBuyer | pii\_ref, buyer username (encrypted), delete\_after |
| PiiAccessLog | pii\_ref, user\_id, purpose, at (no values) |
| Tombstone | pii\_ref, deleted\_at, trigger |

### 11.3 Platform tables

PlatformAdmin, FeatureFlag, AppSecret (Amazon LWA, Ads, eBay keyset, eBay verification token), ApiUsage (provider, api, account, day, calls, limit), CredentialCalendar, LegalDocumentVersion, TermsAcceptance.

## 12. Delivery plan and acceptance criteria

The client has set no date and no required module order. The plan below is **\[Claude default\]**. Each phase ends when its acceptance tests pass locally; tests that need a real server or a live provider (for example AT-4 on staging, AT-23, AT-24, AT-25) pass in phases 8 and 9.

### 12.1 Phases

**Local-first (v1.3, Hashir):** phases 1 to 7 are designed, built and tested on local Docker with provider mocks. No server is used until phase 8. Local containers keep the production memory and CPU limits from day one.

1. **Foundations.** Repo, CI, secrets store, job queue, main and PII databases, auth with MFA, workspaces, companies, roles with tab and company ticks, audit log, the ops stack (monitoring, backup and restore scripts) running locally, notification centre, deletion service, platform console, public site and legal pages, eBay account-deletion endpoint.
   - Gate out: all of it passes on localhost. Going live on HTTPS moves to phase 8, unless Hashir asks for an early mini-deploy of just the public site and the eBay endpoint so the approvals can start sooner.
2. **Catalogue, inventory, website and shipping.** Master SKUs, COGS, bundles, the stock engine, the website connector with the JeezMart side built, orders (website), shipping desk, Evri, DPD, tracking loop, Reminders and Notes.
   - Gate out: the Evri credit account and the DPD account are active, and the server IP is allowlisted, before carrier tests.
3. **eBay.** Connect, listings and mapping, orders, stock push with revision guard, tracking, messages, feedback, health, finances, and the daily governor.
   - Gate in: the deletion endpoint is subscribed and the keyset is activated. The Growth Check is applied for.
4. **Finance.** Expenses, import, recurring, intercompany, payroll, VAT periods and settlement, P&L, exports. This phase can run in parallel with phases 2 and 3.
5. **Amazon SP-API.** Connect (OAuth), listings and mapping, orders, stock, shipment confirmation, finances and fees, health, returns, feedback, review requests, keepalive, revocation handling.
   - Gate in: the developer profile and roles are approved, which needs the architecture review.
6. **Amazon Ads.** Connect, warehouse and backfill, campaign manager, rules, negative finder, ad spend per SKU.
   - Gate in: the Ads app is approved. If it is refused, ship the CSV-upload fallback (ADS-5).
7. **Profit and forecasting.** Sales & Profit dashboard, forecasting, Home.
8. **Deploy.** Staging and production servers, host hardening, edge proxy and WAF live, CI deploys, B2 backups, public site live on HTTPS, eBay deletion endpoint subscribed, Amazon/Ads/eBay applications sent, and verify-live checks for every provider as approvals arrive.
   - Gate in: Hashir provides the servers, failover IP, DNS and service accounts.
9. **Hardening and go-live.** Penetration test, restore test and load test on the production server, and the go-live checklist (13.5).
   - Gate to real data: every agreement in DP-9 is signed.

In phases 2 to 6, the "Gate" lines above apply to live verification only. Building runs on mocks, and the live checks happen in phase 8.

### 12.2 Acceptance tests (each MUST pass)

1. A user of workspace A cannot read or change any record of workspace B through any API route. There is an automated test per route.
2. A child with tabs {Orders} and company {Sidson} sees only Sidson orders, including in Combined view, search, exports and notifications. Every other tab returns 403.
3. Login is impossible without MFA. 10 failed attempts lock the account for 15 minutes. Removing a user ends their active sessions immediately.
4. Selling 1 unit on any channel lowers the quantity on every other mapped merchant-fulfilled listing within 2 minutes (staging, without throttling).
5. A bundle of 3 shows floor(available ÷ 3) and cannot be created with two different SKUs.
6. Changing COGS does not change the profit of orders placed before the change.
7. The 241st revision of one eBay listing in a day is held and released after the reset. The eBay governor never sends a call above 95% of any daily cap (simulated).
8. An order's PII is gone from the PII database at day 25 after delivery, and from its backups (after restore + tombstones) and every log by day 30. With no delivery date, the same days count from dispatch. On confirmed cancellation, the live copy goes at once.
9. No buyer PII appears in the main database, logs, error tracker, exports or emails. An automated scan of test data with marker values proves this.
10. An eBay account-deletion `POST` deletes that user's PII. The challenge `GET` returns the correct hash with no byte-order mark.
11. A revoked Amazon account shows Needs re-authorisation within 1 hour of the first failure and schedules full deletion for day 21. Re-authorising cancels it.
12. Evri: a 200 response with one INVALID parcel shows that parcel as failed. A 33-character address line re-flows or is flagged "Address shortened". A reprint does not create a new parcel.
13. Every label creation leads to a channel tracking push. A push not confirmed in 4 hours raises a critical alert.
14. Website connector: a replayed request with the same idempotency key creates no duplicate. A bad signature or a timestamp more than 5 minutes old is rejected.
15. VAT: an order of a £12.00 standard-rated item and a £6.00 zero-rated item, with £3.00 shipping, gives VAT £2.33 on the standard group (£12 + £2 shipping = £14.00 × 1/6 = £2.333, rounded to £2.33) and £0 on the zero group (£6 + £1). Zero-rated and No VAT are reported separately.
16. A refund of £6.00 on a £12.00 standard-rated line reduces output VAT by £1.00 in the refund date's quarter.
17. A filed VAT quarter blocks edits. A late fee for it posts to the next open quarter. Unlocking needs a reason and is logged.
18. An intercompany edit without a typed reason is refused. The edit history shows the old values and the reason. Combined P&L removes both sides.
19. A recurring monthly expense creates its entry on the due date and sends a notification.
20. CSV import rejects a row where gross ≠ net + VAT by more than £0.01, and flags a duplicate supplier + invoice number.
21. The six exports open in a spreadsheet, total correctly to the settlement and P&L screens, and contain no PII.
22. The Amazon and eBay health screens never show each other's metrics side by side.
23. The public site passes these checks: no login wall, a valid certificate, privacy, terms and contact pages, and a footer naming the Operator.
24. Restoring from backup works within 8 hours, and deleted PII does not reappear. The first drill runs on the production server before go-live; later drills run on staging.
25. A load test at design capacity (9.1) meets the page and stock-push targets. It runs on the production server before go-live, while it holds only synthetic data.

## 13. Decisions, Claude defaults, open items and go-live

Nothing below blocks coding. Open items are built as settings, or behind adapters, so their answers change configuration, not code.

### 13.1 Locked decisions (client, accountant, team)

| # | Decision | Source |
| --- | --- | --- |
| 1 | Build as multi-tenant SaaS; launch with one workspace of three companies; new accounts added by clicking | Client, 17 Oct |
| 2 | Amazon public developer path; Sidson's owner does first registration and ID check; Raja added as developer user and runs reviews | Client, 17 Oct |
| 3 | Operator = one company for website, Amazon app, Ads app and eBay keyset (expected Sidson; legal details to follow) | Client, 17 Oct (default accepted) |
| 4 | Invite-only launch; open sign-up built but off; no billing in v1 | Client (defaults accepted) |
| 5 | Admin and Child roles only; admin ticks tabs and companies; named logins only | Client |
| 6 | Fulfilment provider and intercompany are generic, not tied to Jeez | Client (default accepted) |
| 7 | JeezMart is the only website connector in v1; separate databases, API calls both ways | Client, 17 Oct |
| 8 | Each workspace enters its own carrier accounts; one fixed server IP | Client (default accepted) |
| 9 | Evri and DPD both in v1; Evri moves to a credit account before testing; one master DPD account under Jeez | Client and accountant |
| 10 | Amazon buyer message tracker parked | Client (default accepted) |
| 11 | Supplier invoices extracted outside with ChatGPT, imported by CSV/paste/form; no in-system OCR | Client |
| 12 | Cancelled orders lose PII on confirmed cancellation, at most 30 days | Client (default accepted) |
| 13 | Buyer PII deleted 30 days after delivery, else after dispatch; no exceptions. Implemented as: live copy deleted at day 25, so every copy including backups is gone by day 30 (v1.2) | Client |
| 14 | Same-SKU bundles only; manual stock-in; purchases not linked to SKUs; manual COGS, past profit keeps old COGS | Client |
| 15 | Standard VAT scheme; tax point = order date; refunds/discounts reduce VAT at original rate; round on order total; inc/exc toggle; VAT per intercompany line | Accountant |
| 16 | Four VAT types per SKU; Zero-rated and No VAT separate; UK and GBP only; shipping inside sale price | Client |
| 17 | Intercompany edits: confirm + typed reason, permanent history | Client |
| 18 | Paid/Unpaid tracking with reminders; invoice number and supplier VAT number optional | Client |
| 19 | Recurring expenses daily–yearly, auto-created, editable, notification each time | Client |
| 20 | Payroll figures only; minimal employee fields; no NI, bank, address | Client |
| 21 | Combined P&L removes intercompany transfers | Client (default accepted) |
| 22 | Xero stays; six CSV reports | Client |
| 23 | eBay seller feedback alerts and replies replace product reviews; Amazon review requests use Amazon's window | Client |
| 24 | Hosting: netcup, Germany; one shared production server (VPS 2000 G12.5) plus a small staging server; carrier calls from one failover IP | Client, updated 18 Oct (Hashir) |
| 25 | Security contact: Hashir | Team, 17 Oct |
| 26 | Tech stack chosen by the coding agent | Client, 17 Oct |
| 27 | No solicitor; paperwork from official templates | Client |

### 13.2 Claude defaults (editable; client may change any)

| Item | Default | Where |
| --- | --- | --- |
| **VAT quarter stagger for all three companies** | **Stagger 1: quarters end Mar, Jun, Sep, Dec. Chosen by Claude, not the accountant. Must be confirmed per company from HMRC.** | VQ-1 |
| Shipping split across VAT rates | Pro-rata to goods value | VAT-3 |
| Refund VAT period | Quarter of the refund date | VAT-5 |
| Late items for locked quarter | Post to next open quarter as adjustment | VQ-3 |
| P&L basis | COGS basis; stock purchases outside P&L | PL-2 |
| Stock recharge suggestion | On, drafts only | ICT-5 |
| Unpaid bill reminders | 3 days before, on due date, weekly after | EXP-5 |
| Attachment limit | PDF/JPG/PNG, 10 MB | EXP-6 |
| Rounding | Half-up to the penny | FIN-1 |
| Amazon order polling | Every 2 min; SQS push optional | 3.1 |
| eBay order polling | Every 5 min | EBAY-6 |
| Deletion day for revoked Amazon accounts | Day 21, with older backups purged after | AMZ-13 |
| Tracking confirmation window | 4 hours | TRK-2 |
| Never-dispatched order PII limit | 90 days after placement | 7.3 |
| eBay message content retention | 30 days after last activity | CS-2 |
| Stock log retention | 3 years | INV-5 |
| Audit log retention | 6 years for all | AUD-3 |
| Lockout, sessions | 10 fails / 15 min lock; 30 min idle; 12 h max | USR-5, USR-6 |
| Invite expiry | 72 hours | TEN-7 |
| Auto-dispatch on label | On | SHP-4 |
| Label cost | Admin-entered cost table | SHP-7 |
| Forecast blend | 0.5 × 7-day + 0.3 × 30-day + 0.2 × 90-day | FC-1 |
| Review requests skip refunded orders | Yes | CS-5 |
| Ads data after disconnect | Delete within 30 days | AD-5 |
| Server size | Production netcup VPS 2000 G12.5 (16 GB) shared with JeezMart (≤3 GB); upgrade to VPS 4000 G12.5 only on runbook triggers; staging VPS 1000 G12.5 | OPS-1, SEC-7 |
| PII live deletion | 25 days after delivery (or dispatch), so all copies are gone by day 30 | 7.3 |
| PII backup history | 3 daily snapshots; hidden files removed after 1 day | DEL-2 |
| Main database backup history | 7 daily + 4 weekly + 6 monthly; purged after account-level deletions | SEC-11 |
| Delivery plan order | Section 12.1 | 12 |

### 13.3 Waiting on people (not blocking)

| Item | Who | Effect when answered |
| --- | --- | --- |
| Operator legal name, company number, registered address | Client | Fill platform settings and legal pages |
| Email hosting on omnibridge.co.uk | Team/client | Create developer@, support@, privacy@, security@ |
| Each company's real VAT stagger | Client/accountant | Change VQ-1 setting |
| One Xero org per company? A2X or Link My Books in use? Six reports enough? | Accountant | Toggle export options |
| P&L basis confirmation | Accountant | PL-2 setting |
| Pakistan company registration | Team | Unblocks DPA, IDTA and transfer risk assessment signatures |
| Raja's identity documents for the Amazon portal | Client/Raja | Unblocks the developer profile |
| Official DPD API spec from the DPD account manager | Client | Confirm DPD-1 to DPD-4 |

### 13.4 Verify during testing

| Check | Where |
| --- | --- |
| Recipient name comes with the Direct-to-Consumer Shipping role (else add Tax Invoicing before submitting) | AMZ-3 |
| SP-API role-to-operation mapping for every operation used | AMZ-3 |
| Orders v2026-01-01 field names (delivery dates, shipment confirmation successor) | 3.1, CS-5 |
| Amazon health report refresh frequency | 3.1 |
| Fee VAT separation in Amazon and eBay finance data; which fees are reverse-charged | FEE-2, FEE-3 |
| Amazon refresh-token lifetime (365 days vs none) | AMZ-12 |
| Ads lookback per ad type, provisional window, target-ROAS and portfolio support | ADS-4, AD-3 |
| eBay `bulkUpdatePriceQuantity` batch size (1 vs 25) | EBAY-6 |
| eBay Message API limits; whether the 100/day analytics cap is shared | EBAY-6 |
| eBay daily reset time for revision counts | EBAY-9 |
| Evri spec host still current; token lifetime; rate limits | EVRI-1, EVRI-2 |
| DPD endpoints, headers, label types, label approval step | 3.6 |
| netcup DPA covers UK GDPR (side letter if not) | DP-9 |

### 13.5 Go-live checklist

- [ ] Public site live with privacy, terms, contact, Operator footer
- [ ] `developer@omnibridge.co.uk` working and read daily
- [ ] Amazon developer profile approved with all roles in AMZ-3; app in Draft; Login and Redirect URIs registered
- [ ] Amazon Ads app approved (or ADS-5 fallback switched on)
- [ ] eBay deletion endpoint subscribed; keyset active; RuName set; Growth Check applied for
- [ ] Evri credit account live; server IP allowlisted; test label validated with Evri IT
- [ ] DPD account live; IP allowlisted if required; label approval done if DPD requires it
- [ ] DPAs, IDTA, transfer risk assessment, netcup DPA, confidentiality agreements signed
- [ ] Pen test passed; restore test passed; load test passed
- [ ] All 25 acceptance tests passed on staging
- [ ] Runbooks written (OPS-5); credential calendar filled; incident contacts set (Hashir)
- [ ] Each company's VAT stagger confirmed
- [ ] Seed data loaded: workspace, three companies, carrier accounts, shipping rules, Master SKUs and COGS

### 13.6 Change log

| Version | Date | Change |
| --- | --- | --- |
| 1.0 | 17 Oct 2026 | First locked PRD. Replaces SRS v1.0–v1.4, Source of Truth v1.0, Research Summary v2.0, Project Context and the teammate PRD. Notable changes: public Amazon app instead of private apps; one Operator-owned Ads app instead of three; SaaS tenancy; company ticks per child user; DPD back in v1; in-system OCR and the Amazon message tracker removed; intercompany VAT selectable per line (accountant). |

**v1.1, 18 Oct 2026:** added 9.5, shared production server with JeezMart and fully self-hosted stack. OPS-1 and the server-size default now point to 9.5.

**v1.2, 18 Oct 2026:** applied plan-review amendments P-001 to P-011 (`docs/DECISIONS.md`), approved by Hashir and the outside reviewer:

- header version (P-001)
- IDs CAP-1 to CAP-10 for §9.1 (P-002)
- DP-7 lists write, delete and search access (P-003)
- OPS-9 shared host security layer and one shared ClamAV daemon (P-004)
- NFR-5 label files count as PII and stay inside the PII boundary (P-005)
- AMZ-13 deletion at day 21, and SEC-11 main backup schedule with purge after deletions (P-006)
- OPS-1, OPS-2 and SEC-7: VPS 2000 G12.5, failover IP and VPS 1000 staging (P-007)
- SEC-11 Backblaze B2 EU Central (P-008)
- MAIL-1 Zoho Mail Lite with aliases, and MAIL-2 cost cap (P-009)
- PII live copy deleted at day 25 with 3-day PII backups, so every copy is gone by day 30 (TEN-6, 7.3, DEL-2, AT-8) (P-010)
- AT-11 deletion day 21, and AT-24/AT-25 first runs on production (P-006, P-007)
- OPS-11 allows one free external uptime checker (P-011)

**v1.3, 18 Oct 2026:** local-first delivery plan (P-012, Hashir). Section 12.1 now builds and tests every phase on local Docker with mocks. The servers, the public site going live and the provider applications move to a new phase 8 (Deploy), before hardening. An optional early mini-deploy of the public site and eBay endpoint stays available.
