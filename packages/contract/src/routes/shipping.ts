import { z } from 'zod';
import { FileDownloadSchema } from '../download.ts';
import { pagedOf, pageQuery } from '../pages.ts';
import { defineRoute } from '../route.ts';
import { ConnectionSchema, ProviderSchema } from './connections.ts';
import { MaskedBuyerSchema, OrderFlagSchema, OrderGroupRefSchema } from './orders.ts';

/*
 * M12: the shipping desk, Evri and the tracking loop (SHIP-1 to SHIP-4, EVRI-1 to EVRI-7, SHP-1
 * to SHP-9, TRK-1 to TRK-3).
 *
 * - Carrier accounts belong to one company and ship orders of every company in the workspace
 *   (SHIP-1): any shipping user can list them; only admins connect them or set their costs.
 * - Shipments, their parcels and their orders are company-scoped (ARCHITECTURE 6.1). A label is
 *   bought once per parcel: a repeat of the same request never buys a second one.
 * - Label files hold buyer PII: pii-vault keeps them, they are merged on download and never
 *   stored anywhere else (invariant 11). Packing slips are rendered on demand, never stored.
 * - Carrier errors come back in plain words with the carrier's own code (SHIP-4).
 * Money is integer pence excluding VAT, with a VAT rate in basis points (SHP-7). Weights are grams.
 */

const shippingTab = {
  auth: 'session',
  tab: 'shipping',
  adminOnly: false,
  companyScoped: true,
} as const;
/** Workspace-wide shipping settings and rules: admins change them (SHP-3). */
const shippingAdmin = {
  auth: 'session',
  tab: 'shipping',
  adminOnly: true,
  companyScoped: false,
} as const;
const carrierSetup = {
  auth: 'session',
  tab: 'connections',
  adminOnly: true,
  companyScoped: true,
} as const;

const At = z.iso.datetime();
const Pence = z.number().int().min(0).max(1_000_000_000);
const BasisPoints = z.number().int().min(0).max(10_000);
const Grams = z.number().int().min(1).max(1_000_000);
const AccountParams = z.object({ accountId: z.uuid() });
const ShipmentParams = z.object({ shipmentId: z.uuid() });
const NoBody = z.null();

/** SHP-2: at most this many orders in one label request, and labels in one print file. */
export const LABEL_BATCH_MAX = 200;
/** One shipment's parcels. */
export const PARCELS_MAX = 20;
/** C3.4: a same-buyer group has at most 20 members (ORD-9). */
export const SHIP_TOGETHER_MAX = 20;

export const CarrierSchema = z.enum(['evri', 'dpd']).meta({ id: 'Carrier' });

/** EVRI-5: the label layout, a workspace setting (THERMAL by default). */
export const LabelFormatSchema = z
  .enum(['THERMAL', 'DEFAULT', 'TWO_PER_PAGE', 'LARGE_SINGLE', 'LARGE_MULTI'])
  .meta({ id: 'LabelFormat' });

/**
 * A carrier service. `rank` orders services from basic to best: Ship together uses the highest
 * any member needs (SHP-9).
 */
export const CarrierServiceSchema = z
  .object({ code: z.string(), name: z.string(), rank: z.number().int().min(0) })
  .meta({ id: 'CarrierService' });

export const CarrierAccountSchema = z
  .object({
    id: z.uuid(),
    provider: CarrierSchema,
    display_name: z.string(),
    /** The company that owns the account; it ships for every company (SHIP-1). */
    company_id: z.uuid(),
    /** `needs_reauth` after a 401 (EVRI-2): an admin pastes a new code. */
    status: z.enum(['active', 'needs_reauth', 'paused', 'error', 'disconnected']),
    services: z.array(CarrierServiceSchema),
  })
  .meta({ id: 'CarrierAccount' });

/** SHP-7: what a service costs per label, entered by an admin. Carriers do not return prices. */
export const ServiceCostSchema = z
  .object({
    service_code: z.string().min(1).max(50),
    cost_pence: Pence,
    /** Default 20%. */
    vat_rate_bp: BasisPoints,
  })
  .meta({ id: 'ServiceCost' });

