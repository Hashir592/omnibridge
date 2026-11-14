/**
 * Same-buyer scenarios for the T-0306 mock-ups (client change C3, ORD-9). Eleven synthetic orders
 * that cover every case the spec asks for; `data.ts` writes them over the oldest generated orders,
 * so the list still has 500 orders. The buyer details here stand in for what pii-vault holds:
 * the UI never receives them in a list; the mock grouping reads them the way the vault's `match`
 * capability would, and returns order IDs only.
 */
import type { OrderFlag } from './types.ts';

export interface ScenarioBuyer {
  name: string;
  lines: string[];
  town: string;
  postcode: string;
  country: string;
  phone: string;
  /** eBay only: the buyer's username, which must also match (C3.1 rule 2). */
  username?: string;
}

export interface Scenario {
  /** Which generated order this replaces (the oldest ones, ord_0490 to ord_0500). */
  replaces: string;
  channelAccountId: string;
  /** London wall-clock time: `day` is 0 for today, -1 for yesterday. */
  placed: { day: number; hh: number; mm: number } | { minutesAgo: number };
  shipByDays: number;
  delivery: 'standard' | 'next_day';
  itemCount: number;
  unitPence: number;
  flags: OrderFlag[];
  buyer: ScenarioBuyer;
  /** Why this order is here, for the reader of the mock data. */
  note: string;
}

const maya: ScenarioBuyer = {
  name: 'Maya Marsden',
  lines: ['12 Mill Lane'],
  town: 'Leeds',
  postcode: 'LS6 2AB',
  country: 'GB',
  phone: '07700 900310',
  username: 'maya_m84',
};
const rhys: ScenarioBuyer = {
  name: 'Rhys Rowntree',
  lines: ['4 Station Road'],
  town: 'Bristol',
  postcode: 'BS3 4DF',
  country: 'GB',
  phone: '07700 900452',
};
const priya: ScenarioBuyer = {
  name: 'Priya Pemberton',
  lines: ['88 Victoria Terrace'],
  town: 'Cardiff',
  postcode: 'CF10 1HJ',
  country: 'GB',
  phone: '07700 900687',
};
const grace: ScenarioBuyer = {
  name: 'Grace Garside',
  lines: ['7 Church Walk'],
  town: 'Glasgow',
  postcode: 'G2 7PQ',
  country: 'GB',
  phone: '07700 900129',
  username: 'gracegar',
};
const jessopHome = {
  lines: ['21 Orchard Close'],
  town: 'Oxford',
  postcode: 'OX4 3LN',
  country: 'GB',
};

