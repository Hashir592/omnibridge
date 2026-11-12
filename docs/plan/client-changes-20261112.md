# Client changes, 12 Nov 2026: designs

Owner: S1. Source: the client's review of the T-0305 preview, sent by Hashir on 12 Nov 2026. These designs are decided (ADR-055, PRD v1.4 via P-014).

- **S2** builds them now as mock-ups (T-0306).
- **S3** builds the real logic in the owning module, and the module's tasks cite the section here.

The rules below are the contract: a builder who finds a case that is not covered stops and asks S1.

| # | Change | New or changed IDs | Module (release) | Risk |
|---|---|---|---|---|
| C1 | Home: quick view of today's orders per channel | HOME-3 | M20 (R3) | light |
| C2 | Orders list: SKU column | ORD-1 | M10 (R1) | light |
| C3 | Same-buyer order groups and "Ship together" | ORD-9, SHP-9, AT-26 | M10 + M12 (R1) | **high** |
| C4 | Order profit card: ex VAT and inc VAT | PRF-6, SHP-7, CAT-4 | M20 (R3) | normal |
| C5 | Amazon seller feedback on the Account Health screen | HLT-6, HLT-7 | M18 (R3) | normal |
| C6 | Amazon buyer messages (read and reply) | CS-6, AT-28 | M18 (R3) | **high** |
| C7 | Manual stock allocation per listing (sync off) | INV-10, INV-2, INV-7, AT-27 | M09 (R1) | **high** |

---

## C1. Home: quick view per channel (HOME-3)

- **Where:** on the Orders today card, each channel row (Amazon, eBay, Website) gets a chevron button.
- **Opening it:** shows an inline panel under that row with the latest 10 orders placed today on that channel.
  - Each row shows: order ref, time, company, total and status. No buyer details, not even masked.
  - Clicking an order opens its order detail page.
  - A "View all N" link opens the Orders list filtered to that channel and today.
- **Other rows:** only one panel is open at a time.
- **Keyboard and screen readers:** the chevron is a `button` with `aria-expanded`, and Esc closes the panel.
- **Scope:** it respects the company switcher (Combined means permitted companies only). A user without the Orders tab sees no chevron (HOME-2).
- **"Today":** the Europe/London calendar day.

## C2. Orders list: SKU column (ORD-1)

- **New column:** "SKU", after Order. It shows the Master SKU code of the first line.
  - When there are more lines, the extra count is shown as "+2" with a tooltip listing every SKU and quantity.
  - An unmapped line shows its external SKU with the Unmapped flag.
- **Columns menu:** the column can be hidden like any other.
- **Search:** SKU search already exists (ORD-2).

## C3. Same-buyer order groups and Ship together (ORD-9, SHP-9)

**Goal:** when one buyer places several orders on the same channel account around the same day, show them together so the seller can choose to send one parcel. Shipping them separately must stay just as easy.

### C3.1 When orders form a group (all must hold)

1. **Same channel account.** Not merely the same channel type: two different eBay accounts never group. Different companies can never group, because a channel account belongs to one company. FBA orders never group.
2. **Same buyer and same delivery address.** "Same" means an exact match after normalising:
   - **Name:** upper case, accents removed, spaces collapsed, punctuation removed.
   - **Address lines 1–2 and town:** the same rules.
   - **Postcode:** upper case with no spaces.
   - **Country code:** must match.

   There is **no fuzzy matching**. A missed group costs a second label; a wrong group sends goods to the wrong person.

   On eBay the buyer username must also match. A household where two people order to one address does not group, because the names differ.
3. **Both orders are Awaiting dispatch:** paid, no label, not cancelled, no open cancellation request. Pending-payment orders join a group only once they are paid.
4. **Placed close together.** Time is checked on the channel's **placed** timestamp (stored in UTC), never on the time OmniBridge received the order. Two orders are linked when either of these holds:
   - **(a)** they were placed on the same **Europe/London calendar day**, or
   - **(b)** they were placed within **`group_midnight_grace_hours`** of each other (a workspace setting, default **3 h**) and on adjacent London days.

   Rule (b) is the 23:59 / 00:01 case: those two orders are 2 minutes apart, so they group. A 10:00 order and a 22:00 order on the same London day group by (a). A 10:00 Monday order and a 10:00 Tuesday order do not group.

   The gap is measured in real elapsed time (UTC instants), so a clock change at 01:00 or 02:00 cannot stretch or shrink it. The London date comes from the IANA time-zone database. Neither rule ever uses the server's local time.