export const ShippingSettingsSchema = z
  .object({
    /** SHP-4: Label created then Dispatched in one step. Default on. */
    auto_dispatch_on_label: z.boolean(),
    label_format: LabelFormatSchema,
    /** SHP-2: added to the sum of SKU weights. */
    packaging_allowance_g: z.number().int().min(0).max(50_000),
    /** SHP-6: offer a packing slip with the labels. */
    packing_slip_enabled: z.boolean(),
    /**
     * Minutes after a label before its tracking is sent to the channel; until then Void undoes
     * everything (ADR-089). Default 30. The 4-hour alert still counts from the label (TRK-2).
     */
    tracking_hold_minutes: z.number().int().min(0).max(240),
  })
  .meta({ id: 'ShippingSettings' });

/** SHP-3: every condition given must hold; an empty condition set matches every order. */
export const ShippingRuleConditionsSchema = z
  .object({
    provider: ProviderSchema.optional(),
    channel_account_id: z.uuid().optional(),
    company_id: z.uuid().optional(),
    weight_min_g: z.number().int().min(0).max(1_000_000).optional(),
    weight_max_g: z.number().int().min(0).max(1_000_000).optional(),
    item_count_min: z.number().int().min(0).max(10_000).optional(),
    item_count_max: z.number().int().min(0).max(10_000).optional(),
    /** Upper case, spaces ignored, for example "BT" or "IV1". */
    postcode_prefixes: z
      .array(z.string().regex(/^[A-Z0-9]{1,4}$/))
      .max(50)
      .optional(),
  })
  .strict()
  .meta({ id: 'ShippingRuleConditions' });

export const ShippingRuleSchema = z
  .object({
    id: z.uuid(),
    name: z.string().trim().min(1).max(100),
    enabled: z.boolean(),
    conditions: ShippingRuleConditionsSchema,
    carrier_account_id: z.uuid(),
    service_code: z.string().min(1).max(50),
  })
  .meta({ id: 'ShippingRule' });

/** The rule that chose a service for an order; the user can always override it (SHP-3). */
export const ServiceSuggestionSchema = z
  .object({
    carrier_account_id: z.uuid(),
    service_code: z.string(),
    rule_id: z.uuid(),
    rule_name: z.string(),
  })
  .meta({ id: 'ServiceSuggestion' });

/** SHP-1: one order awaiting dispatch. */
export const DeskRowSchema = z
  .object({
    order_id: z.uuid(),
    order_ref: z.string(),
    provider: ProviderSchema,
    channel_account_id: z.uuid(),
    company_id: z.uuid(),
    placed_at: At,
    ship_by: At.nullable(),
    item_count: z.number().int().min(0),
    total_gross_pence: Pence,
    flags: z.array(OrderFlagSchema),
    buyer: MaskedBuyerSchema.nullable(),
    group: OrderGroupRefSchema.nullable(),
    /** SHP-2: SKU weights plus the packaging allowance; 0 when a SKU has no weight. */
    default_weight_g: z.number().int().min(0),
    suggestion: ServiceSuggestionSchema.nullable(),
    /** SHP-8: whether this channel takes a dispatch of some lines now and the rest later. */
    partial_dispatch: z.boolean(),
  })
  .meta({ id: 'DeskRow' });

/** SHIP-4: what the carrier said, in plain words, with its own code. */
export const CarrierErrorSchema = z
  .object({
    /** The carrier's raw code, for example `evri.invalid_property`. */
    code: z.string(),
    /** Plain words for the user; never buyer details. */
    message: z.string(),
    /** The fields the carrier named, for example `deliveryDetails.deliveryAddress.line1`. */
    fields: z.array(z.string()),
  })
  .meta({ id: 'CarrierError' });

const ParcelRequest = z.object({ weight_g: Grams }).strict();

/**
 * One order's labels. `line_ids` ships only those lines now, where the channel allows a partial
 * dispatch (SHP-8); left out, the whole order ships. `confirm_shortened` is the user's yes to an
 * address the carrier's limits shortened (EVRI-4): without it such an order is refused.
 */
