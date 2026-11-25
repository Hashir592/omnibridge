-- Re-applies every deletion to a restored db-pii (T-0405; DEL-2, AT-8, invariant 10, FA-21).
-- Runs as the cluster superuser (restore tooling only; it reads every workspace) BEFORE any app
-- starts on the restored data. The caller fills two temporary tables first:
--   replay_journal (line text)    every line of the off-site journal (tombstones-*.jsonl)
--   replay_main (workspace_id uuid, pii_ref uuid, run_id uuid, channel_account_id uuid,
--                deleted_at timestamptz)   db-main's app.pii_tombstones
-- and may SET restore.now (default now()) for the expiry re-run.
-- Safe to run more than once: a second run finds nothing to delete.

BEGIN;

CREATE TEMP TABLE replay_lines ON COMMIT DROP AS
  SELECT line::jsonb AS j FROM replay_journal WHERE btrim(line) <> '';

-- Every deleted ref the three sources know of: db-pii's own tombstones are already in place.
INSERT INTO vault.tombstones (workspace_id, pii_ref, run_id, deleted_at, channel_account_id)
SELECT DISTINCT ON (workspace_id, pii_ref) workspace_id, pii_ref, run_id, deleted_at, channel_account_id
  FROM (
    SELECT (j->>'workspace_id')::uuid AS workspace_id, (j->>'pii_ref')::uuid AS pii_ref,
           (j->>'run_id')::uuid AS run_id, (j->>'at')::timestamptz AS deleted_at,
           nullif(j->>'channel_account_id', '')::uuid AS channel_account_id
      FROM replay_lines WHERE j ? 'pii_ref' AND (j->>'type') IS DISTINCT FROM 'expiry'
    UNION ALL
    SELECT workspace_id, pii_ref, run_id, deleted_at, channel_account_id FROM replay_main
  ) AS t
ON CONFLICT DO NOTHING;

-- Workspaces closed after the backup was taken (ADR-065): closed again.
INSERT INTO vault.closed_workspaces (workspace_id, closed_at)
SELECT (j->>'workspace_id')::uuid, min((j->>'at')::timestamptz)
  FROM replay_lines WHERE j->>'type' = 'workspace_closed'
 GROUP BY 1
ON CONFLICT DO NOTHING;

-- Expiry changes made after the backup (ADR-068): each record takes its newest journalled
-- delete_after, so a restored copy never outlives the date the vault last set for it.
UPDATE vault.records r SET delete_after = e.delete_after
  FROM (SELECT DISTINCT ON (workspace_id, pii_ref)
               (j->>'workspace_id')::uuid AS workspace_id, (j->>'pii_ref')::uuid AS pii_ref,
               (j->>'delete_after')::timestamptz AS delete_after
          FROM replay_lines WHERE j->>'type' = 'expiry'
         ORDER BY workspace_id, pii_ref, (j->>'at')::timestamptz DESC) AS e
 WHERE r.workspace_id = e.workspace_id AND r.pii_ref = e.pii_ref AND NOT r.canary
   AND r.delete_after IS DISTINCT FROM e.delete_after;

-- eBay deletion notices that arrived after the backup (T-1003): their entries come back, each with
-- its newest dates; lines past the 180 days the vault keeps an entry are left out.
INSERT INTO vault.ebay_deleted_buyers AS d (key_version, field, mac, noticed_at, received_at)
SELECT (j->>'key_version')::bigint, j->>'field', decode(j->>'mac', 'hex'),
       max((j->>'noticed_at')::timestamptz), max((j->>'at')::timestamptz)
  FROM replay_lines
 WHERE j->>'type' = 'ebay_deleted'
   AND (j->>'at')::timestamptz >= coalesce(nullif(current_setting('restore.now', true), '')::timestamptz,
                                           now()) - interval '180 days'
 GROUP BY 1, 2, 3
ON CONFLICT (key_version, field, mac) DO UPDATE
  SET noticed_at = greatest(d.noticed_at, excluded.noticed_at),
      received_at = greatest(d.received_at, excluded.received_at);

-- What must not survive: a tombstoned ref, anything of a closed workspace, anything past its
-- delete_after (the expiry job re-run, FA-21).
CREATE TEMP TABLE doomed ON COMMIT DROP AS
  SELECT r.workspace_id, r.pii_ref, r.channel_account_id,
         EXISTS (SELECT 1 FROM vault.tombstones t
                  WHERE t.workspace_id = r.workspace_id AND t.pii_ref = r.pii_ref) AS tombstoned
    FROM vault.records r
   WHERE EXISTS (SELECT 1 FROM vault.tombstones t
                  WHERE t.workspace_id = r.workspace_id AND t.pii_ref = r.pii_ref)
      OR r.workspace_id IN (SELECT workspace_id FROM vault.closed_workspaces)
      OR r.delete_after <= coalesce(nullif(current_setting('restore.now', true), '')::timestamptz,
                                    now());

DELETE FROM vault.record_fields f USING doomed d
 WHERE f.workspace_id = d.workspace_id AND f.pii_ref = d.pii_ref;
DELETE FROM vault.blind_index b USING doomed d
 WHERE b.workspace_id = d.workspace_id AND b.pii_ref = d.pii_ref;
DELETE FROM vault.records r USING doomed d
 WHERE r.workspace_id = d.workspace_id AND r.pii_ref = d.pii_ref;

-- Records removed here for closure or expiry are tombstoned too, under one restore run id.
INSERT INTO vault.tombstones (workspace_id, pii_ref, run_id, deleted_at, channel_account_id)
SELECT d.workspace_id, d.pii_ref, run.id, now(), d.channel_account_id
  FROM doomed d CROSS JOIN (SELECT gen_random_uuid() AS id) AS run
 WHERE NOT d.tombstoned
ON CONFLICT DO NOTHING;

-- A closed workspace keeps no key, so nothing it held can be opened again.
DELETE FROM vault.workspace_keys
 WHERE workspace_id IN (SELECT workspace_id FROM vault.closed_workspaces);
DELETE FROM vault.workspace_directory
 WHERE workspace_id IN (SELECT workspace_id FROM vault.closed_workspaces);

SELECT count(*) AS records_deleted FROM doomed;
-- Entries whose key is not in this backup match nothing: 0 unless the key was made after it.
SELECT count(*) AS ebay_entries_without_key FROM vault.ebay_deleted_buyers d
 WHERE NOT EXISTS (SELECT 1 FROM vault.vault_keys k
                    WHERE k.kind = 'deleted_buyers' AND k.version = d.key_version);

COMMIT;

-- Outside the transaction: VACUUM cannot run inside one (invariant 10).
VACUUM vault.record_fields, vault.blind_index, vault.records;
