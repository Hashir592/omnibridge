import type { Notifier, TenantContext, TenantRunner } from '@omnibridge/core';
import type { AccountCredentials, ConnectionRepository, ShippingRepository } from '@omnibridge/db';
import {
  fitField,
  isEvriService,
  reflowAddress,
  EVRI_LINE_MAX,
  type EvriAdapter,
  type EvriParcelResult,
} from '@omnibridge/provider-evri';
import {
  AuthFailed,
  ProviderRejected,
  SlotsFull,
  type AccessToken,
} from '@omnibridge/provider-kit';
import { GovernorWait, PermanentJobError, type PhasedHandler } from '@omnibridge/queue';
import type { VaultClient } from '@omnibridge/vault-client';

/*
 * The label jobs (T-1201: SHIP-3, SHIP-4, EVRI-2 to EVRI-6, SHP-5, invariant 11). Every step is a
 * short transaction of its own; no transaction is open across a carrier or vault call
 * (invariant 3). The buyer's details are read from the vault for the one carrier call and never
 * logged, stored or kept (SHIP-4, ADR-089 1); the label file goes straight to the vault.
 */

type Payload = { shipment_id: string };

export interface LabelJobDeps {
  tenancy: Pick<TenantRunner, 'runWorkspace'>;
  shipping: Pick<
    ShippingRepository,
    'work' | 'parcelSending' | 'parcelAnswered' | 'refuse' | 'settle' | 'labelStored' | 'abandon'
  >;
  credentials: Pick<AccountCredentials, 'read'>;
  connections: Pick<ConnectionRepository, 'recordAuthFailure' | 'recordSuccess'>;
  notifier: Pick<Notifier, 'raise' | 'resolve'>;
  vault: Pick<VaultClient, 'readFull' | 'storeLabel' | 'storedLabels' | 'discardLabels'>;
  evri: () => Promise<EvriAdapter>;
  /** RL-4: one of the carrier account's 4 slots around each call; throws SlotsFull when full. */
  slot: <T>(workspaceId: string, carrierAccountId: string, fn: () => Promise<T>) => Promise<T>;
  now?: () => Date;
}

/** The label's recipient from the vault's buyer record, fitted to Evri's limits (EVRI-4). */
export function recipientFrom(fields: Readonly<Record<string, string>>): {
  recipient: {
    firstName: string;
    lastName: string;
    lines: string[];
    postcode: string;
    email?: string;
    phone?: string;
    instructions?: string;
  };
  shortened: boolean;
} {
  const words = (fields.name ?? '').replace(/\s+/g, ' ').trim().split(' ');
  const firstRaw = words.length > 1 ? words.slice(0, -1).join(' ') : (words[0] ?? '');
  const lastRaw = words.at(-1) ?? '';
  const first = fitField(firstRaw, EVRI_LINE_MAX);
  const last = fitField(lastRaw, EVRI_LINE_MAX);
  const address = reflowAddress([
    fields.address_line1 ?? '',
    fields.address_line2 ?? '',
    fields.address_line3 ?? '',
    fields.city ?? '',
    fields.county ?? '',
  ]);
  const instructions =
    fields.delivery_instructions === undefined
      ? undefined
      : fitField(fields.delivery_instructions, EVRI_LINE_MAX);
  return {
    recipient: {
      firstName: first.value,
      lastName: last.value,
      lines: address.lines,
      postcode: (fields.postcode ?? '').trim().toUpperCase(),
      ...(fields.email === undefined ? {} : { email: fields.email.trim() }),
      ...(fields.phone === undefined ? {} : { phone: fields.phone.trim() }),
      ...(instructions === undefined ? {} : { instructions: instructions.value }),
    },
    shortened:
      first.shortened || last.shortened || address.shortened || (instructions?.shortened ?? false),
  };
}

/** Evri has no token expiry (EVRI-2): the stored token is used until a 401. */
const tokenOf = (token: AccessToken['token']): AccessToken => ({
  token,
  expiresAt: new Date('9999-12-31T00:00:00Z'),
});

