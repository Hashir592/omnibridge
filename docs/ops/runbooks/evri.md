# Evri runbook (EVRI-1 to EVRI-7, T-1201)

OmniBridge buys Evri labels through the Evri Business Accounts API (myHermes API, specification v1.4). The specification is copyright and is not kept in this repository.

## Before go-live

1. **Account type.** The client's Evri account must be a live **credit** account. All Evri APIs need one.
2. **App credentials.**
   - Evri gives every Business Account integrator the same client ID and client secret, in its API documents.
   - A platform admin enters them in the console as `evri.client_id` and `evri.client_secret` (`docs/ops/secrets-register.md`).
   - They are never written in the repo, a ticket, a log or chat.
3. **Redirect address (optional).** Evri sends the browser to its example address `https://localhost:8080` after sign-in.
   - The page there shows an error, but the code is in the address bar.
   - To send admins back to OmniBridge instead, email **evriclientdesk@evri.com** with the address, then set `EVRI_REDIRECT_URI` on web.
4. **Fixed IP (SHIP-2).** Carrier calls leave from the production server's fixed IPv4 address. Ask Evri to allowlist it if they require that.
5. **Test environment.** Evri has a test environment (SIT), but its host is not in the documents.
   - Until the client provides it, OmniBridge calls only `api.myhermes.co.uk`.
   - Development and CI call only the mock.

## Connecting an account (EVRI-2)

1. Go to Connections → Carriers → Connect Evri and open the Evri sign-in link.
2. Sign in to Evri. The browser lands on a page that may show an error.
3. Copy the code after `code=` in the address bar. It looks like `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`, works **once**, and only within **72 hours**.
4. Paste the code into OmniBridge. The server exchanges it for an access token and stores the token encrypted.

## "Needs re-authorisation"

Evri gives no token lifetime and has no refresh. When Evri answers 401:

- the account is marked **Needs re-authorisation**;
- admins get the `channel.auth_lost` notice;
- labels for it are refused with `evri.unauthorised`.

To fix it, open the account, get a new code (steps 1 to 3 above), and paste it into Re-authorise. The notice clears.

## Labels

- **Bought once per parcel.** Each parcel's client UID is `{orderRef}-{parcelNo}` and is unique. If Evri's answer is lost, the retry gets "duplicate" (400), and the parcel is listed as **unknown** on the reconcile list.
  - Look it up in Evri's **My Shipments** by its client UID before relabelling. Evri has no API to look it up.
- **Void.** Evri has no void. Voiding in OmniBridge returns the orders to Awaiting dispatch and lists the label to reconcile. Cancel or ignore it in Evri's own account, then mark it reconciled.
- **Reprint.** A reprint fetches the existing label by barcode. It never buys a new one. A 403 from Evri means the label can no longer be printed, for example because the parcel was delivered.
- **Data sent.** The parcel carries the buyer's name, address lines, postcode and delivery instructions, plus the email and phone for Evri's delivery messages (ADR-089).
  - An email over 80 characters or a phone over 32 is left out.
  - Address lines are fitted to 32 characters. An address that had to be shortened needs a user's yes first (EVRI-4).

## Contacts (EVRI-7)

| Who | When | Send |
|---|---|---|
| IT.integration@evri.com | API errors | The full request and response (remove the buyer's details) and screenshots of the error. Screenshots are mandatory. |
| evriclientdesk@evri.com | Allowlisting the redirect address | The address to allowlist. |
