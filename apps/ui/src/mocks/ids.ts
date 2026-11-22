/**
 * Stable uuid-shaped ids for mock keys (no msw import, so mock data modules that app screens read
 * may use it). The catalogue and stock mocks key Master SKUs and listings by these, and the older
 * preview mocks (forecasting) link to the same SKUs through `uid('sku_12')`.
 */
let counter = 0;
const ids = new Map<string, string>();

export function uid(key: string): string {
  let id = ids.get(key);
  if (!id) {
    counter += 1;
    id = `0c0a1e9d-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`;
    ids.set(key, id);
  }
  return id;
}