5. **Linking is transitive.** If A links to B and B links to C, then A, B and C are one group, even if A and C alone would not link. The cap is 20 orders; a 21st matching order starts a new group and raises a notice.

### C3.2 How it is computed without breaking the PII rules (invariants 7, 7a, 8)

- **Vault:** when pii-vault ingests an order's delivery details, it also stores a **match key** in db-pii. The match key is HMAC-SHA256 of the normalised name, address, postcode, country and, on eBay only, the username, under the workspace's blind-index key (the same key family as search, ADR-007).
- **New capability `match`:** it takes `(workspace, channel_account, order_ids)` and returns lists of **order IDs** that share a match key. It never returns the key or any PII. Calls are logged like `search`.
- **db-main:** stores only the result.
  - A table `order_groups (workspace_id, id, channel_account_id, state, created_at)`.
  - A nullable `orders.order_group_id`.

  This is a link between orders, not PII.
- **When groups are recomputed:**
  - after an order is ingested (in the website request, or in the order job right after vault ingest)
  - when an order changes to or from Awaiting dispatch
  - when an order is cancelled
  - when an order is labelled or dispatched

  Recompute runs only for that channel account's Awaiting-dispatch orders, so it stays small.
- **Locking:** the recompute takes a transaction-scoped advisory lock per channel account, so two jobs cannot build overlapping groups. Job payloads carry IDs only (7a).
- **PII deletion:** the match key is deleted with the PII. Groups exist only before dispatch, so expiry never affects a live group.

### C3.3 What the user sees

- **Order list and shipping desk:**
  - Group members are shown as **adjacent rows**, ordered by placed time.
  - Each member row has a coloured left rail and a thin bracket joining the rows.
  - The first row carries a chip: "Same buyer · 3 orders".
  - No tinted banner. Each row keeps its own checkbox, status and actions.
- **Sorting:** the group sorts as one unit, by its earliest member, so its rows are never split by sorting. Pagination never splits a group: a page may run over 50 rows to keep a group whole.
- **Filters:** when a filter hides some members, the visible rows show "+1 related order not shown"; clicking it clears that filter for the group.
- **Order detail:** a "Same buyer" panel lists the other orders in the group, with links.
- **Warnings shown on the group** (they never block it):
  - different ship-by dates: "Ship by the earliest: 23/10/2026"
  - different delivery services (for example one Next Day order)
  - one order has the Address shortened flag
  - one order has an Unmapped item
- **Actions:**
  - **Ship together:** creates one label for the selected group members (SHP-9).
  - **Ship separately:** nothing special is needed; each order works exactly as it does today.
  - **Not the same buyer:** admins and users with the Orders tab can choose this. It dismisses the group, records `state = dismissed` and the reason in the audit log, and the same orders are never grouped again.

### C3.4 Ship together (SHP-9)

- **One label, many orders.**
  - Weight is the sum of the orders' default weights plus one packaging allowance.
  - The carrier service is the highest needed by any member; the user can override it.
  - The ship-by date is the earliest member's.
- **Locking:** label creation locks the member orders (`SELECT … FOR UPDATE`) and re-checks them inside the transaction: all still Awaiting dispatch, same group and same match. If any member changed, nothing is created and the user is told which order changed.
- **Idempotency:** the idempotency key is the group ID plus the sorted member IDs.
- **After the label is created:**
  - Each member order moves to Label created, then Dispatched (SHP-4).
  - Each order's stock moves.
  - The tracking loop pushes **the same tracking number to every member order on its channel**, one push per order (TRK rules). Each push is confirmed on its own, and an unconfirmed one alerts on its own.
- **Label cost:** split across the members in equal shares, with the remainder pence going to the earliest orders, so the shares always add up to the label cost (largest remainder, FA-12). Each order's profit uses its share.
- **Void:** voids the shared label for every member. All members return to Awaiting dispatch and stay grouped, and the label goes to the reconcile list once (SHP-5).
- **Packing slip:** one slip that lists each order ref and its items.
- **Late arrival:** an order that arrives after the group was labelled cannot join that label. It is shown with "Same buyer as W18400 (already dispatched)" for information only.
- **Partial dispatch (SHP-8, Release 3):** only the lines being shipped now join a shared label.

### C3.5 Tests (AT-26 and unit tests, written first)

