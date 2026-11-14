/**
 * Customer Service for the client preview (T-0305). PROPOSED SHAPE (mock only), CS-1..5.
 * Message bodies and buyer usernames are buyer PII (CS-2): the thread route returns them from
 * pii-vault and logs every view; lists carry masked usernames and no message text.
 * All text is synthetic.
 */
import { channelAccounts, orders } from './data.ts';
import { DAY, HOUR, ago, rng } from './random.ts';

export interface Conversation {
  id: string;
  channelAccountId: string;
  companyId: string;
  buyerMasked: string;
  topic: string;
  lastAt: string;
  unread: number;
  state: 'open' | 'archived';
  order: { id: string; ref: string } | null;
  messages: number;
}

export interface Message {
  id: string;
  from: 'buyer' | 'seller';
  by: string | null;
  at: string;
  text: string;
}

export interface Thread {
  conversation: Conversation;
  messages: Message[];
  /** CS-2: the body is deleted 30 days after the last activity; metadata stays. */
  deleteAfter: string;
}

export interface Feedback {
  id: string;
  channel: 'ebay' | 'amazon';
  channelAccountId: string;
  companyId: string;
  rating: 'positive' | 'neutral' | 'negative' | 1 | 2 | 3 | 4 | 5;
  comment: string;
  at: string;
  order: { id: string; ref: string } | null;
  reply: string | null;
}

export interface FeedbackSummary {
  channelAccountId: string;
  counts: Array<{ period: string; positive: number; neutral: number; negative: number }>;
}

export interface ReviewRequests {
  accounts: Array<{ channelAccountId: string; on: boolean; sent30: number; notEligible30: number }>;
  recent: Array<{
    id: string;
    channelAccountId: string;
    order: { id: string; ref: string };
    at: string;
    result: 'sent' | 'not_eligible' | 'error';
  }>;
}

export const TEMPLATES = [
  {
    id: 'tpl_1',
    name: 'Dispatched today',
    text: 'Thank you for your message. Your order was dispatched today and the tracking number is on the order page.',
  },
  {
    id: 'tpl_2',
    name: 'Return instructions',
    text: 'Sorry to hear the item is not right. Please open a return from your order page and we will send a label.',
  },
  {
    id: 'tpl_3',
    name: 'Combined postage',
    text: 'We can combine postage on several items. Add them to your basket and we will refund the difference.',
  },
];

const r = rng(4_5);
const TOPICS = [
  'Question about an item',
  'Where is my order?',
  'Return request',
  'Item arrived damaged',
  'Combined postage',
  'Question about an item',
];
const BUYER = [
  'How long does delivery usually take to Scotland?',
  'Hello, I ordered on Friday and have not had a tracking update yet. Can you check?',
  'The lid on one of the jars was cracked when it arrived. Can you send a replacement?',
  'Do you have this in the large size as well?',
  'I would like to return this as it is the wrong colour, how do I do that?',
];
const SELLER = [
  'Thanks for getting in touch. It was sent with a tracked service yesterday and should arrive tomorrow.',
  'Sorry about that. We have sent a replacement today, no need to return the damaged one.',
  'Yes, the large size is listed separately. I have sent you the link.',
];

const ebayAccounts = channelAccounts.filter((a) => a.channel === 'ebay');
const ebayOrders = orders.filter((o) => o.channel === 'ebay');
const amazonAccounts = channelAccounts.filter((a) => a.channel === 'amazon');
const amazonOrders = orders.filter((o) => o.channel === 'amazon');

const mask = () =>
  `${r.pick(['j', 'm', 'a', 'k', 's', 'p', 't'])}***${r.pick(['e', 'n', '7', '2', 'y', 'o'])}`;

