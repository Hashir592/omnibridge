import {
  ApiError,
  emailDefaultOn,
  emailLockedOn,
  NOTIFICATION_SEVERITIES,
  NOTIFICATION_TYPES,
  notificationType,
  type MemberAccess,
  type NotificationType,
} from '@omnibridge/core';
import type { notificationRoutes } from '@omnibridge/contract';
import type { Notification, NotificationCursor, NotificationRepository } from '@omnibridge/db';
import type { Handlers } from './contract.ts';

/**
 * The bell (T-0501: NTF-1, NTF-2, NTF-5). Each member sees what they may see: the repository
 * filters by their ticked tabs, and RLS by their permitted companies (PERM-3). Platform notices
 * are answered only for a platform admin, checked again in the database.
 */
export interface NotificationOptions {
  notifications: Pick<
    NotificationRepository,
    | 'list'
    | 'unreadCount'
    | 'markRead'
    | 'listPlatform'
    | 'platformUnreadCount'
    | 'markPlatformRead'
    | 'emailPreferences'
    | 'setEmailPreferences'
  >;
  now?: () => Date;
}

const unavailable = () =>
  Promise.reject(new ApiError({ status: 503, code: 'service_unavailable' }));

function body(n: Notification) {
  return {
    id: n.id,
    type: n.type,
    title: notificationType(n.type)?.title ?? n.type,
    severity: n.severity,
    signal: n.signal,
    tab: n.tab,
    companyId: n.companyId,
    channelAccountId: n.channelAccountId,
    record: n.record,
    params: { ...n.params },
    state: n.state,
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
    resolvedAt: n.resolvedAt?.toISOString() ?? null,
  };
}

/** The list cursor is opaque to clients: the last row's update time and id, base64url. */
function encodeCursor(cursor: NotificationCursor): string {
  return Buffer.from(`${cursor.at}|${cursor.id}`, 'utf8').toString('base64url');
}

function decodeCursor(text: string | undefined): NotificationCursor | undefined {
  if (text === undefined) return undefined;
  const [at = '', id = '', ...rest] = Buffer.from(text, 'base64url').toString('utf8').split('|');
  if (rest.length > 0 || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(at) || !/^[0-9a-f-]{36}$/.test(id)) {
    throw new ApiError({ status: 400, code: 'bad_request', detail: 'The cursor is not valid' });
  }
  return { at, id };
}

const page = (p: { items: Notification[]; next: NotificationCursor | null }) => ({
  items: p.items.map(body),
  next_cursor: p.next === null ? null : encodeCursor(p.next),
});

const notFound = () => new ApiError({ status: 404, code: 'not_found' });

/** NTF-4: the workspace types this member can receive (a child: those of a ticked tab). */
function receivable(access: MemberAccess): NotificationType[] {
  return NOTIFICATION_TYPES.filter(
    (t) =>
      t.scope === 'workspace' &&
      (access.tabs === 'all' || (t.tab !== undefined && access.tabs.includes(t.tab))),
  );
}

/** The most serious severity a type can have. */
const topSeverity = (t: NotificationType) =>
  NOTIFICATION_SEVERITIES.find((s) => t.severities.includes(s)) ?? 'info';

function preferences(access: MemberAccess, chosen: Map<string, boolean>) {
  return {
    items: receivable(access).map((t) => {
      const locked = emailLockedOn(t, access.role);
      return {
        type: t.code,
        title: t.title,
        severity: topSeverity(t),
        email: locked || (chosen.get(t.code) ?? emailDefaultOn(t)),
        locked,
      };
    }),
  };
}

export function notificationHandlers(
  options: NotificationOptions | undefined,
): Handlers<typeof notificationRoutes> {
  if (options === undefined) {
    return {
      listNotifications: unavailable,
      countUnreadNotifications: unavailable,
      markNotificationRead: unavailable,
      markAllNotificationsRead: unavailable,
      listPlatformNotifications: unavailable,
      countUnreadPlatformNotifications: unavailable,
      markPlatformNotificationRead: unavailable,
      markAllPlatformNotificationsRead: unavailable,
      getEmailPreferences: unavailable,
      setEmailPreferences: unavailable,
    };
  }
  const o = options;
  const now = o.now ?? (() => new Date());
  const viewer = (userId: string, tabs: readonly string[] | 'all') => ({ userId, tabs });

  return {
    listNotifications: async ({ query, session, tenant, access }) => ({
      status: 200,
      body: page(
        await o.notifications.list(
          tenant,
          viewer(session.userId, access.tabs),
          { state: query.state, severity: query.severity },
          { limit: query.limit, after: decodeCursor(query.cursor) },
        ),
      ),
    }),
    countUnreadNotifications: async ({ session, tenant, access }) => ({
      status: 200,
      body: {
        unread: await o.notifications.unreadCount(tenant, viewer(session.userId, access.tabs)),
      },
    }),
    markNotificationRead: async ({ params, session, tenant, access }) => {
      const marked = await o.notifications.markRead(
        tenant,
        viewer(session.userId, access.tabs),
        params.id,
        now(),
      );
      if (marked === 0) throw notFound();
      return { status: 200, body: { marked } };
    },
    markAllNotificationsRead: async ({ session, tenant, access }) => ({
      status: 200,
      body: {
        marked: await o.notifications.markRead(
          tenant,
          viewer(session.userId, access.tabs),
          null,
          now(),
        ),
      },
    }),
    listPlatformNotifications: async ({ query, platform }) => ({
      status: 200,
      body: page(
        await o.notifications.listPlatform(
          platform.userId,
          { state: query.state, severity: query.severity },
          { limit: query.limit, after: decodeCursor(query.cursor) },
        ),
      ),
    }),
    countUnreadPlatformNotifications: async ({ platform }) => ({
      status: 200,
      body: { unread: await o.notifications.platformUnreadCount(platform.userId) },
    }),
    markPlatformNotificationRead: async ({ params, platform }) => {
      const marked = await o.notifications.markPlatformRead(platform.userId, params.id, now());
      if (marked === 0) throw notFound();
      return { status: 200, body: { marked } };
    },
    markAllPlatformNotificationsRead: async ({ platform }) => ({
      status: 200,
      body: { marked: await o.notifications.markPlatformRead(platform.userId, null, now()) },
    }),
    getEmailPreferences: async ({ session, tenant, access }) => ({
      status: 200,
      body: preferences(access, await o.notifications.emailPreferences(tenant, session.userId)),
    }),
    setEmailPreferences: async ({ body, session, tenant, access }) => {
      const allowed = new Map(receivable(access).map((t) => [t.code, t]));
      for (const item of body.items) {
        const type = allowed.get(item.type);
        if (type === undefined) {
          throw new ApiError({
            status: 400,
            code: 'validation_failed',
            detail: `You do not receive notifications of type ${item.type}.`,
          });
        }
        if (!item.email && emailLockedOn(type, access.role)) {
          throw new ApiError({
            status: 400,
            code: 'validation_failed',
            detail: 'Critical alerts cannot be switched off for admins.',
          });
        }
      }
      await o.notifications.setEmailPreferences(tenant, session.userId, body.items, now());
      return {
        status: 200,
        body: preferences(access, await o.notifications.emailPreferences(tenant, session.userId)),
      };
    },
  };
}