| # | Case | Expected |
|---|---|---|
| 1 | 23:59 and 00:01 London, same buyer | 1 group |
| 2 | 23:30 BST and 00:30 on the night the clocks change | 1 group |
| 3 | 09:00 Monday and 09:00 Tuesday | not grouped |
| 4 | Same buyer, two eBay accounts | not grouped |
| 5 | Same address, different name | not grouped |
| 6 | Address differs only in case or spacing | grouped |
| 7 | One order still pending payment | grouped only once paid |
| 8 | A, B, C chained | 1 group |
| 9 | One member is cancelled mid-way | group recomputed |
| 10 | Two users click Ship together at once | exactly one label |
| 11 | Void | every member back, grouped |
| 12 | £5.95 label cost over 3 orders | 199 + 198 + 198 pence |
| 13 | Child user with one company | sees only permitted groups |

- The suite also has a property test: the shares always sum to the label cost.
- The marker scan (AT-9) proves that no match key or name reaches db-main or the queue.

## C4. Order profit card: ex VAT and inc VAT (PRF-6)

**Layout:** one card, with a table of 3 money columns (**Ex VAT · VAT · Inc VAT**) and these rows:

| Row | Ex VAT | VAT | Inc VAT |
|---|---|---|---|
| Sales (paid by buyer, less refunds) | net | output VAT | gross |
| Channel fees | net of fee VAT | reclaimable fee VAT | gross |
| Label cost | table cost | label VAT | gross |
| Cost of goods (snapshot) | COGS | purchase VAT | gross |
| **Profit** | **contribution profit (PRF-2)** | **net VAT** | **cash before VAT settlement** |

- **Under the table:** a margin line, "28% of sales after VAT". Then the note: "Profit is the ex VAT figure. Inc VAT is the cash before you settle VAT with HMRC; the difference is the net VAT of £2.70."
- **Which figures are estimates:** any figure built on estimated fees carries the Estimate marker (PRF-5).
- **Rules:**
  - COGS is entered **ex VAT** (CAT-4). Its purchase VAT rate follows the SKU's VAT type unless the SKU sets a different purchase VAT rate.
  - The label cost table holds **ex VAT** prices plus a VAT rate per service, default 20% (SHP-7).
  - Each VAT figure is rounded half-up once per row.
  - Profit (Inc VAT) = Profit (Ex VAT) + net VAT, exactly. This is a test.
  - If the channel account uses `marketplace_accounts_for_vat` (FIN-5), sales VAT is 0 and the note says so.
- **Mock numbers (current preview order):**

| Row | Ex VAT | VAT | Inc VAT |
|---|---|---|---|
| Sales | 47.47 | 9.50 | 56.97 |
| Fees | −8.72 | −1.74 | −10.46 |
| Label | −5.95 | −1.19 | −7.14 |
| COGS | −19.37 | −3.87 | −23.24 |
| **Profit** | **13.43** | **2.70** | **16.13** |

## C5. Amazon seller feedback on Account Health (HLT-6, HLT-7)

### HLT-6: feedback section on each Amazon account card

- **Star rating:** the average of the last 12 months, for example "4.8 out of 5", drawn as 5 stars with partial fill.
- **Count:** the number of ratings, for example "based on 214 ratings".
- **Breakdown table** for 30 days, 90 days and 12 months:
  - Positive (4–5 stars)
  - Neutral (3)
  - Negative (1–2)
  - each shown as a count and a %
- **Recent feedback:** the 5 newest, each with:
  - stars, date and comment
  - the order ref, linked
  - a "Negative" or "Neutral" marker where it applies
- **"View all":** opens the Amazon feedback list in Customer Service (CS-4).
- **Data:** CS-4's daily `GET_SELLER_FEEDBACK_DATA` report. Data age is shown (HLT-5).
- **Buyer email:** the report's rater email is **discarded at parse time**, never stored.
- **No reply:** there is no reply API, so the screen says "Reply or ask for removal in Seller Central".
- **eBay:** eBay feedback stays on eBay's own screen and in Customer Service. It is never side by side with Amazon's (HLT-3).

### HLT-7 (SHOULD): recovery estimate

On a metric that is amber or red, a line such as: "3 late shipments leave the 30-day window by 16/11/2026. With no new late shipments, Late Shipment Rate falls under 4% on 16/11/2026."

- **Source:** OmniBridge's own merchant-fulfilled orders only (ship-by vs dispatched).
- **Label:** marked **Estimate**, because Amazon's own figure wins.
- **Scope:** Amazon only.

**The client's FBA note:** sending cheap items to FBA to add many on-time orders is a sales tactic outside OmniBridge, so nothing is built for it. FBA orders already show read-only (INV-9). Note that Amazon's Late Shipment Rate and Valid Tracking Rate count merchant-fulfilled orders only, so FBA volume mainly dilutes the Order Defect Rate. Orders must be from real, unconnected buyers: seller-funded or incentivised orders break Amazon's rules. HLT-7 is the part that helps the client inside the product: it shows when a bad rate will recover on its own.

