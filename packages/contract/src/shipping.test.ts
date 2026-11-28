import { describe, expect, it } from 'vitest';
import { routeMetadataProblems } from './route.ts';
import {
  connectEvri,
  createLabels,
  LABEL_BATCH_MAX,
  ShippingRuleConditionsSchema,
  ShippingSettingsSchema,
  shippingRoutes,
  shipTogether,
} from './routes/shipping.ts';

const order = {
  order_id: '00000000-0000-4000-8000-000000000001',
  carrier_account_id: '00000000-0000-4000-8000-000000000002',
  service_code: 'standard',
  parcels: [{ weight_g: 500 }],
};
const labels = (n: number) => createLabels.body.safeParse({ orders: Array(n).fill(order) }).success;

describe('the shipping contract (SHIP-1, SHP-2, SHP-9, EVRI-2)', () => {
  it('[SHIP-1] carriers are set up by admins on Connections; every shipping user may list them', () => {
    for (const route of shippingRoutes) expect(routeMetadataProblems(route), route.id).toEqual([]);
    const byId = new Map(shippingRoutes.map((r) => [r.id, r]));
    for (const id of ['connectEvri', 'reauthoriseEvri', 'putServiceCosts', 'getEvriAuthoriseUrl']) {
      expect(byId.get(id as never)?.tab, id).toBe('connections');
      expect(byId.get(id as never)?.adminOnly, id).toBe(true);
    }
    expect(byId.get('listCarrierAccounts')?.adminOnly).toBe(false);
    expect(byId.get('putShippingRules')?.adminOnly).toBe(true);
    expect(byId.get('createLabels')?.companyScoped).toBe(true);
  });

  it('[SHP-2] a label request holds 1 to 200 orders, each with 1 to 20 parcels in whole grams', () => {
    expect(labels(1)).toBe(true);
    expect(labels(LABEL_BATCH_MAX)).toBe(true);
    expect(labels(LABEL_BATCH_MAX + 1)).toBe(false);
    expect(labels(0)).toBe(false);
    const one = (o: object) =>
      createLabels.body.safeParse({ orders: [{ ...order, ...o }] }).success;
    expect(one({ parcels: [{ weight_g: 0.5 }] })).toBe(false);
    expect(one({ parcels: Array(21).fill({ weight_g: 1 }) })).toBe(false);
  });

  it('[SHP-9] Ship together names 2 to 20 members of one group', () => {
    const body = (n: number) => ({
      group_id: order.order_id,
      order_ids: Array.from({ length: n }, () => order.order_id),
      carrier_account_id: order.carrier_account_id,
      service_code: 'standard',
      parcels: [{ weight_g: 900 }],
    });
    expect(shipTogether.body.safeParse(body(2)).success).toBe(true);
    expect(shipTogether.body.safeParse(body(20)).success).toBe(true);
    expect(shipTogether.body.safeParse(body(1)).success).toBe(false);
    expect(shipTogether.body.safeParse(body(21)).success).toBe(false);
  });

  it('[EVRI-2] an Evri code has the documented hexadecimal form', () => {
    const code = (auth_code: string) =>
      connectEvri.body.safeParse({ company_id: order.order_id, display_name: 'Evri', auth_code })
        .success;
    expect(code('0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d')).toBe(true);
    expect(code('not-a-code')).toBe(false);
    expect(code('0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5g')).toBe(false);
  });

  it('[SHP-3][SHP-4] rules take only known conditions; the tracking hold is 0 to 240 minutes', () => {
    expect(
      ShippingRuleConditionsSchema.safeParse({ postcode_prefixes: ['BT', 'IV1'] }).success,
    ).toBe(true);
    expect(ShippingRuleConditionsSchema.safeParse({ postcode_prefixes: ['bt'] }).success).toBe(
      false,
    );
    expect(ShippingRuleConditionsSchema.safeParse({ colour: 'red' }).success).toBe(false);
    const settings = {
      auto_dispatch_on_label: true,
      label_format: 'THERMAL',
      packaging_allowance_g: 150,
      packing_slip_enabled: false,
      tracking_hold_minutes: 30,
    };
    expect(ShippingSettingsSchema.safeParse(settings).success).toBe(true);
    expect(
      ShippingSettingsSchema.safeParse({ ...settings, tracking_hold_minutes: 241 }).success,
    ).toBe(false);
  });
});