export const SCENARIOS: Scenario[] = [
  // A: 23:59 and 00:01, two minutes apart across midnight: grouped by the 3 h grace (rule 4b).
  {
    replaces: 'ord_0490',
    channelAccountId: 'ca_2',
    placed: { day: -1, hh: 23, mm: 59 },
    shipByDays: 2,
    delivery: 'standard',
    itemCount: 1,
    unitPence: 1249,
    flags: [],
    buyer: maya,
    note: 'midnight pair, first',
  },
  {
    replaces: 'ord_0491',
    channelAccountId: 'ca_2',
    placed: { day: 0, hh: 0, mm: 1 },
    shipByDays: 2,
    delivery: 'standard',
    itemCount: 2,
    unitPence: 799,
    flags: [],
    buyer: { ...maya, name: 'maya  marsden', postcode: 'ls62ab' },
    note: 'midnight pair, second; case and spacing differ but normalise the same (C3.5 case 6)',
  },
  // B: 10:00 and 22:00 on the same London day: grouped by rule 4a. One has an unmapped item.
  {
    replaces: 'ord_0492',
    channelAccountId: 'ca_1',
    placed: { day: -1, hh: 10, mm: 0 },
    shipByDays: 2,
    delivery: 'standard',
    itemCount: 1,
    unitPence: 1899,
    flags: [],
    buyer: rhys,
    note: 'same-day pair, morning',
  },
  {
    replaces: 'ord_0493',
    channelAccountId: 'ca_1',
    placed: { day: -1, hh: 22, mm: 0 },
    shipByDays: 2,
    delivery: 'standard',
    itemCount: 1,
    unitPence: 999,
    flags: ['unmapped'],
    buyer: rhys,
    note: 'same-day pair, evening, unmapped item',
  },
  // C: three orders this morning with different ship-by dates, one Next Day, one shortened address.
  {
    replaces: 'ord_0494',
    channelAccountId: 'ca_3',
    placed: { minutesAgo: 170 },
    shipByDays: 1,
    delivery: 'standard',
    itemCount: 1,
    unitPence: 2499,
    flags: [],
    buyer: priya,
    note: 'three-order group, ship-by tomorrow',
  },
  {
    replaces: 'ord_0495',
    channelAccountId: 'ca_3',
    placed: { minutesAgo: 95 },
    shipByDays: 0.25,
    delivery: 'next_day',
    itemCount: 2,
    unitPence: 499,
    flags: [],
    buyer: priya,
    note: 'three-order group, Next Day, ship-by today',
  },
  {
    replaces: 'ord_0496',
    channelAccountId: 'ca_3',
    placed: { minutesAgo: 25 },
    shipByDays: 2,
    delivery: 'standard',
    itemCount: 1,
    unitPence: 1499,
    flags: ['address_shortened'],
    buyer: priya,
    note: 'three-order group, address shortened',
  },
  // D: same address, different names: a household, NOT grouped (C3.5 case 5).
  {
    replaces: 'ord_0497',
    channelAccountId: 'ca_4',
    placed: { day: -1, hh: 14, mm: 5 },
    shipByDays: 2,
    delivery: 'standard',
    itemCount: 1,
    unitPence: 3499,
    flags: [],
    buyer: { name: 'Jodie Jessop', phone: '07700 900541', ...jessopHome },
    note: 'household, first name',
  },
  {
    replaces: 'ord_0498',
    channelAccountId: 'ca_4',
    placed: { day: -1, hh: 16, mm: 30 },
    shipByDays: 2,
    delivery: 'standard',
    itemCount: 1,
    unitPence: 799,
    flags: [],
    buyer: { name: 'Tomasz Jessop', phone: '07700 900542', ...jessopHome },
    note: 'household, second name',
  },
  // E: the same buyer on two different eBay accounts: NOT grouped (C3.5 case 4).
  {
    replaces: 'ord_0499',
    channelAccountId: 'ca_2',
    placed: { day: -1, hh: 12, mm: 15 },
    shipByDays: 2,
    delivery: 'standard',
    itemCount: 1,
    unitPence: 1249,
    flags: [],
    buyer: grace,
    note: 'same buyer, eBay account northfield-trading',
  },
  {
    replaces: 'ord_0500',
    channelAccountId: 'ca_5',
    placed: { day: -1, hh: 12, mm: 40 },
    shipByDays: 2,
    delivery: 'standard',
    itemCount: 1,
    unitPence: 1899,
    flags: [],
    buyer: grace,
    note: 'same buyer, eBay account kestrel-home',
  },
];

/** The buyer of a scenario order, by the order ID it took over. */
export const SCENARIO_BUYERS = new Map(SCENARIOS.map((s) => [s.replaces, s.buyer]));

const londonParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** London wall time `day` days from today at hh:mm, as a UTC instant (IANA rules, any DST). */
export function londonInstant(day: number, hh: number, mm: number, now = Date.now()): number {
  const parts = (t: number) =>
    Object.fromEntries(londonParts.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  const today = parts(now);
  const guess = Date.UTC(
    Number(today.year),
    Number(today.month) - 1,
    Number(today.day) + day,
    hh,
    mm,
  );
  const wall = parts(guess);
  const wallAsUtc = Date.UTC(
    Number(wall.year),
    Number(wall.month) - 1,
    Number(wall.day),
    Number(wall.hour),
    Number(wall.minute),
  );
  return guess - (wallAsUtc - guess);
}