const CONVERSATIONS: Array<Conversation & { body: Message[] }> = Array.from(
  { length: 34 },
  (_, i) => {
    const a = r.pick(ebayAccounts);
    const own = ebayOrders.filter((x) => x.channelAccountId === a.id);
    const o = own.length > 0 && r.chance(0.7) ? r.pick(own) : undefined;
    const lastAt = ago(i * 3.1 * HOUR + r.int(5, 90) * 60_000);
    const n = r.int(1, 4);
    const body: Message[] = Array.from({ length: n }, (_, k) => {
      const buyer = k % 2 === 0;
      return {
        id: `msg_${String(i)}_${String(k)}`,
        from: buyer ? 'buyer' : 'seller',
        by: buyer ? null : r.pick(['Jo Support', 'Sam Admin']),
        at: new Date(Date.parse(lastAt) - (n - 1 - k) * 2.5 * HOUR).toISOString(),
        text: buyer ? r.pick(BUYER) : r.pick(SELLER),
      };
    });
    const lastFromBuyer = body[body.length - 1]?.from === 'buyer';
    return {
      id: `cnv_${String(i)}`,
      channelAccountId: a.id,
      companyId: a.companyId,
      buyerMasked: mask(),
      topic: r.pick(TOPICS),
      lastAt,
      unread: lastFromBuyer && i < 14 ? r.int(1, 2) : 0,
      state: i > 26 ? 'archived' : 'open',
      order: o ? { id: o.id, ref: o.ref } : null,
      messages: n,
      body,
    };
  },
);

/** The list shape: everything but the message bodies (PII stays on the thread route). */
const strip = (c: Conversation & { body?: Message[] }): Conversation => {
  const copy = { ...c };
  delete copy.body;
  return copy;
};

export function conversations(allowed: Set<string>, p: URLSearchParams) {
  const company = p.get('company');
  const view = p.get('view') ?? 'open';
  const account = p.get('account');
  const base = CONVERSATIONS.filter(
    (c) => allowed.has(c.companyId) && (!company || company === 'all' || c.companyId === company),
  );
  const items = base.filter(
    (c) =>
      (view === 'unread' ? c.unread > 0 && c.state === 'open' : c.state === view) &&
      (!account || c.channelAccountId === account),
  );
  return {
    items: items.map(strip),
    counts: {
      open: base.filter((c) => c.state === 'open').length,
      unread: base.filter((c) => c.unread > 0 && c.state === 'open').length,
      archived: base.filter((c) => c.state === 'archived').length,
    },
  };
}

export function thread(allowed: Set<string>, id: string): Thread | null {
  const c = CONVERSATIONS.find((x) => x.id === id);
  if (!c || !allowed.has(c.companyId)) return null;
  return {
    conversation: strip(c),
    messages: c.body,
    deleteAfter: new Date(Date.parse(c.lastAt) + 30 * DAY).toISOString(),
  };
}

const FEEDBACK_TEXT = {
  good: [
    'Fast delivery, well packed. Thank you.',
    'Exactly as described.',
    'Great seller, would buy again.',
  ],
  mid: ['Item fine but took a week to arrive.', 'Smaller than I expected.'],
  bad: ['Arrived damaged and no reply for two days.', 'Wrong colour sent.'],
};

const FEEDBACK: Feedback[] = [
  ...Array.from({ length: 16 }, (_, i): Feedback => {
    const a = r.pick(ebayAccounts);
    const rating = i === 1 ? 'negative' : i === 4 ? 'neutral' : 'positive';
    const o = r.pick(ebayOrders);
    return {
      id: `fb_e${String(i)}`,
      channel: 'ebay',
      channelAccountId: a.id,
      companyId: a.companyId,
      rating,
      comment: r.pick(
        rating === 'positive'
          ? FEEDBACK_TEXT.good
          : rating === 'neutral'
            ? FEEDBACK_TEXT.mid
            : FEEDBACK_TEXT.bad,
      ),
      at: ago(i * 9 * HOUR + HOUR),
      order: { id: o.id, ref: o.ref },
      reply: i === 4 ? 'Sorry for the wait. Royal Mail had delays in your area that week.' : null,
    };
  }),
  ...Array.from({ length: 10 }, (_, i): Feedback => {
    const a = r.pick(amazonAccounts);
    const rating = (i === 2 ? 2 : i === 6 ? 3 : r.pick([4, 5, 5])) as Feedback['rating'];
    const o = r.pick(amazonOrders);
    return {
      id: `fb_a${String(i)}`,
      channel: 'amazon',
      channelAccountId: a.id,
      companyId: a.companyId,
      rating,
      comment: r.pick(
        typeof rating === 'number' && rating <= 3 ? FEEDBACK_TEXT.bad : FEEDBACK_TEXT.good,
      ),
      at: ago(i * 14 * HOUR + 2 * HOUR),
      order: { id: o.id, ref: o.ref },
      reply: null,
    };
  }),
];