## C6. Amazon buyer messages, read and reply (CS-6)

### How it works

The SP-API Messaging API is send-only, which is why PRD v1.3 parked this. Helpdesk tools such as eDesk do it through **Amazon's buyer–seller email relay**, which is allowed and involves no scraping:

1. **Inbound.** In Seller Central → Settings → Notification preferences → Messaging, the seller adds an OmniBridge address under **Buyer Messages**. Amazon then copies every buyer message to it.
   - The sender is an anonymised `…@marketplace.amazon.co.uk` relay address.
   - Each Amazon channel account gets its own address: `amazon-msg+<token>@omnibridge.co.uk`, where the token is 128 random bits.
2. **Outbound.** The seller adds `amazon-msg@omnibridge.co.uk` as an **approved sender** on the Messaging Permissions page.
   - Replies are emailed **from** that address **to** the buyer's relay address.
   - Amazon rewrites the sender and passes the reply on, and the buyer's next message comes back through step 1.
   - Only existing threads can be answered. OmniBridge never starts a conversation.
3. **Connections screen:** shows the account's inbound address, both setup steps and a "Send test" check.

### Design (keep exactly)

- **Mailbox:** one Zoho Mail mailbox, `amazon-msg@omnibridge.co.uk` (Zoho EU, the MAIL-1 provider). Plus-addressing routes mail per account.
  - Using Zoho for both directions keeps buyer content with a single processor.
  - The privacy policy and the sub-processor list name Zoho for this purpose.
- **Polling:** a worker job polls the mailbox over IMAP every 2 minutes, in `packages/providers/zoho-mail` (invariant 15), with a governor.
- **Ingest steps, for each email:**
  1. **Checks.** It must have DKIM pass for `amazon.co.uk` or `marketplace.amazon.co.uk`, a sender on the relay domain, a known token, and the token's account still connected.
  2. If the email names an order ID, that order must belong to the token's channel account. Otherwise the email is quarantined and an alert is raised; it never crosses to another workspace.
  3. The parsed message (sender relay address, subject, plain-text body, attachments) goes straight into **pii-vault** under that workspace. Attachments are scanned by clamd, limited to 10 MB, and stored in the vault volume.
  4. db-main gets only metadata: conversation ID, channel account, order ref, received time, state and `pii_ref`.
  5. The email is then **expunged from Zoho**, and nothing is kept in Sent.
  6. Emails that fail the checks are expunged too and only counted. Their content is never logged.
- **No PII in the queue (7a):** the poll job carries no PII. The mailbox is read inside the job and written to the vault directly.
- **Reply:**
  - The web handler stores the reply text in the vault and queues a job holding only the `pii_ref`.
  - The worker reads it (`read-full`, logged) and sends it over **Zoho SMTP** with DKIM for `omnibridge.co.uk`, to the relay address only. Any other recipient domain is refused in code.
  - The reply is plain text, at most 4,000 characters. Links are blocked except for the seller's own domain, following Amazon's communication guidelines.
- **Invariant 7 exception (ADR-055):** buyer-message replies are the only email that may carry buyer content, sent only to the Amazon relay domain. The AT-9 scan treats mail to the mock relay domain as allowed and fails on any other.
- **Retention:** message content is deleted 30 days after the conversation's last activity, as for eBay (CS-2). Metadata is kept.
- **Screen:** Customer Service → **Amazon messages**, one inbox per Amazon account, kept separate from eBay.
  - conversation list with unread counts
  - thread view
  - plain-text reply
  - mark read, unread and done
  - order link
  - a "Reply due" timer: Amazon expects a reply within 24 hours
- **To be confirmed in testing (verify-live):**
  - Seller Central accepts a plus address under Buyer Messages. Fallback: a Zoho alias per account.
  - The relay's DKIM domain.
  - That attachments are relayed.
- **New dependencies (ADR-055):** `imapflow` 1.x (MIT, IMAP client) and `mailparser` 3.x (MIT). They are added in the M18 task.
- **Security:** S5 checks the ingest path before it goes live. Inbound email is untrusted input.

## C7. Manual stock allocation per listing (INV-10)

**Goal:** the seller can stop automatic stock sync for a product and type the quantity each Amazon account, eBay account and the website should show. For example, they can give more to the account that sells best. Switching back to Auto must re-sync everything correctly, and allocation must never let the seller sell stock they do not have.

### C7.1 Model

