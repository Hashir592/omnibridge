/**
 * Job envelope, policies and scheduler helpers. Filled in by T-0104.
 *
 * T-0101 adds only the platform heartbeat queue, which proves the worker, pg-boss and db-main
 * are wired together.
 */
export const PACKAGE_NAME = '@omnibridge/queue';

/** pg-boss schema in db-main (ADR-009). Installed by the migrate job as ob_owner. */
export const QUEUE_SCHEMA = 'pgboss';

/** Platform heartbeat: no workspace, runs every minute, proves the worker is consuming jobs. */
export const HEARTBEAT_QUEUE = 'platform-heartbeat';
export const HEARTBEAT_CRON = '* * * * *';