export const LabelOrderRequestSchema = z
  .object({
    order_id: z.uuid(),
    carrier_account_id: z.uuid(),
    service_code: z.string().min(1).max(50),
    parcels: z.array(ParcelRequest).min(1).max(PARCELS_MAX),
    line_ids: z.array(z.uuid()).min(1).max(500).optional(),
    confirm_shortened: z.boolean().optional(),
  })
  .strict()
  .meta({ id: 'LabelOrderRequest' });

export const LabelItemStateSchema = z
  .enum(['queued', 'creating', 'created', 'failed', 'refused'])
  .meta({ id: 'LabelItemState' });

/** Why an order was refused before any carrier call (nothing was bought). */
export const LabelRefusalSchema = z
  .enum([
    'not_awaiting_dispatch',
    'already_labelled',
    'address_not_confirmed',
    'address_changed_after_label',
    'no_buyer_details',
    'carrier_needs_reauth',
    'unknown_service',
    'partial_not_allowed',
  ])
  .meta({ id: 'LabelRefusal' });

export const LabelBatchItemSchema = z
  .object({
    order_id: z.uuid(),
    order_ref: z.string(),
    shipment_id: z.uuid().nullable(),
    state: LabelItemStateSchema,
    tracking_number: z.string().nullable(),
    refusal: LabelRefusalSchema.nullable(),
    error: CarrierErrorSchema.nullable(),
  })
  .meta({ id: 'LabelBatchItem' });

/** SHP-2: a label request and where each order stands. `done` once nothing is still working. */
export const LabelBatchSchema = z
  .object({
    id: z.uuid(),
    created_at: At,
    done: z.boolean(),
    items: z.array(LabelBatchItemSchema),
  })
  .meta({ id: 'LabelBatch' });

export const ParcelStateSchema = z
  .enum(['pending', 'requesting', 'created', 'invalid', 'unknown', 'voided'])
  .meta({ id: 'ParcelState' });

export const ShipmentSchema = z
  .object({
    id: z.uuid(),
    carrier_account_id: z.uuid(),
    provider: CarrierSchema,
    service_code: z.string(),
    status: z.enum(['requested', 'created', 'failed', 'voided']),
    /** The first parcel's barcode; for Evri the barcode is the tracking number (EVRI-6). */
    tracking_number: z.string().nullable(),
    parcels: z.array(
      z.object({
        parcel_no: z.number().int().min(1),
        weight_g: z.number().int().min(1),
        state: ParcelStateSchema,
        barcode: z.string().nullable(),
        error: CarrierErrorSchema.nullable(),
      }),
    ),
    /** One entry per order on the label: several for Ship together (SHP-9). */
    orders: z.array(
      z.object({
        order_id: z.uuid(),
        /** Null when the user cannot see that order's company. */
        order_ref: z.string().nullable(),
        /** SHP-9: equal shares, remainder pence to the earliest orders; they add up to the cost. */
        cost_share_pence: Pence.nullable(),
      }),
    ),
    /** SHP-7: from the cost table when the label was made; null when no cost was set. */
    cost_pence: Pence.nullable(),
    vat_rate_bp: BasisPoints.nullable(),
    label_stored: z.boolean(),
    created_at: At,
    voided_at: At.nullable(),
  })
  .meta({ id: 'Shipment' });

/** SHP-5, EVRI-6: a label to check with the carrier by hand. */
export const ReconcileItemSchema = z
  .object({
    parcel_id: z.uuid(),
    shipment_id: z.uuid(),
    carrier_account_id: z.uuid(),
    barcode: z.string().nullable(),
    /** The reference the carrier holds, for finding an `unknown` parcel in its account. */
    client_uid: z.string(),
    /**
     * `voided`: voided here; the carrier has no void. `unknown`: the carrier may hold this parcel
     * (its answer was lost); it is never bought again.
     */
    reason: z.enum(['voided', 'unknown']),
    since: At,
    order_refs: z.array(z.string()),
  })
  .meta({ id: 'ReconcileItem' });

/** TRK-3: one channel push of a tracking number. */
export const TrackingPushSchema = z
  .object({
    id: z.uuid(),
    order_id: z.uuid(),
    channel_account_id: z.uuid(),
    state: z.enum(['pending', 'sent', 'confirmed', 'failed']),
    tracking_number: z.string(),
    attempts: z.number().int().min(0),
    /** A stable code only, never a provider message or a value. */
    last_error: z.object({ code: z.string(), at: At }).nullable(),
    next_attempt_at: At.nullable(),
    confirmed_at: At.nullable(),
  })
  .meta({ id: 'TrackingPush' });