export function feedback(allowed: Set<string>, company: string | null) {
  const ok = (companyId: string) =>
    allowed.has(companyId) && (!company || company === 'all' || companyId === company);
  return {
    items: FEEDBACK.filter((f) => ok(f.companyId)),
    ebaySummary: ebayAccounts
      .filter((a) => ok(a.companyId))
      .map((a, i): FeedbackSummary => ({
        channelAccountId: a.id,
        counts: [
          { period: '30 days', positive: 84 - i * 40, neutral: 1, negative: 1 - i },
          { period: '6 months', positive: 512 - i * 230, neutral: 4, negative: 3 - i },
          {
            period: '12 months',
            positive: 1_046 - i * 480,
            neutral: 9 - i * 3,
            negative: 5 - i * 2,
          },
        ],
      })),
  };
}

export function reviewRequests(allowed: Set<string>, company: string | null): ReviewRequests {
  const accts = amazonAccounts.filter(
    (a) => allowed.has(a.companyId) && (!company || company === 'all' || a.companyId === company),
  );
  // Seeded per call, so the same request always returns the same rows.
  const rr = rng(5_5);
  const first = accts[0];
  const own = first ? amazonOrders.filter((x) => x.channelAccountId === first.id) : [];
  return {
    accounts: accts.map((a, i) => ({
      channelAccountId: a.id,
      on: i === 0,
      sent30: i === 0 ? 612 : 0,
      notEligible30: i === 0 ? 41 : 0,
    })),
    recent:
      first && own.length > 0
        ? Array.from({ length: 8 }, (_, i) => {
            const o = rr.pick(own);
            return {
              id: `rr_${String(i)}`,
              channelAccountId: first.id,
              order: { id: o.id, ref: o.ref },
              at: ago(i * 0.4 * HOUR + 18 * HOUR),
              result: i === 3 ? 'not_eligible' : i === 6 ? 'error' : 'sent',
            };
          })
        : [],
  };
}

/* ---------- Amazon buyer messages (client change C6, CS-6) ---------- */

export interface AmazonConversation {
  id: string;
  channelAccountId: string;
  companyId: string;
  topic: string;
  lastAt: string;
  unread: number;
  state: 'open' | 'done';
  order: { id: string; ref: string } | null;
  /** Amazon expects a reply within 24 hours of the buyer's last message; null once answered. */
  replyDueAt: string | null;
}

export interface AmazonThread {
  conversation: AmazonConversation;
  messages: Message[];
  deleteAfter: string;
}

const AMAZON_TOPICS = [
  'Delivery date',
  'Item arrived damaged',
  'Return request',
  'Question about the size',
  'Order not received',
  'Invoice request',
];
const AMAZON_BUYER = [
  'Hi, could you tell me when this will be delivered? I need it by Friday.',
  'The glass jar arrived cracked. Can you send a replacement, please?',
  'Can I return this? It is the wrong size for my shelf.',
  'Is the large board 45 cm or 50 cm long?',
  'Tracking says delivered but nothing has arrived.',
  'Could you send a VAT invoice for this order, please?',
];

