import type { OrdersSearch } from '../routes/orders.tsx';

/**
 * The Orders list filters the user last had, so "Back to orders" returns to the same view.
 * In memory only; it holds filters, never customer details.
 */
let last: OrdersSearch = {};

export const rememberOrdersSearch = (s: OrdersSearch): void => {
  last = s;
};
export const lastOrdersSearch = (): OrdersSearch => last;