function factory(deps: LabelJobDeps) {
  const now = deps.now ?? (() => new Date());
  const run = <T>(workspaceId: string, fn: (ctx: TenantContext) => Promise<T>) =>
    deps.tenancy.runWorkspace({ workspaceId }, fn);

  /** A full carrier cap is the queue's governor wait: tried again later, no attempt spent. */
  const slotted = async <T>(ws: string, account: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await deps.slot(ws, account, fn);
    } catch (err) {
      if (err instanceof SlotsFull) throw new GovernorWait(err.until);
      throw err;
    }
  };

  /** EVRI-2: a 401 marks the account Needs re-authorisation, with the notice (and runbook). */
  const lostAuth = async (ws: string, accountId: string, companyId: string) => {
    await run(ws, async (ctx) => {
      const { marked } = await deps.connections.recordAuthFailure(ctx, accountId, now(), {
        revoked: true,
      });
      if (marked) {
        await deps.notifier.raise(ctx, {
          type: 'channel.auth_lost',
          record: { kind: 'channel_account', id: accountId },
          signal: 'native',
          companyId,
          channelAccountId: accountId,
        });
      }
    });
  };

  const credential = async (ws: string, accountId: string) => {
    const secret = await run(ws, (ctx) => deps.credentials.read(ctx, accountId, 'evri'));
    if (secret === undefined) throw new PermanentJobError('evri.not_connected');
    return tokenOf(secret);
  };

  /** Fetches and stores every created parcel's label not yet in the vault (EVRI-5). */
  const storeLabels = async (ws: string, shipmentId: string): Promise<{ stored: boolean }> => {
    const work = await run(ws, (ctx) => deps.shipping.work(ctx, shipmentId));
    if (work?.status !== 'created') return { stored: false };
    const refs = work.orders.flatMap((o) => (o.piiRef === null ? [] : [o.piiRef]));
    const created = work.parcels.filter((p) => p.state === 'created' && p.barcode !== null);
    if (created.length === 0 || refs.length === 0) return { stored: false };
    const { label_ids: have } = await deps.vault.storedLabels(
      ws,
      created.map((p) => p.id),
    );
    const evri = await deps.evri();
    const token = await credential(ws, work.carrierAccountId);
    for (const p of created) {
      if (have.includes(p.id)) continue;
      let pdf: Uint8Array;
      try {
        pdf = await slotted(ws, work.carrierAccountId, () =>
          evri.fetchLabel(token, p.barcode ?? '', work.labelFormat),
        );
      } catch (err) {
        if (err instanceof AuthFailed) {
          await lostAuth(ws, work.carrierAccountId, work.carrierCompanyId);
          throw new PermanentJobError('evri.auth_lost');
        }
        // EVRI-5: a label Evri will not print now (delivered) or no longer knows: not stored.
        if (err instanceof ProviderRejected) return { stored: false };
        throw err;
      }
      await deps.vault.storeLabel({ workspaceId: ws, labelId: p.id, piiRefs: refs, pdf });
    }
    await run(ws, (ctx) => deps.shipping.labelStored(ctx, shipmentId));
    return { stored: true };
  };

  return { run, slotted, lostAuth, credential, storeLabels };
}

/**
 * labels.create: buys the parcels of one shipment, once each, then stores their labels.
 *
 * - The recipient comes from the earliest order's buyer record (purpose `label`, logged); a
 *   shortened address without the user's yes refuses the shipment and buys nothing (EVRI-4).
 * - Each parcel is marked sent before its call. A retry finds it sent and posts it again; Evri
 *   refuses a client UID it already holds (a 400), and the parcel becomes `unknown` and goes on
 *   the reconcile list: never a second parcel (EVRI-3).
 * - An INVALID parcel fails the shipment with Evri's codes and paths (SHIP-4, AT-12).
 */