// ---- Carrier accounts (SHIP-1, EVRI-1, EVRI-2, SHP-7) -----------------------------------------

/** The carrier accounts every shipping user can ship with, with their services. */
export const listCarrierAccounts = defineRoute({
  id: 'listCarrierAccounts',
  method: 'GET',
  path: '/shipping/carriers',
  summary: 'Carrier accounts and their services',
  responses: { 200: z.object({ items: z.array(CarrierAccountSchema) }) },
  ...shippingTab,
  companyScoped: false,
});

/**
 * EVRI-2 step 1: the Evri page where the admin signs in and is sent back with a single-use code
 * (valid 72 hours) in the address bar.
 */
export const getEvriAuthoriseUrl = defineRoute({
  id: 'getEvriAuthoriseUrl',
  method: 'GET',
  path: '/connections/evri/authorise-url',
  summary: 'Where to get an Evri authorisation code',
  responses: { 200: z.object({ url: z.url() }) },
  ...carrierSetup,
  companyScoped: false,
});

/** Evri's code: hexadecimal, `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`. */
const EvriCode = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);

/**
 * EVRI-2 steps 3 and 4: exchanges the code for a token, stored encrypted, and creates the carrier
 * account under a company. 400 `validation_failed` when Evri refuses the code. Audited.
 */
export const connectEvri = defineRoute({
  id: 'connectEvri',
  method: 'POST',
  path: '/connections/evri',
  summary: 'Connect an Evri account',
  body: z
    .object({
      company_id: z.uuid(),
      display_name: z.string().trim().min(1).max(100),
      auth_code: EvriCode,
    })
    .strict(),
  responses: { 201: ConnectionSchema },
  ...carrierSetup,
});

/** EVRI-2: a new code after a 401 (Evri has no refresh). Clears Needs re-authorisation. */
export const reauthoriseEvri = defineRoute({
  id: 'reauthoriseEvri',
  method: 'POST',
  path: '/connections/:accountId/evri/reauthorise',
  summary: 'Re-authorise an Evri account',
  params: AccountParams,
  body: z.object({ auth_code: EvriCode }).strict(),
  responses: { 200: ConnectionSchema },
  ...carrierSetup,
});

export const getServiceCosts = defineRoute({
  id: 'getServiceCosts',
  method: 'GET',
  path: '/connections/:accountId/service-costs',
  summary: "A carrier account's label cost per service",
  params: AccountParams,
  responses: { 200: z.object({ items: z.array(ServiceCostSchema) }) },
  ...carrierSetup,
});

/** SHP-7: replaces the table. A label keeps the cost it was made with. Audited. */
export const putServiceCosts = defineRoute({
  id: 'putServiceCosts',
  method: 'PUT',
  path: '/connections/:accountId/service-costs',
  summary: "Set a carrier account's label cost per service",
  params: AccountParams,
  body: z.object({ items: z.array(ServiceCostSchema).max(50) }).strict(),
  responses: { 200: z.object({ items: z.array(ServiceCostSchema) }) },
  ...carrierSetup,
});

// ---- Settings and rules (SHP-2, SHP-3, SHP-4, SHP-6) -------------------------------------------

export const getShippingSettings = defineRoute({
  id: 'getShippingSettings',
  method: 'GET',
  path: '/shipping/settings',
  summary: 'Shipping settings',
  responses: { 200: ShippingSettingsSchema },
  ...shippingTab,
  companyScoped: false,
});

export const putShippingSettings = defineRoute({
  id: 'putShippingSettings',
  method: 'PUT',
  path: '/shipping/settings',
  summary: 'Change the shipping settings',
  body: ShippingSettingsSchema.strict(),
  responses: { 200: ShippingSettingsSchema },
  ...shippingAdmin,
});

export const getShippingRules = defineRoute({
  id: 'getShippingRules',
  method: 'GET',
  path: '/shipping/rules',
  summary: 'Shipping rules, first match wins',
  responses: { 200: z.object({ items: z.array(ShippingRuleSchema) }) },
  ...shippingTab,
  companyScoped: false,
});

