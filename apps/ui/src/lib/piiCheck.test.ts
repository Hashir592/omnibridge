import { describe, expect, it } from 'vitest';
import { findPersonalDetails } from './piiCheck.ts';

describe('the customer-details check for reminders and notes', () => {
  it('[TOOL-3] finds postcodes, phone numbers and email addresses', () => {
    expect(findPersonalDetails('Call 07700 900123 about the order')).toEqual(['a phone number']);
    expect(findPersonalDetails('Ship to G2 4AB')).toEqual(['a postcode']);
    expect(findPersonalDetails('Reply to buyer@example.com')).toEqual(['an email address']);
  });

  it('[TOOL-3] passes ordinary text', () => {
    expect(findPersonalDetails('Count the shelf for SKU CB-OAK-L104 on Monday')).toEqual([]);
  });
});
