# Restore runbook (T-0405)

**Goal:** bring db-main and db-pii back from backup without bringing any deleted PII back (DEL-2, AT-8). Targets: RPO 24 h, RTO 8 h (CAP-10).

**The rule:** deletions are re-applied to the restored PII store **before any app starts**. Nothing may read the restored data until step 5 has run.

## Before you start

- Stop every app that touches the databases (web, worker, pii-vault, cron jobs):

  ```bash
  docker compose -p omnibridge -f infra/compose/compose.yaml stop web worker pii-vault
  ```

  Leave db-main and db-pii running.

- Have the restic passwords to hand (secrets register), and the B2 keys in production.
- Write down the time: it goes in the incident log.

## Steps

1. **Pick the snapshots.** List them for each repository:

   ```bash
   source infra/backup/lib.sh; restic_run main snapshots; restic_run pii snapshots
   ```

   Take the newest good one from each. They may differ in age; step 5 corrects that.

2. **Keep a copy of the current tombstones first.** Export db-main's `app.pii_tombstones` and db-pii's `vault.tombstones` while the live databases still exist. Use the `COPY … TO STDOUT` commands from `restore-drill.sh`. This matters most if the live data is damaged rather than lost.

3. **Restore db-main.** `source infra/backup/lib.sh` first, then:

   ```bash
   "${COMPOSE[@]}" exec -T db-main psql -U postgres -d postgres -c "DROP DATABASE omnibridge WITH (FORCE)" -c "CREATE DATABASE omnibridge"
   ```

   ```bash
   restic_run main dump --tag db-main <snapshot-id> /db-main.dump | "${COMPOSE[@]}" exec -T db-main pg_restore -U postgres -d omnibridge --exit-on-error
   ```

4. **Restore db-pii** the same way, with `db-pii`, the `pii` repository (tag `db-pii`, file `/db-pii.dump`) and the database `omnibridge_pii`.

   Then bring both restored databases to the running release's schema, before step 5 (a copy from before the last migration makes the replay fail loudly). Keep the apps stopped:

   ```bash
   "${COMPOSE[@]}" run --rm migrate-main
   ```

   ```bash
   "${COMPOSE[@]}" run --rm migrate-pii
   ```

5. **Re-apply every deletion to db-pii.** Load all three sources into the replay, exactly as `restore-drill.sh` does, then run `infra/backup/apply-tombstones.sql` as the superuser:
   - db-main's `app.pii_tombstones` (from step 3, plus the export from step 2)
   - the off-site journal (`journal_restore <dir>` from `lib.sh`: the latest 15-minute run)
   - db-pii's own `vault.tombstones`

   The SQL does four things:
   - deletes every tombstoned ref
   - deletes everything of a closed workspace, and its keys
   - re-runs expiry (`delete_after` passed)
   - VACUUMs

   It is safe to run twice.

6. **Run the marker scan** (AT-9): `node scripts/lib/marker-scan.mjs <files>` over a plain dump of db-main and the logs. Any hit stops the restore: report it, do not start the apps.

7. **Start the apps** (pii-vault never before step 5 has run: a vault started first on a copy with no deleted-buyer key makes a new one, and the "entries without their key" count then wrongly says 0). Check the following:
   - `/healthz` on web and pii-vault
   - the next hourly `pii.expiry-sweep` runs
   - a deletion certificate (DEL-3) still lists the old runs

## Afterwards

- Record what you did in the incident log: snapshot ids, times, and the counts printed by step 5.
- **The deletion window (S5-20261118-01).** The journal leaves the host every 15 minutes (`journal.sh`), so after a host loss the deletions of the last 15 minutes before it may be missing from every source. Re-run them: in the deletion runs list (DEL-3), find every run started in the 15 minutes before the loss and request it again with the same trigger and scope. An eBay deletion notice answered in those 15 minutes leaves no entry, and eBay does not send it again: write the gap (from, to) in the incident log and tell the admin.
- **VACUUM residue (accepted, invariant 10).** VACUUM frees deleted rows but does not overwrite the disk pages or old WAL files that held them, so ciphertext can stay on disk until it is overwritten. It cannot be read without the workspace's key, and a closed workspace has none. Read DEL-2's "even with the highest database privilege" with this in mind.
- **Order re-read (ADR-083, built in M22; required before real data).** Keep the maintenance switch on after step 7. Rewind every order stream's cursor to the older snapshot's time less 1 hour, and let waiting orders whose ref has no vault record and no tombstone give up that ref. The next polls bring back corrected addresses and the buyers stored after the backup. Take maintenance off only when every order account has synced past the restore point. Orders lost with an older db-main snapshot come back the same way; a vault record left with no order is expired by the orphan sweep.

## The drill

`infra/backup/restore-drill.sh` does steps 3 to 6 into scratch databases on the running clusters and then drops them. It never touches the live data. Run it every quarter (AT-24), and after any change to the schema or the backup scripts. It fails if it takes over 10 minutes.
