import type { Provider } from '@omnibridge/core';
import type { Secret } from '@omnibridge/crypto';

/*
 * INT-1: every integration sits behind one of these interfaces. Business modules see the types
 * here and the queue, never a provider package (dependency-cruiser `business-not-to-providers`).
 */

/** A short-lived access token and when it stops working. */
export interface AccessToken {
  readonly token: Secret;
  readonly expiresAt: Date;
}

/** Tokens from an OAuth code exchange: the refresh token is stored, encrypted (INT-3). */
export interface TokenGrant extends AccessToken {
  readonly refreshToken: Secret;
  readonly refreshTokenExpiresAt: Date | null;
}

/** One page of an "updated since" read (INT-8). */
export interface Page<T> {
  readonly items: readonly T[];
  /** Opaque: the provider's next-page token or offset, undefined on the last page. */
  readonly next: string | undefined;
}

/** An order as the cursor sees it: IDs and quantities only. Buyer data goes to the vault (M10). */
export interface OrderSummary {
  readonly externalId: string;
  readonly updatedAt: Date;
  readonly status: string;
  readonly lines: readonly {
    readonly lineId: string;
    readonly sku: string | null;
    readonly quantity: number;
  }[];
}

/**
 * The buyer's details as a channel sends them (ORD-4, DP-5). They go to pii-vault and nowhere
 * else: the order ingest hands them to the vault before anything is written to db-main, and
 * strips them from the order it stores (invariants 7 and 7a). Field names match the vault's.
 */
export const BUYER_FIELDS = [
  'name',
  'email',
  'phone',
  'address_line1',
  'address_line2',
  'address_line3',
  'city',
  'county',
  'postcode',
  'country',
  'delivery_instructions',
  'channel_buyer_id',
  'channel_username',
] as const;
export type BuyerField = (typeof BUYER_FIELDS)[number];
export type BuyerDetails = Readonly<Partial<Record<BuyerField, string>>>;

/**
 * The channel's own lifecycle, as the adapter reads it (FA-10). The order ingest maps it onto the
 * ORD-3 statuses through the state table; refunds are worked out from `refunds`, not from here.
 */
export type ChannelOrderState =
  'pending_payment' | 'awaiting_dispatch' | 'dispatched' | 'delivered' | 'cancelled';

export interface ChannelOrderLine {
  readonly lineId: string;
  readonly sku: string | null;
  readonly quantity: number;
  readonly title: string | null;
  /** VAT-inclusive price of the whole line (quantity × unit), in pence (VAT-2). */
  readonly linePricePence: number;
}

export interface ChannelRefund {
  readonly refundId: string;
  readonly refundedAt: Date;
  readonly amountPence: number;
  /** Present when the channel says which lines the refund is for (VAT-5). */
  readonly lines:
    | readonly {
        readonly lineId: string;
        readonly quantity: number;
        readonly amountPence: number;
      }[]
    | null;
}

/** A whole order as an "updated since" read returns it (M10): money, dates, lines and refunds. */
export interface ChannelOrder extends OrderSummary {
  readonly state: ChannelOrderState;
  readonly placedAt: Date;
  readonly paidAt: Date | null;
  readonly shipBy: Date | null;
  readonly dispatchedAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly cancelledAt: Date | null;
  /** The order-level discount. Money is GBP only (TEN-6): the parser refuses anything else. */
  readonly discountPence: number;
  /** Shipping charged to the buyer, VAT-inclusive (VAT-3 step 3). */
  readonly shippingPence: number;
  /** What the buyer paid as the channel states it; null when it states no total (FIN-1). */
  readonly totalPence: number | null;
  readonly shipToCountry: string | null;
  readonly fba: boolean;
  readonly lines: readonly ChannelOrderLine[];
  readonly refunds: readonly ChannelRefund[];
  /** PII: for the vault only (see BuyerDetails). Null when the channel sent none. */
  readonly buyer: BuyerDetails | null;
  /**
   * Set by the order ingest's vault-first step (M10), which also clears `buyer`: the vault's
   * pii_ref, or why there is none. Absent straight from a parser.
   */
  readonly pii?:
    | { readonly kind: 'stored'; readonly piiRef: string }
    | { readonly kind: 'none' | 'refused' | 'unchanged' };
}

