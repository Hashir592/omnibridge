# Mailboxes and email DNS (MAIL-1, MAIL-2)

For Hashir. Mail for `omnibridge.co.uk` is hosted by **Zoho Mail Lite with 2 paid users** (P-009). System email (invitations, password resets, alerts) is sent through **Scaleway Transactional Email** (ADR-020). No mail server runs on the app server.

## 1. Zoho users and aliases

| Paid user | Aliases on it | Who reads it |
|---|---|---|
| Client | `support@`, `privacy@` | The client (public contacts on the site) |
| Developer | `developer@`, `security@`, `notifications@` | The dev team, **daily**: Amazon closes a case after 5 days without a reply |

- `developer@`: the administrator email on the Amazon and eBay developer accounts.
- `notifications@`: the sender of system email. Replies to it land in the developer's mailbox.
- Aliases are free. Do not add a third paid user or any other paid email service (MAIL-1).

Steps:
1. Sign up for Zoho Mail Lite on the **EU data centre** (zoho.eu) with 2 users, then verify the domain with the TXT record Zoho shows.
2. Add the aliases above to the two users.
3. Turn on two-factor sign-in for both users.

## 2. DNS records at GoDaddy (WWW-1: DNS stays at GoDaddy)

Copy the exact values from the Zoho and Scaleway consoles: the DKIM keys are generated for this domain. The table shows the shape.

| Type | Name | Value | Notes |
|---|---|---|---|
| TXT | `@` | `zoho-verification=…` | domain verification (from Zoho) |
| MX | `@` | `mx.zoho.eu` priority 10 | |
| MX | `@` | `mx2.zoho.eu` priority 20 | |
| MX | `@` | `mx3.zoho.eu` priority 50 | |
| TXT | `@` | `v=spf1 include:zohomail.eu include:_spf.tem.scaleway.com -all` | **one** SPF record for both senders |
| TXT | `zmail._domainkey` | `v=DKIM1; k=rsa; p=…` | Zoho DKIM (selector as Zoho shows it) |
| TXT | `<selector>._domainkey` | `v=DKIM1; …` | Scaleway TEM DKIM (as Scaleway shows it) |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:developer@omnibridge.co.uk` | start at `p=none`; move to `p=quarantine` after 2 clean weeks of reports |

## 3. Scaleway Transactional Email (MAIL-2)

1. Create the project in the **fr-par** region and add the domain `omnibridge.co.uk`.
2. Add Scaleway's SPF include (in the record above) and its DKIM record, then wait for Scaleway to show the domain as verified.
3. Create SMTP credentials and store them in the production secrets (ops repo, SOPS). They never go into this repo (see `secrets-register.md`).
4. The sender is `notifications@omnibridge.co.uk`. The free tier is 300 emails a month; password reset mail is capped in the app (F-M02h-05).

## 4. Amazon buyer–seller email relay (CS-6, Release 1)

Each Amazon account gets its own inbound address on `omnibridge.co.uk` for Amazon's buyer–seller relay. The design is in `docs/plan/client-changes-20261112.md` (C6). The addresses are set up when that module is built; nothing is needed now.

## 5. Check

- Send a test mail from each alias to an outside mailbox, and check that SPF, DKIM and DMARC show `pass` in the message headers.
- Check that a mail sent to `support@` arrives in the client's inbox.
