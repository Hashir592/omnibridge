import { isUuid } from './ids.ts';
import type { TenantContext } from './tenant.ts';

/**
 * The notification centre (PRD section 6, T-0501). Any module raises a notification through the
 * `Notifier` with its own bound context (the request's or the job's transaction, ADR-069 A-002),
 * so the notification commits or rolls back with the work that caused it. One notification per
 * type and linked record, updated in place (NTF-5); `resolve` clears it when its condition clears
 * (NTF-1). Nothing in a notification is free text: the title comes from the type registry, and
 * params are IDs, counts and flags only, so no buyer PII can reach it (invariant 7).
 */

export const NOTIFICATION_SEVERITIES = ['critical', 'warning', 'info'] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

/** How reliable the signal is (PRD section 6). Some types have none ("n/a"). */
export const NOTIFICATION_SIGNALS = ['native', 'derived', 'estimate'] as const;
export type NotificationSignal = (typeof NOTIFICATION_SIGNALS)[number];

export const NOTIFICATION_STATES = ['unread', 'read', 'resolved'] as const;
export type NotificationState = (typeof NOTIFICATION_STATES)[number];

/** The app's tabs (the contract's TABS without `none`); a child sees a type only with its tab. */
export const NOTIFICATION_TABS = [
  'home',
  'orders',
  'shipping',
  'stock-catalogue',
  'customer-service',
  'account-health',
  'advertising',
  'sales-profit',
  'forecasting',
  'finance',
  'reminders',
  'notes',
  'connections',
  'users',
  'settings',
  'audit-log',
] as const;
export type NotificationTab = (typeof NOTIFICATION_TABS)[number];

export interface NotificationType {
  readonly code: string;
  /** Plain English, shown in the centre and in emails. Never takes values from the record. */
  readonly title: string;
  /** Allowed severities; the first is the default. */
  readonly severities: readonly NotificationSeverity[];
  /** Allowed signals; the first is the default. Empty: the type has no signal (n/a). */
  readonly signals: readonly NotificationSignal[];
  /** `platform`: no workspace, platform admins only (NTF-2). */
  readonly scope: 'workspace' | 'platform';
  /** The tab of the linked record (workspace types only). */
  readonly tab?: NotificationTab;
  /** Where it comes from in the PRD. */
  readonly source: string;
}

const t = (
  code: string,
  title: string,
  severities: readonly NotificationSeverity[],
  signals: readonly NotificationSignal[],
  where: NotificationTab | 'platform',
  source: string,
): NotificationType =>
  where === 'platform'
    ? { code, title, severities, signals, scope: 'platform', source }
    : { code, title, severities, signals, scope: 'workspace', tab: where, source };

/** The PRD section 6 types (T-0501). Other modules add their own here as they raise them. */
export const NOTIFICATION_TYPES: readonly NotificationType[] = [
  t(
    'channel.auth_lost',
    'Channel authorisation lost: reconnect needed',
    ['critical'],
    ['native', 'derived'],
    'connections',
    'AMZ-12, EBAY-5, EVRI-2',
  ),
  t(
    'channel.deletion_scheduled',
    'Data deletion scheduled for a disconnected account',
    ['critical'],
    ['derived'],
    'connections',
    'AMZ-13',
  ),
  t(
    'tracking.unconfirmed',
    'Tracking not confirmed within 4 hours',
    ['critical'],
    ['derived'],
    'shipping',
    'TRK-2',
  ),
  t(
    'health.status_changed',
    'Account status or seller level changed',
    ['critical'],
    ['native'],
    'account-health',
    'HLT-4',
  ),
  t(
    'health.band_changed',
    'Health metric changed band',
    ['warning'],
    ['native'],
    'account-health',
    'HLT-4',
  ),
  t('inventory.oversold', 'Oversold', ['critical'], ['derived'], 'stock-catalogue', 'INV-6'),
  t(
    'inventory.sync_failed',
    'Stock sync failed or drifted',
    ['warning'],
    ['derived'],
    'stock-catalogue',
    'INV-7, INV-8',
  ),
  t(
    'ebay.revision_hold',
    'eBay listing held by the revision limit',
    ['warning'],
    ['derived'],
    'stock-catalogue',
    'EBAY-9',
  ),
  t(
    'ebay.api_usage_high',
    'eBay API usage above 80%',
    ['warning'],
    ['derived'],
    'platform',
    'EBAY-8',
  ),
  t('forecast.low_stock', 'Low stock: reorder', ['info'], ['derived'], 'forecasting', 'FC-2'),
  t('cs.ebay_message', 'New eBay message', ['info'], ['native'], 'customer-service', 'CS-1'),
  t(
    'cs.negative_feedback',
    'Neutral or negative feedback',
    ['warning'],
    ['native'],
    'customer-service',
    'CS-3, CS-4',
  ),
  t(
    'orders.atoz_return',
    'Return with an A-to-z flag',
    ['warning'],
    ['native', 'estimate'],
    'orders',
    'ORD-7',
  ),
  t(
    'finance.bill_due',
    'Unpaid bill due or overdue',
    ['info', 'warning'],
    ['derived'],
    'finance',
    'EXP-5',
  ),
  t(
    'finance.recurring_created',
    'Recurring expense created',
    ['info'],
    ['derived'],
    'finance',
    'REC-2',
  ),
  t('ads.rule_changes', 'Ads rule run made changes', ['info'], ['derived'], 'advertising', 'AD-3'),
  t(
    'platform.report_failure',
    'Report or parser failure',
    ['warning'],
    ['derived'],
    'platform',
    'INT-5',
  ),
  t(
    'platform.amazon_secret_rotation',
    'Amazon client secret rotation due',
    ['critical'],
    ['derived'],
    'platform',
    'AMZ-10',
  ),
  t(
    'platform.amazon_auth_limit',
    'Amazon authorisations at 20 of 25',
    ['warning'],
    ['derived'],
    'platform',
    'AMZ-2',
  ),
  t(
    'users.access_review_due',
    'Quarterly access review due',
    ['info'],
    ['derived'],
    'users',
    'USR-9',
  ),
  t('reminders.due', 'Reminder due', ['info'], [], 'reminders', 'TOOL-1'),
];