- **What stays the same:** master stock does not change. On hand, reserved and available are still moved by every order, stock-in and adjustment (INV-1, INV-3). Manual mode changes only **what quantity is sent to a listing**.
- **Per listing (channel account + external SKU):**
  - `stock_mode`: `auto` (default) or `manual`
  - `manual_qty`: the number the user typed
  - `manual_sold`: units sold on that listing since `manual_qty` was set
  - `manual_set_at`, `manual_set_by`
- **The quantity sent to a listing (its target)**, which replaces the INV-2 formula:

| Mode | Target |
|---|---|
| auto | `max(0, available − buffer)` (as today) |
| manual | `max(0, min(manual_qty − manual_sold, available − buffer))` |

  For bundles, both are divided by the pack size and floored.

  **The `min` is the safety rule:** a manual number can limit a channel, but it can never show more than the stock you actually have. If stock runs short, the listing is capped at what is available and shows a "Capped by stock" badge.
- **Orders:**
  - An order on a manual listing reserves master stock as usual and adds its quantity to `manual_sold`.
  - A cancellation subtracts it again, but never below 0.
  - The channel counts down its own quantity when it sells, so normally no write is needed.
- **Writes:**
  - After any event, the target of each affected listing is recomputed. A write is queued **only if the target differs from the last quantity sent** (this also respects eBay's revision limit, EBAY-9).
  - Kill switch, maintenance, governors and revision holds all apply unchanged.
  - Auto listings on other channels still follow `available − buffer` as before.
- **Reconciliation (INV-7):** compares every listing with its own target, auto or manual. Drift is corrected the same way. Listings with an order in the last 15 minutes are skipped until the next run.

### C7.2 Turning it on and off

- **Product level:** on the Master SKU page, under **Stock sync: Auto / Manual**.
  - Switching to Manual puts every merchant-fulfilled listing of that SKU into manual mode.
  - Each listing's starting `manual_qty` is the quantity it shows now, so nothing changes on the channels at the moment of switching.
  - The user then edits the numbers per listing (Amazon accounts, eBay accounts, website) and saves once.
  - Setting 0 stops selling on that listing.
- **Listing level:** a single listing can be switched on its own, and the product then shows **Mixed**.
- **Save rules:**
  - **Locking:** the save is one transaction with a version check, so if stock or the settings changed while the user was typing, they are asked to review again.
  - **Audit:** every mode change and every number goes to the audit log and to the stock change log (INV-5), with user and time.
  - **Who:** users with the Stock tab who may adjust stock.
- **Allocation summary:** the form shows "Allocated 240 · Available 186". When allocated is more than available, it shows a plain warning: "More allocated than you have. Listings will be capped by stock." The save is still allowed: auto mode already shows the full stock on every channel, so this is no worse.
- **Back to Auto** (product or listing level):
  - The manual fields are cleared, the target becomes `available − buffer`, and one write per listing is queued right away.
  - The screen shows each push result (sent, held by eBay limit, failed), so the user can see everything re-synced.
- **Allocation used up:** when `manual_qty − manual_sold` reaches 0, the listing shows 0 and an informational notification is sent: "eBay kestrel-home: manual allocation used up for BB-BAM-M100". It stays manual until the user tops it up or switches back to Auto.

### C7.3 Edge cases (each has a test)

| Case | Rule |
|---|---|
| FBA listing | Cannot be manual. Its control is disabled with "Fulfilled by Amazon". |
| Unmapped listing | No stock writes at all (CAT-5), so no control. |
| Listing remapped to another SKU | Its mode resets to Auto, with a notice. |
| Bundle listing of a manual component | It has its own mode. The product switch offers to include the bundle listings. |
| Stock-in while manual | Manual targets rise only up to `manual_qty − manual_sold`; auto listings get the new stock. |
| Order arrives while the user is editing | The version check catches it. |
| Channel disconnected or listing ended | Its manual settings are deleted with the listing. |
| Buffer changed | The cap uses the new buffer. |
| Oversold (INV-6) | Unchanged: it is driven by master available. |
| Website | Same rules. The website connector receives the target quantity. |
| eBay revision hold | The write waits as today, and the listing shows its badge. |

**AT-27:**

1. Product with available 186 and listings A, B and C. Set A to 120 and B to 10, and leave C on Auto.
2. Sell 5 on B. Expect: B = 5, A = 120, C follows available 181.
3. Set available to 50 by adjustment. Expect: A is capped to 50 with the badge.
4. Switch back to Auto. Expect: all three get `max(0, available − buffer)` within 2 minutes (staging, no throttling).
