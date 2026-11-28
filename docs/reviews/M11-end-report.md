# M11 end report (S3, 28 Nov 2026)

M11 is one task, T-1101 (risk high, no "go" needed), plus its contract PR. S4 reviews M11 with M12 (S1's M11 paste: no S4 block for T-1101 alone).

- #175: the contract (website setup, inbound and outbound shapes, Disconnect), merged; the S2 block for T-0319 was printed.
- T-1101: branch `task/T-1101-website-connector`, one PR with auto-merge.

## Tasks

| Task | What | IDs |
|---|---|---|
| T-1101 first commits | F-M10-end-14, -17 and S5-20261124-07 (one bad order never stops an account); PS-037 (2) and (3) as ADR-086 rules them; F-25, F-26 and F-27 as ADR-087 rules them | ORD-4, INT-5, DEL-1, FIN-1, ORD-9 |
| T-1101 connector | Setup, signing both ways, inbound push, cancel, refunds, products, outbound stock and shipment with retries and dead letters, nightly reconciliation, Disconnect, the shared call session | WEB-1 to WEB-6, OPS-12, AT-14 |

## How it was built

**First commits.** Both order parsers read each order on its own (`parseEach` in the provider kit): an order ID over 163 characters, a non-GBP order, one with no lines or one that cannot be read is set aside. Free text is cut to its limit and NUL removed. The rest of the page is stored and the cursor moves. One `orders.set_aside` notice per account carries the counts by reason, with IDs only; an unreadable order also raises the platform report. A masked delivery instruction keeps the stored one, and a star never refuses an address (PS-037 (2)). A deletion that tombstones a grouped order queues its account's recompute (PS-037 (3)). An update with no lines uses the stored lines, paid or not (F-25). The vault's name re-index runs once, behind a done marker in db-pii, in batches of 200 with short transactions (F-26). F-27's guards were each planted with their fault by hand and caught it.

**Setup (WEB-1).** An admin connects a website under a company of their own and copies the inbound key and the signing secret once. OmniBridge keeps a SHA-256 of the key (with a 4-character hint) and the secret encrypted like every credential. The website's own key and base URL (HTTPS only) can change, and new keys replace the old at once; each change is audited. The account is created with `holdStockPush: true`. A route behind the `website_connector` module answers 404 while it is off, enforced in the contract registry for every such route (ADR-059), and the web app now wires the module reader.

**Signing and inbound (WEB-2, WEB-3, OPS-12).** Inbound calls run before any tenant context, so a definer function (`app.website_inbound`) gives the connection's workspace, company, key hash and module state, for a website account that is not archived. The verifier checks the key in constant time, a timestamp within 5 minutes and the HMAC of `<timestamp>.<raw body>` (the raw body is kept for it), and logs only which check failed. Validation errors answer 422. One helper (`once`) gives every call its Idempotency-Key handling: a kept answer is replayed before any work, another body under the same key is 409, and the work runs in one transaction under the key's advisory lock, which checks again before it stores. The push runs the worker's own vault-first step with no transaction open, then `OrderIngest.apply`, so the newer-block rule (-11) holds for pushes; that step moved unchanged into `packages/order-ingest` (PS-038). A cancel and a refund rebuild the stored order as an update that changes nothing else and go through `apply`, so the state table, stock release, VAT and the buyer deletion follow the eBay rules; a refund ID already recorded is 200, and a refund on an unpaid order is 422. Products become the account's listings by SKU, send CAT-6's event on an exact-code match, and are reconciled (PS-039).

**Outbound (WEB-4, WEB-5, WEB-6).** The website adapter speaks the M11 protocol: `PUT /omnibridge/stock` (100 SKUs at most), `POST /omnibridge/orders/{id}/shipment` and `GET /omnibridge/orders?updatedSince=`, each signed with the shared secret and the website's key, with the write's id as the Idempotency-Key on every attempt. db-main assembles the website's credential (key, secret, base URL). Outside mock mode a website is called only over HTTPS at a dotted public name (PS-039). Writes go through the M07 send path, which now lets an operation set its own limits: a website write backs off from 1 minute up to 24 hours over 13 attempts, then stays failed with its code (the dead letter) and raises one `website.delivery_failed` alert on its account; the next write sent clears it. A write is refused before any send when its account or operation is of another provider, so nothing of eBay can go to a website. `website.shipment` is ready for M12 to queue.

**Reconciliation.** Website accounts are read once a night from 02:00 London time (keyed by the London day), through the same stream, set-aside rules and vault-first step as the push. eBay stays on its 5-minute polls.

**Disconnect.** One transaction: the account is archived (syncs, outbound writes and the website's own calls stop), its listings end and their manual stock settings clear (C7.3), every credential is deleted, and `connection.removed` is audited once. Orders, stock history and VAT records stay. A repeat ends nothing.

**Shared call session (ADR-079 2).** `callSession` in the provider kit holds the token, governor, one-401-renewal, usage and health code that `runIncrementalSync` and `runListingScan` repeated; no behaviour changed.

## Decisions made (full list in the PR)

- Website validation errors answer 422 (route config `contract.validationStatus`), other routes keep 400.
- A missing or over-long Idempotency-Key is 400.
- A website cancel goes through the state table like a poll: a dispatched order stays dispatched.
- A refund on an order with no payment is 422, as ingest books refunds on paid orders only.
- The provisional website parser tests (M10) are replaced by the M11 protocol tests; the worker's order cases keep their meaning through one translation helper.
- The route walker now runs the real website handlers against a website account of B. It found a bug: with only website signing set up, an eBay webhook answered 412 instead of 401; a route whose sender is not set up now answers 401.

## Risks and follow-ups

- PS-038 (the new package in ARCHITECTURE) and PS-039 (website listings by push; where a website may be called) wait for S1.
- `website.shipment` has no caller until M12 queues one when a website order ships (TRK-1).
- The website mock checks the signature's form only (it holds no secret); real signatures are checked both ways in the web and provider tests.
- A dead-lettered website write is visible as a failed outbound write and its alert; there is no screen to send one again yet.
- If JeezMart is reached over an internal name in production, M22 adds it as a configured egress exception (OPS-12).

## Test evidence

- Red first, each its own commit: the first commits (824e3d0, 1f6fa31), setup (21e764f), signed and idempotent calls (94c9920), cancel, refund, products and Disconnect (02d72b1), website delivery retries, dead letters and the provider check (outbound kit tests).
- Guards planted by hand on the guard alone (ADR-085): F-27's four.
- On the final code: `verify --quick`, depcruise, names, coverage, squawk, and the integration suites the task touches (web website, inbound and isolation; worker orders, stock, outbound, discovery, sync and scan; db orders, groups, stock and website; vault), plus the mocks contract test.