const BY_CODE = new Map(NOTIFICATION_TYPES.map((x) => [x.code, x]));

/** The registered type, or undefined. */
export function notificationType(code: string): NotificationType | undefined {
  return BY_CODE.get(code);
}

/** The record a notification is about (NTF-1 "linked record"), by kind and ID. */
export interface NotificationRecord {
  /** e.g. `order`, `listing`, `channel_account`, `user`. */
  readonly kind: string;
  /** A UUID, or a short code such as a day or hour slot (`2026-11-19T10`). */
  readonly id: string;
}

/** IDs, counts and flags: no text, so no buyer PII can be put in a notification. */
export type NotificationParams = Readonly<Record<string, string | number | boolean>>;

export interface RaiseInput {
  readonly type: string;
  readonly record: NotificationRecord;
  /** Defaults to the type's first severity. */
  readonly severity?: NotificationSeverity;
  /** Defaults to the type's first signal. */
  readonly signal?: NotificationSignal;
  readonly companyId?: string;
  readonly channelAccountId?: string;
  /** Values must be UUIDs, finite numbers or booleans. */
  readonly params?: NotificationParams;
}

/** A raise, checked against the registry (`checkRaise`). */
export interface CheckedRaise {
  readonly type: NotificationType;
  readonly severity: NotificationSeverity;
  readonly signal: NotificationSignal | null;
  readonly record: NotificationRecord;
  readonly companyId: string | null;
  readonly channelAccountId: string | null;
  readonly params: NotificationParams;
}

/** What a raise did: whether it is new, rose in severity or reopened (then email, T-0502). */
export interface RaiseResult {
  readonly id: string;
  readonly version: number;
  readonly created: boolean;
  readonly escalated: boolean;
  readonly reopened: boolean;
}

export class InvalidNotification extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidNotification';
  }
}

const RECORD_KIND = /^[a-z][a-z0-9_]{0,39}$/;
const RECORD_ID = /^[0-9a-zA-Z:._-]{1,64}$/;
const SLOT_ID = /^\d{4}-\d{2}-\d{2}(T\d{2}(:\d{2})?)?$/;
const PARAM_KEY = /^[a-z][a-zA-Z0-9_]{0,39}$/;
const MAX_PARAMS = 20;

/**
 * Checks a raise against the registry and the no-text rule. A record id must be a UUID or a time
 * slot; a param value a UUID, a finite number or a boolean. Throws InvalidNotification.
 */