/** A channel whose order read returns whole orders (eBay and the website in M10; Amazon in M18). */
export interface OrderSource {
  ordersUpdatedSince(token: AccessToken, since: Date, page?: string): Promise<Page<ChannelOrder>>;
}

/** A channel listing as discovery reads it (CAT-5): codes, flags and the quantity only. */
export interface ListingInfo {
  readonly externalSku: string;
  /** Listing ID, ASIN or item ID. */
  readonly externalId: string;
  readonly title: string | null;
  /** Amazon only: merchant- or Amazon-fulfilled. */
  readonly fulfilment: 'mfn' | 'fba' | null;
  /** eBay only: the listing's stock is managed through the Inventory API. */
  readonly inventoryApi: boolean | null;
  /** The quantity the channel shows now (INV-7), when it says. */
  readonly quantity: number | null;
}

export interface StockLevel {
  readonly sku: string;
  readonly quantity: number;
}

/** Per SKU: accepted, or refused with a stable code (never the provider's message). */
export interface WriteResult {
  readonly accepted: readonly string[];
  readonly refused: readonly { readonly sku: string; readonly code: string }[];
}

interface ProviderAdapter {
  readonly provider: Provider;
  /** Turns the stored credential (a refresh token or an API key) into an access token. */
  authenticate(credential: Secret): Promise<AccessToken>;
}

/** Marketplaces and the website (Amazon, eBay, website). */
export interface ChannelAdapter extends ProviderAdapter {
  readonly provider: 'amazon' | 'ebay' | 'website';
  ordersUpdatedSince(token: AccessToken, since: Date, page?: string): Promise<Page<OrderSummary>>;
  pushStock(token: AccessToken, levels: readonly StockLevel[]): Promise<WriteResult>;
  /** One page of the account's listings (CAT-5); a complete scan reads every page. */
  listListings(token: AccessToken, page?: string): Promise<Page<ListingInfo>>;
}

export interface AdsProfile {
  readonly profileId: string;
  readonly countryCode: string;
}

export interface AdsAdapter extends ProviderAdapter {
  readonly provider: 'amazon_ads';
  profiles(token: AccessToken): Promise<readonly AdsProfile[]>;
  setCampaignStates(
    token: AccessToken,
    profileId: string,
    changes: readonly { readonly campaignId: string; readonly state: 'enabled' | 'paused' }[],
  ): Promise<WriteResult>;
}

/** SHIP-3. */
export interface Parcel {
  readonly weightGrams: number;
  readonly lengthCm?: number;
  readonly widthCm?: number;
  readonly heightCm?: number;
}

/** The delivery address is read from the vault for this one call (M12) and never stored here. */
export interface ShipmentAddress {
  readonly name: string;
  readonly line1: string;
  readonly line2?: string;
  readonly city: string;
  readonly postcode: string;
  readonly country: string;
}

export interface CarrierService {
  readonly code: string;
  readonly name: string;
}

export interface Shipment {
  readonly trackingNumbers: readonly string[];
  readonly carrierShipmentRef: string;
  readonly labels: readonly { readonly format: 'pdf' | 'zpl'; readonly ref: string }[];
}

export interface TrackingEvent {
  readonly code: string;
  readonly at: Date;
}

/** SHIP-3: `listServices`, `createShipment`, `getLabel` and the capability flags. */
export interface ShippingProvider extends ProviderAdapter {
  readonly provider: 'evri' | 'dpd';
  readonly canVoid: boolean;
  readonly canTrack: boolean;
  readonly needsManifest: boolean;
  listServices(
    token: AccessToken,
    from: string,
    to: string,
    parcels: readonly Parcel[],
  ): Promise<readonly CarrierService[]>;
  createShipment(
    token: AccessToken,
    order: { readonly reference: string; readonly address: ShipmentAddress },
    parcels: readonly Parcel[],
    service: string,
    options?: { readonly signature?: boolean },
  ): Promise<Shipment>;
  getLabel(token: AccessToken, ref: string, format: 'pdf' | 'zpl'): Promise<Uint8Array>;
  tracking(token: AccessToken, trackingNumber: string): Promise<readonly TrackingEvent[]>;
}
