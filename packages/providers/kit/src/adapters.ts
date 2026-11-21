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
