/**
 * Reminders and Notes for the client preview (T-0305). PROPOSED SHAPE (mock only), TOOL-1..3.
 * Neither may hold customer details; the UI warns before saving text that looks like a postcode,
 * phone number or email address (TOOL-3). Synthetic content only.
 */
import { DAY, HOUR } from './random.ts';

export type Recurrence = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface Reminder {
  id: string;
  title: string;
  details: string;
  dueAt: string;
  recurrence: Recurrence;
  assignee: string;
  createdBy: string;
  done: boolean;
}

export interface Note {
  id: string;
  title: string;
  body: string;
  shared: boolean;
  owner: string;
  updatedAt: string;
}

const at = (ms: number) => new Date(Date.now() + ms).toISOString();

export const reminders: Reminder[] = [
  {
    id: 'rem_1',
    title: 'Send the VAT figures to the accountant',
    details: 'Jul to Sep quarter, all three companies.',
    dueAt: at(-1 * DAY),
    recurrence: 'none',
    assignee: 'Sam Admin',
    createdBy: 'Sam Admin',
    done: false,
  },
  {
    id: 'rem_2',
    title: 'Call the packaging supplier about the box price',
    details: '',
    dueAt: at(1.5 * HOUR),
    recurrence: 'none',
    assignee: 'Sam Admin',
    createdBy: 'Sam Admin',
    done: false,
  },
  {
    id: 'rem_3',
    title: 'Count the shelf for oversold SKUs',
    details: 'Start with the tea towels.',
    dueAt: at(4 * HOUR),
    recurrence: 'weekly',
    assignee: 'Chris Stock',
    createdBy: 'Sam Admin',
    done: false,
  },
  {
    id: 'rem_4',
    title: 'Check Evri collection is booked',
    details: '',
    dueAt: at(22 * HOUR),
    recurrence: 'daily',
    assignee: 'Pat Packer',
    createdBy: 'Sam Admin',
    done: false,
  },
  {
    id: 'rem_5',
    title: 'Review Christmas ad budgets',
    details: 'Compare with last year before raising.',
    dueAt: at(6 * DAY),
    recurrence: 'none',
    assignee: 'Sam Admin',
    createdBy: 'Sam Admin',
    done: false,
  },
  {
    id: 'rem_6',
    title: 'Quarterly access review',
    details: 'Confirm every user’s tabs and companies.',
    dueAt: at(12 * DAY),
    recurrence: 'monthly',
    assignee: 'Sam Admin',
    createdBy: 'Sam Admin',
    done: false,
  },
  {
    id: 'rem_7',
    title: 'Renew the unit insurance',
    details: '',
    dueAt: at(-3 * DAY),
    recurrence: 'yearly',
    assignee: 'Sam Admin',
    createdBy: 'Sam Admin',
    done: true,
  },
];

export const notes: Note[] = [
  {
    id: 'note_1',
    title: 'Packing rules for glass items',
    body: 'Two layers of bubble wrap.\nUse the double-wall box for anything over 1 kg.\nWrite FRAGILE on two sides.',
    shared: true,
    owner: 'Sam Admin',
    updatedAt: at(-2 * HOUR),
  },
  {
    id: 'note_2',
    title: 'Supplier lead times',
    body: 'Brightwell: 10 working days.\nCalder & Finch: 3 weeks, longer in December.\nOtterly Imports: 6 weeks by sea.',
    shared: true,
    owner: 'Chris Stock',
    updatedAt: at(-1 * DAY),
  },
  {
    id: 'note_3',
    title: 'Ideas for spring range',
    body: 'Linen napkins in four colours.\nSmaller plant pots as a 3-pack.',
    shared: false,
    owner: 'Sam Admin',
    updatedAt: at(-5 * DAY),
  },
  {
    id: 'note_4',
    title: 'Month-end checklist',
    body: 'Match Amazon settlements.\nCheck unpaid bills.\nExport to Xero.',
    shared: true,
    owner: 'Alex Accounts',
    updatedAt: at(-9 * DAY),
  },
];