/** SHP-3: replaces the ordered list. A rule without an `id` is new. Audited. */
export const putShippingRules = defineRoute({
  id: 'putShippingRules',
  method: 'PUT',
  path: '/shipping/rules',
  summary: 'Replace the shipping rules',
  body: z
    .object({
      items: z.array(ShippingRuleSchema.extend({ id: z.uuid().optional() }).strict()).max(100),
    })
    .strict(),
  responses: { 200: z.object({ items: z.array(ShippingRuleSchema) }) },
  ...shippingAdmin,
});

// ---- Desk and labels (SHP-1, SHP-2, SHP-5, SHP-8, SHP-9) ---------------------------------------

/** SHP-1: orders awaiting dispatch, by ship-by date (earliest first, none last). */
export const getShippingDesk = defineRoute({
  id: 'getShippingDesk',
  method: 'GET',
  path: '/shipping/desk',
  summary: 'Orders awaiting dispatch',
  query: pageQuery.extend({
    company_id: z.uuid().optional(),
    channel_account_id: z.uuid().optional(),
    provider: ProviderSchema.optional(),
    ship_by: z.enum(['today', 'overdue', 'tomorrow']).optional(),
  }),
  responses: { 200: pagedOf(DeskRowSchema) },
  ...shippingTab,
});

/**
 * SHP-2: labels for up to 200 orders. Each order is locked and checked; a refused order buys
 * nothing and the rest go ahead. Answers at once; the labels are bought in the background, at
 * most once per parcel. Read the batch until `done`.
 */
export const createLabels = defineRoute({
  id: 'createLabels',
  method: 'POST',
  path: '/shipping/labels',
  summary: 'Create labels for orders',
  body: z.object({ orders: z.array(LabelOrderRequestSchema).min(1).max(LABEL_BATCH_MAX) }).strict(),
  responses: { 202: LabelBatchSchema },
  ...shippingTab,
});

/**
 * SHP-9, C3.4: one label for the ticked members of a same-buyer group. The members are locked
 * and re-checked (still Awaiting dispatch, same group): if any changed, nothing is bought and 409
 * `order_changed` names the order. A repeat of the same group and members returns the first
 * batch.
 */
export const shipTogether = defineRoute({
  id: 'shipTogether',
  method: 'POST',
  path: '/shipping/ship-together',
  summary: 'One label for several orders of the same buyer',
  body: z
    .object({
      group_id: z.uuid(),
      order_ids: z.array(z.uuid()).min(2).max(SHIP_TOGETHER_MAX),
      carrier_account_id: z.uuid(),
      service_code: z.string().min(1).max(50),
      parcels: z.array(ParcelRequest).min(1).max(PARCELS_MAX),
      confirm_shortened: z.boolean().optional(),
    })
    .strict(),
  responses: { 202: LabelBatchSchema },
  ...shippingTab,
});

export const getLabelBatch = defineRoute({
  id: 'getLabelBatch',
  method: 'GET',
  path: '/shipping/batches/:batchId',
  summary: 'Where a label request stands',
  params: z.object({ batchId: z.uuid() }),
  responses: { 200: LabelBatchSchema },
  ...shippingTab,
});

/**
 * SHP-2: one PDF of the shipments' labels in the workspace's label format, merged by pii-vault
 * on the fly and never stored. 409 `conflict` when a label is not stored yet (reprint it first).
 */
export const printLabels = defineRoute({
  id: 'printLabels',
  method: 'POST',
  path: '/shipping/labels/print',
  summary: 'Download labels as one PDF',
  body: z.object({ shipment_ids: z.array(z.uuid()).min(1).max(LABEL_BATCH_MAX) }).strict(),
  responses: { 200: FileDownloadSchema },
  ...shippingTab,
});

export const getShipment = defineRoute({
  id: 'getShipment',
  method: 'GET',
  path: '/shipping/shipments/:shipmentId',
  summary: 'One shipment with its parcels and orders',
  params: ShipmentParams,
  responses: { 200: ShipmentSchema },
  ...shippingTab,
});

/**
 * SHP-5, EVRI-5: the existing label again, never a new parcel. 200 with the PDF when it is
 * stored; 202 when it is being fetched from the carrier by barcode (print it once ready).
 */