const ar = rng(6_6);
const AMAZON_CONVERSATIONS: Array<AmazonConversation & { body: Message[] }> = Array.from(
  { length: 18 },
  (_, i) => {
    const a = amazonAccounts[i % amazonAccounts.length] ?? amazonAccounts[0];
    const own = amazonOrders.filter((o) => o.channelAccountId === a?.id);
    const o = own.length > 0 ? ar.pick(own) : undefined;
    const lastAt = ago(i * 2.3 * HOUR + ar.int(5, 50) * 60_000);
    const answered = i % 4 === 3;
    const done = i > 13;
    const t = ar.int(0, AMAZON_TOPICS.length - 1);
    const body: Message[] = [
      { id: `am_${String(i)}_0`, from: 'buyer', by: null, at: lastAt, text: AMAZON_BUYER[t] ?? '' },
      ...(answered
        ? [
            {
              id: `am_${String(i)}_1`,
              from: 'seller' as const,
              by: 'Jo Support',
              at: new Date(Date.parse(lastAt) + 40 * 60_000).toISOString(),
              text: 'Thank you for your message. We have looked into this and replied on your order.',
            },
          ]
        : []),
    ];
    return {
      id: `amc_${String(i)}`,
      channelAccountId: a?.id ?? '',
      companyId: a?.companyId ?? '',
      topic: AMAZON_TOPICS[t] ?? '',
      lastAt,
      unread: !answered && !done && i < 9 ? 1 : 0,
      state: done ? 'done' : 'open',
      order: o ? { id: o.id, ref: o.ref } : null,
      replyDueAt: answered || done ? null : new Date(Date.parse(lastAt) + 24 * HOUR).toISOString(),
      body,
    };
  },
);

const stripAmazon = (c: AmazonConversation & { body?: Message[] }): AmazonConversation => {
  const copy = { ...c };
  delete copy.body;
  return copy;
};

export function amazonConversations(allowed: Set<string>, p: URLSearchParams) {
  const company = p.get('company');
  const accounts = amazonAccounts.filter(
    (a) => allowed.has(a.companyId) && (!company || company === 'all' || a.companyId === company),
  );
  const account = p.get('account') ?? accounts[0]?.id ?? '';
  const view = p.get('view') ?? 'open';
  const mine = AMAZON_CONVERSATIONS.filter((c) => c.channelAccountId === account);
  return {
    accounts: accounts.map((a) => ({
      channelAccountId: a.id,
      unread: AMAZON_CONVERSATIONS.filter(
        (c) => c.channelAccountId === a.id && c.unread > 0 && c.state === 'open',
      ).length,
    })),
    account,
    items: mine
      .filter((c) => (view === 'unread' ? c.unread > 0 && c.state === 'open' : c.state === view))
      .map(stripAmazon),
    counts: {
      open: mine.filter((c) => c.state === 'open').length,
      unread: mine.filter((c) => c.unread > 0 && c.state === 'open').length,
      done: mine.filter((c) => c.state === 'done').length,
    },
  };
}

export type AmazonInbox = ReturnType<typeof amazonConversations>;

export function amazonThread(allowed: Set<string>, id: string): AmazonThread | null {
  const c = AMAZON_CONVERSATIONS.find((x) => x.id === id);
  if (!c || !allowed.has(c.companyId)) return null;
  return {
    conversation: stripAmazon(c),
    messages: c.body,
    deleteAfter: new Date(Date.parse(c.lastAt) + 30 * DAY).toISOString(),
  };
}

/* ---------- conversation actions (mark read, unread, archived or done) ---------- */

export interface ConversationPatch {
  unread?: boolean;
  state?: 'open' | 'archived' | 'done';
}

/** eBay: read, unread, archived (CS-1). Returns false for an unknown or not-permitted thread. */
export function patchConversation(
  allowed: Set<string>,
  id: string,
  patch: ConversationPatch,
): boolean {
  const c = CONVERSATIONS.find((x) => x.id === id);
  if (!c || !allowed.has(c.companyId)) return false;
  if (patch.unread !== undefined) c.unread = patch.unread ? Math.max(1, c.unread) : 0;
  if (patch.state === 'open' || patch.state === 'archived') c.state = patch.state;
  return true;
}

/** Amazon: read, unread, done (CS-6). */
export function patchAmazonConversation(
  allowed: Set<string>,
  id: string,
  patch: ConversationPatch,
): boolean {
  const c = AMAZON_CONVERSATIONS.find((x) => x.id === id);
  if (!c || !allowed.has(c.companyId)) return false;
  if (patch.unread !== undefined) c.unread = patch.unread ? Math.max(1, c.unread) : 0;
  if (patch.state === 'open' || patch.state === 'done') c.state = patch.state;
  return true;
}