export function labelsCreateHandler(deps: LabelJobDeps): PhasedHandler<Payload, unknown> {
  const f = factory(deps);
  const now = deps.now ?? (() => new Date());
  return {
    prepare: async (job) => {
      const ws = job.envelope.workspace_id;
      const id = job.payload.shipment_id;
      const work = await f.run(ws, (ctx) => deps.shipping.work(ctx, id));
      if (work === undefined) return { status: 'missing' };
      if (work.status === 'created') return { status: 'created', ...(await f.storeLabels(ws, id)) };
      if (work.status !== 'requested') return { status: work.status };
      if (work.provider !== 'evri' || !isEvriService(work.serviceCode)) {
        throw new PermanentJobError('carrier.not_supported');
      }
      const service = work.serviceCode;
      const lead = work.orders[0];
      if (lead?.piiRef === null || lead === undefined) {
        await f.run(ws, (ctx) => deps.shipping.refuse(ctx, id, 'no_buyer_details'));
        return { status: 'refused' };
      }
      const record = await deps.vault.readFull({
        workspaceId: ws,
        piiRef: lead.piiRef,
        purpose: 'label',
      });
      const { recipient, shortened } = recipientFrom(record.fields);
      if (shortened && !work.confirmShortened) {
        await f.run(ws, (ctx) => deps.shipping.refuse(ctx, id, 'address_not_confirmed'));
        return { status: 'refused' };
      }
      const evri = await deps.evri();
      const token = await f.credential(ws, work.carrierAccountId);
      const value = work.orders.reduce((a, o) => a + o.valuePence, 0n);
      const description = work.orders
        .map((o) => o.itemDescription)
        .join('; ')
        .slice(0, 100);
      for (const parcel of work.parcels) {
        if (parcel.state !== 'pending' && parcel.state !== 'requesting') continue;
        let result: EvriParcelResult | 'skip';
        try {
          // Inside the slot: a full cap waits before the parcel is even marked sent (RL-4).
          result = await f.slotted(ws, work.carrierAccountId, async () => {
            const before = await f.run(ws, (ctx) => deps.shipping.parcelSending(ctx, parcel.id));
            if (before !== 'pending' && before !== 'requesting') return 'skip' as const;
            return evri.createParcel(token, {
              clientUid: parcel.clientUid,
              deliveryReference: lead.externalOrderId,
              itemDescription: description || 'Goods',
              weightGrams: parcel.weightG,
              valuePence: value,
              service,
              recipient,
            });
          });
        } catch (err) {
          if (err instanceof AuthFailed) {
            // Nothing was created: the parcel is refused with a code the user can act on.
            await f.lostAuth(ws, work.carrierAccountId, work.carrierCompanyId);
            await f.run(ws, (ctx) =>
              deps.shipping.parcelAnswered(ctx, parcel.id, {
                state: 'invalid',
                errors: [{ code: 'evri.unauthorised', fields: [] }],
              }),
            );
            continue;
          }
          if (err instanceof ProviderRejected) {
            await f.run(ws, (ctx) =>
              deps.shipping.parcelAnswered(ctx, parcel.id, {
                state: 'invalid',
                errors: [{ code: err.code, fields: [] }],
              }),
            );
            continue;
          }
          // A timeout, a 5xx or a 429: retried; the parcel stays sent, so the retry is safe.
          throw err;
        }
        if (result === 'skip') continue;
        const answer = result;
        await f.run(ws, (ctx) =>
          deps.shipping.parcelAnswered(
            ctx,
            parcel.id,
            answer.state === 'duplicate' ? { state: 'unknown' } : answer,
          ),
        );
      }
      const status = await f.run(ws, (ctx) => deps.shipping.settle(ctx, id));
      if (status === 'created') {
        await f.run(ws, (ctx) => deps.connections.recordSuccess(ctx, work.carrierAccountId, now()));
        return { status, ...(await f.storeLabels(ws, id)) };
      }
      return { status };
    },
    commit: (_job, prepared) => Promise.resolve(prepared),
    // The retries ran out: nothing stays in flight, so the orders can be labelled again.
    failed: async (job) => {
      await deps.shipping.abandon(job.ctx, job.payload.shipment_id);
    },
  };
}

/** labels.fetch (SHP-5, EVRI-5): a reprint of a label not in the vault. Never posts a parcel. */
export function labelsFetchHandler(deps: LabelJobDeps): PhasedHandler<Payload, unknown> {
  const f = factory(deps);
  return {
    prepare: (job) => f.storeLabels(job.envelope.workspace_id, job.payload.shipment_id),
    commit: (_job, prepared) => Promise.resolve(prepared),
  };
}

/** labels.discard (SHP-5): a voided shipment's label files leave the vault at once. */
export function labelsDiscardHandler(deps: LabelJobDeps): PhasedHandler<Payload, unknown> {
  const f = factory(deps);
  return {
    prepare: async (job) => {
      const ws = job.envelope.workspace_id;
      const work = await f.run(ws, (ctx) => deps.shipping.work(ctx, job.payload.shipment_id));
      if (work?.status !== 'voided' || work.parcels.length === 0) return { discarded: 0 };
      const { label_ids } = await deps.vault.discardLabels(
        ws,
        work.parcels.map((p) => p.id),
      );
      return { discarded: label_ids.length };
    },
    commit: (_job, prepared) => Promise.resolve(prepared),
  };
}