export const reprintShipment = defineRoute({
  id: 'reprintShipment',
  method: 'POST',
  path: '/shipping/shipments/:shipmentId/reprint',
  summary: 'Reprint a label',
  params: ShipmentParams,
  body: NoBody,
  responses: { 200: FileDownloadSchema, 202: ShipmentSchema },
  ...shippingTab,
});

/**
 * SHP-5, EVRI-6: marks the label void here (the carrier has no void), returns every order on it
 * to Awaiting dispatch and puts it on the reconcile list. Before any tracking is sent it undoes a
 * dispatch too (ADR-089); after that it answers 409 `tracking_sent`.
 */
export const voidShipment = defineRoute({
  id: 'voidShipment',
  method: 'POST',
  path: '/shipping/shipments/:shipmentId/void',
  summary: 'Void a label',
  params: ShipmentParams,
  body: NoBody,
  responses: { 200: ShipmentSchema },
  ...shippingTab,
});

export const listReconcile = defineRoute({
  id: 'listReconcile',
  method: 'GET',
  path: '/shipping/reconcile',
  summary: 'Voided and unknown labels to check with the carrier',
  query: pageQuery,
  responses: { 200: pagedOf(ReconcileItemSchema) },
  ...shippingTab,
});

export const markReconciled = defineRoute({
  id: 'markReconciled',
  method: 'POST',
  path: '/shipping/reconcile/:parcelId/done',
  summary: 'Take a label off the reconcile list',
  params: z.object({ parcelId: z.uuid() }),
  body: NoBody,
  responses: { 204: NoBody },
  ...shippingTab,
});

/**
 * The buyer's address changed after the label was printed (ADR-081): the printed label still has
 * the old one. The order cannot be dispatched until a user confirms it was checked (relabel or
 * keep).
 */
export const confirmAddressCheck = defineRoute({
  id: 'confirmAddressCheck',
  method: 'POST',
  path: '/orders/:orderId/address-check',
  summary: 'Confirm a changed address was checked',
  params: z.object({ orderId: z.uuid() }),
  body: NoBody,
  responses: { 204: NoBody },
  ...shippingTab,
});

/** SHP-6: order refs, items, quantities and the delivery address, rendered now, never stored. */
export const packingSlips = defineRoute({
  id: 'packingSlips',
  method: 'POST',
  path: '/shipping/packing-slips',
  summary: 'Download packing slips as one PDF',
  body: z.object({ order_ids: z.array(z.uuid()).min(1).max(LABEL_BATCH_MAX) }).strict(),
  responses: { 200: FileDownloadSchema },
  ...shippingTab,
});

// ---- Tracking (TRK-1 to TRK-3) -----------------------------------------------------------------

export const listOrderTracking = defineRoute({
  id: 'listOrderTracking',
  method: 'GET',
  path: '/orders/:orderId/tracking',
  summary: "An order's tracking pushes",
  params: z.object({ orderId: z.uuid() }),
  responses: { 200: z.object({ items: z.array(TrackingPushSchema) }) },
  ...shippingTab,
});

/** TRK-2: sends a failed push again from the dead-letter queue. Audited. */
export const resendTracking = defineRoute({
  id: 'resendTracking',
  method: 'POST',
  path: '/shipping/tracking/:pushId/resend',
  summary: 'Send a failed tracking push again',
  params: z.object({ pushId: z.uuid() }),
  body: NoBody,
  responses: { 200: TrackingPushSchema },
  ...shippingTab,
  adminOnly: true,
});

export const shippingRoutes = [
  listCarrierAccounts,
  getEvriAuthoriseUrl,
  connectEvri,
  reauthoriseEvri,
  getServiceCosts,
  putServiceCosts,
  getShippingSettings,
  putShippingSettings,
  getShippingRules,
  putShippingRules,
  getShippingDesk,
  createLabels,
  shipTogether,
  getLabelBatch,
  printLabels,
  getShipment,
  reprintShipment,
  voidShipment,
  listReconcile,
  markReconciled,
  confirmAddressCheck,
  packingSlips,
  listOrderTracking,
  resendTracking,
] as const;
