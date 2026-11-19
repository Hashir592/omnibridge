import {
  NOTIFICATION_SEVERITIES,
  NOTIFICATION_SIGNALS,
  NOTIFICATION_STATES,
} from '@omnibridge/core';
import { z } from 'zod';
import { listQuery, pageOf } from '../pagination.ts';
import { defineRoute } from '../route.ts';

/**
 * The notification centre (T-0501: NTF-1, NTF-2, NTF-5). PROPOSED SHAPE for S2 (T-0312).
 *
 * A user sees the notifications of their workspace that they may see: an admin all of them, a
 * child those of a tab and company they have ticked (NTF-2, PERM-3). One notification per type
 * and linked record, updated in place (NTF-5). A notification never holds buyer PII: `title`
 * comes from the type, `params` are IDs, counts and flags (invariant 7).
 */

export const NotificationSchema = z
  .object({
    id: z.uuid(),
    /** The type code, e.g. `inventory.oversold`. */
    type: z.string(),
    /** Plain English for the type; the same for every notification of that type. */
    title: z.string(),
    severity: z.enum(NOTIFICATION_SEVERITIES),
    /** Native, derived or estimate; null when the type has none (reminders). */
    signal: z.enum(NOTIFICATION_SIGNALS).nullable(),
    /** The tab of the linked record; null for a platform notice. */
    tab: z.string().nullable(),
    companyId: z.uuid().nullable(),
    channelAccountId: z.uuid().nullable(),
    /** The linked record: its kind (`order`, `listing`, ...) and id (a UUID or a time slot). */
    record: z.object({ kind: z.string(), id: z.string() }),
    /** IDs, counts and flags only, by name; which names a type uses is set by the raising module. */
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    /** unread or read for this user; resolved once its condition cleared (for everyone). */
    state: z.enum(NOTIFICATION_STATES),
    createdAt: z.iso.datetime(),
    /** When it was last raised again (NTF-5); the list is newest change first. */
    updatedAt: z.iso.datetime(),
    resolvedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'Notification' });

export type Notification = z.infer<typeof NotificationSchema>;

const filters = {
  state: z.enum(NOTIFICATION_STATES).optional(),
  severity: z.enum(NOTIFICATION_SEVERITIES).optional(),
};

const UnreadCount = z.object({ unread: z.number().int().min(0) }).meta({ id: 'UnreadCount' });
const Marked = z.object({ marked: z.number().int().min(0) }).meta({ id: 'NotificationsMarked' });

// Every signed-in member has a bell, whatever they have ticked: tab none, filtered per row.
const bell = {
  auth: 'session',
  tab: 'none',
  adminOnly: false,
  companyScoped: true,
} as const;

/** The signed-in user's notifications, newest change first, with cursor paging. */
export const listNotifications = defineRoute({
  id: 'listNotifications',
  method: 'GET',
  path: '/notifications',
  summary: 'List my notifications',
  query: listQuery.extend(filters),
  responses: { 200: pageOf(NotificationSchema) },
  ...bell,
});

/** For the bell: open notifications this user has not read. */
export const countUnreadNotifications = defineRoute({
  id: 'countUnreadNotifications',
  method: 'GET',
  path: '/notifications/unread-count',
  summary: 'Count my unread notifications',
  responses: { 200: UnreadCount },
  ...bell,
});

/** 404 when it does not exist or this user may not see it. */
export const markNotificationRead = defineRoute({
  id: 'markNotificationRead',
  method: 'POST',
  path: '/notifications/:id/read',
  summary: 'Mark one notification read',
  params: z.object({ id: z.uuid() }),
  responses: { 200: Marked },
  ...bell,
});

/** Every open notification this user can see. */
export const markAllNotificationsRead = defineRoute({
  id: 'markAllNotificationsRead',
  method: 'POST',
  path: '/notifications/read-all',
  summary: 'Mark all my notifications read',
  responses: { 200: Marked },
  ...bell,
});

const platformConsole = {
  auth: 'platform',
  tab: 'none',
  adminOnly: false,
  companyScoped: false,
} as const;

/** Platform-level notices (NTF-2): platform admins only, in the console. Same shape. */
export const listPlatformNotifications = defineRoute({
  id: 'listPlatformNotifications',
  method: 'GET',
  path: '/platform/notifications',
  summary: 'List platform notices',
  query: listQuery.extend(filters),
  responses: { 200: pageOf(NotificationSchema) },
  ...platformConsole,
});

export const countUnreadPlatformNotifications = defineRoute({
  id: 'countUnreadPlatformNotifications',
  method: 'GET',
  path: '/platform/notifications/unread-count',
  summary: 'Count unread platform notices',
  responses: { 200: UnreadCount },
  ...platformConsole,
});

export const markPlatformNotificationRead = defineRoute({
  id: 'markPlatformNotificationRead',
  method: 'POST',
  path: '/platform/notifications/:id/read',
  summary: 'Mark one platform notice read',
  params: z.object({ id: z.uuid() }),
  responses: { 200: Marked },
  ...platformConsole,
});

export const markAllPlatformNotificationsRead = defineRoute({
  id: 'markAllPlatformNotificationsRead',
  method: 'POST',
  path: '/platform/notifications/read-all',
  summary: 'Mark all platform notices read',
  responses: { 200: Marked },
  ...platformConsole,
});

export const notificationRoutes = [
  listNotifications,
  countUnreadNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  listPlatformNotifications,
  countUnreadPlatformNotifications,
  markPlatformNotificationRead,
  markAllPlatformNotificationsRead,
] as const;