export function checkRaise(input: RaiseInput, scope: 'workspace' | 'platform'): CheckedRaise {
  const type = notificationType(input.type);
  if (type === undefined) throw new InvalidNotification(`Unknown notification type ${input.type}`);
  if (type.scope !== scope) {
    throw new InvalidNotification(`Notification type ${type.code} is ${type.scope}-level`);
  }
  const severity = input.severity ?? type.severities[0];
  if (severity === undefined || !type.severities.includes(severity)) {
    throw new InvalidNotification(`Type ${type.code} cannot be ${String(input.severity)}`);
  }
  let signal: NotificationSignal | null = null;
  if (type.signals.length > 0) {
    signal = input.signal ?? type.signals[0] ?? null;
    if (signal === null || !type.signals.includes(signal)) {
      throw new InvalidNotification(`Type ${type.code} has no ${String(input.signal)} signal`);
    }
  } else if (input.signal !== undefined) {
    throw new InvalidNotification(`Type ${type.code} has no signal`);
  }
  const { kind, id } = input.record;
  if (!RECORD_KIND.test(kind)) throw new InvalidNotification('Bad record kind');
  if (!RECORD_ID.test(id) || !(isUuid(id) || SLOT_ID.test(id))) {
    throw new InvalidNotification('A record id must be a UUID or a time slot');
  }
  for (const [name, value] of [
    ['companyId', input.companyId],
    ['channelAccountId', input.channelAccountId],
  ] as const) {
    if (value !== undefined && !isUuid(value)) throw new InvalidNotification(`Bad ${name}`);
  }
  if (scope === 'platform' && (input.companyId ?? input.channelAccountId) !== undefined) {
    throw new InvalidNotification('A platform notice has no company or channel account');
  }
  const params = input.params ?? {};
  const entries = Object.entries(params);
  if (entries.length > MAX_PARAMS) throw new InvalidNotification('Too many params');
  for (const [key, value] of entries) {
    if (!PARAM_KEY.test(key)) throw new InvalidNotification(`Bad param name ${key}`);
    const ok =
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && isUuid(value));
    if (!ok) throw new InvalidNotification(`Param ${key} must be a UUID, a number or a boolean`);
  }
  return {
    type,
    severity,
    signal,
    record: { kind, id },
    companyId: input.companyId ?? null,
    channelAccountId: input.channelAccountId ?? null,
    params: { ...params },
  };
}

/** Where notifications are kept (packages/db NotificationRepository). */
export interface NotificationStore {
  raise(ctx: TenantContext, raise: CheckedRaise, now: Date): Promise<RaiseResult>;
  resolve(
    ctx: TenantContext,
    type: string,
    record: NotificationRecord,
    now: Date,
  ): Promise<boolean>;
  /** With a context, inside its bound transaction; without one, in a statement of its own. */
  raisePlatform(ctx: TenantContext | null, raise: CheckedRaise, now: Date): Promise<RaiseResult>;
  resolvePlatform(
    ctx: TenantContext | null,
    type: string,
    record: NotificationRecord,
    now: Date,
  ): Promise<boolean>;
}

/**
 * Runs after a raise in the same bound context (T-0502 queues emails here). `ctx` is null only
 * for a platform notice raised outside any tenant transaction.
 */
export type RaiseHook = (
  ctx: TenantContext | null,
  raise: CheckedRaise,
  result: RaiseResult,
) => Promise<void>;

export interface NotifierOptions {
  store: NotificationStore;
  now?: () => Date;
  onRaised?: RaiseHook;
}

/** The one way to raise or resolve a notification (NTF-1, NTF-5). */
export class Notifier {
  readonly #store: NotificationStore;
  readonly #now: () => Date;
  readonly #onRaised: RaiseHook | undefined;

  constructor(options: NotifierOptions) {
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date());
    this.#onRaised = options.onRaised;
  }

  /**
   * Raises a workspace notification, or updates the open one for the same type and record. Pass
   * the caller's bound context, never a fresh one: the notification is part of that transaction.
   */
  async raise(ctx: TenantContext, input: RaiseInput): Promise<RaiseResult> {
    const checked = checkRaise(input, 'workspace');
    const result = await this.#store.raise(ctx, checked, this.#now());
    await this.#onRaised?.(ctx, checked, result);
    return result;
  }

  /** Marks it resolved when its condition has cleared (NTF-1); false when none was open. */
  async resolve(ctx: TenantContext, type: string, record: NotificationRecord): Promise<boolean> {
    if (notificationType(type)?.scope !== 'workspace') {
      throw new InvalidNotification(`Unknown workspace notification type ${type}`);
    }
    return this.#store.resolve(ctx, type, record, this.#now());
  }

  /**
   * A platform-level notice, for platform admins only (NTF-2). Pass the caller's bound context
   * when there is one, so the notice commits with its work; null runs it on its own.
   */
  async raisePlatform(ctx: TenantContext | null, input: RaiseInput): Promise<RaiseResult> {
    const checked = checkRaise(input, 'platform');
    const result = await this.#store.raisePlatform(ctx, checked, this.#now());
    await this.#onRaised?.(ctx, checked, result);
    return result;
  }

  async resolvePlatform(
    ctx: TenantContext | null,
    type: string,
    record: NotificationRecord,
  ): Promise<boolean> {
    if (notificationType(type)?.scope !== 'platform') {
      throw new InvalidNotification(`Unknown platform notification type ${type}`);
    }
    return this.#store.resolvePlatform(ctx, type, record, this.#now());
  }
}
