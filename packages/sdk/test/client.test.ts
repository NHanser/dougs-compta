import { describe, expect, it } from 'vitest';

import { DougsClient, OPERATIONS_PAGE_SIZE } from '../src/client';
import { ZERO_VAT_REASONS } from '../src/vat';
import { DougsSchemaError } from '../src/errors';
import { answeringLoginProbe, json, noSleep, scriptedFetch, status, type Reply } from './fake-fetch';
import { operation, user, vendorInvoice } from './fixtures';

const loginReply = () =>
  new Response('{}', { headers: [['Set-Cookie', 'auth_session=s3ss10n; Path=/; Max-Age=2592000; HttpOnly']] });

function dougs(...replies: Reply[]) {
  const api = scriptedFetch(...replies);
  const client = new DougsClient({
    auth: { email: 'jane@example.com', password: 'secret' },
    baseUrl: 'https://dougs.test',
    fetch: answeringLoginProbe(api.fetch, user),
    sleep: noSleep,
  });
  return { client, requests: api.requests };
}

describe('DougsClient', () => {
  it('logs in with the credentials, then authenticates requests with the session cookie', async () => {
    const { client, requests } = dougs(loginReply(), json(user));

    await expect(client.getMe()).resolves.toMatchObject({ company: { id: 42 }, locale: 'fr' });
    expect(requests[0]).toMatchObject({ method: 'POST', body: { email: 'jane@example.com', password: 'secret' } });
    expect(requests[1]?.headers.Cookie).toBe('auth_session=s3ss10n');
  });

  it('pages through operations until a short page', async () => {
    const full = Array.from({ length: OPERATIONS_PAGE_SIZE }, (_, i) => operation(i));
    const { client, requests } = dougs(loginReply(), json(full), json([operation(1000), operation(1001)]));

    const operations = await client.listOperations(42, { validated: false });

    expect(operations).toHaveLength(OPERATIONS_PAGE_SIZE + 2);
    expect(requests.slice(1).map((r) => r.url.search)).toEqual([
      '?validated=false&limit=500&offset=0',
      '?validated=false&limit=500&offset=500',
    ]);
  });

  it('keeps fields it does not model, so exports stay lossless', async () => {
    const { client } = dougs(loginReply(), json([operation(1)]));

    const [first] = await client.listOperations(42);
    expect(first).toHaveProperty('transactionId', 901);
  });

  it('fails fast with the offending field when the API changes shape', async () => {
    const { client } = dougs(loginReply(), json([operation(1, { amount: '12,50' })]));

    const error = await client.listOperations(42).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DougsSchemaError);
    expect((error as Error).message).toContain('0.amount');
  });

  it('updates an operation by merging changes into its current state', async () => {
    const { client, requests } = dougs(loginReply(), json(operation(9)), json(operation(9, { validated: true })));

    await expect(client.validateOperation(42, 9)).resolves.toMatchObject({ validated: true });
    expect(requests[2]).toMatchObject({ method: 'POST', body: { ...operation(9), validated: true } });
  });

  it('registers an expense from an integer cent amount', async () => {
    const { client, requests } = dougs(loginReply(), json(operation(3)));

    await client.registerExpense(42, { date: '2026-03-31', amountCents: 1250, categoryId: 77, partnerId: 5 });
    expect(requests[1]?.body).toMatchObject({ type: 'expense', amount: 12.5 });
  });

  it('uploads a vendor invoice as multipart form data', async () => {
    const { client, requests } = dougs(loginReply(), json(vendorInvoice));

    await expect(client.uploadVendorInvoice(42, 'invoice.pdf', new Uint8Array([37, 80]))).resolves.toMatchObject({
      fileName: 'invoice.pdf',
    });
    expect(requests[1]?.body).toBeInstanceOf(FormData);
    expect(requests[1]?.url.searchParams.get('filename')).toBe('invoice.pdf');
  });

  it('rejects an unsupported invoice before any network call', async () => {
    const { client, requests } = dougs();

    await expect(client.uploadVendorInvoice(42, 'notes.txt', new Uint8Array())).rejects.toThrow(RangeError);
    expect(requests).toHaveLength(0);
  });

  it('downloads a stored file as bytes', async () => {
    const { client } = dougs(loginReply(), new Response(new Uint8Array([1, 2, 3])));

    await expect(client.downloadFile(vendorInvoice.filePath)).resolves.toEqual(new Uint8Array([1, 2, 3]));
  });

  it('logs in again when the API revokes the session', async () => {
    const { client, requests } = dougs(loginReply(), status(401), loginReply(), json(user));

    await expect(client.getMe()).resolves.toMatchObject({ id: 1 });
    expect(requests.map((r) => r.url.pathname)).toEqual([
      '/auth/api/login',
      '/users/me',
      '/auth/api/login',
      '/users/me',
    ]);
  });
});

describe('DougsClient endpoints', () => {
  const person = { id: 1, firstName: 'Jane', lastName: 'Doe', fullName: 'Jane Doe', initials: 'JD' };
  const cases: [string, (client: DougsClient) => Promise<unknown>, unknown, string][] = [
    ['getCompany', (c) => c.getCompany(42), { id: 42 }, 'GET /companies/42'],
    [
      'listCars',
      (c) => c.listCars(42),
      [{ id: 1, name: 'Car', content: { licensePlate: 'AB-123-CD' }, partner: { naturalPerson: person } }],
      'GET /companies/42/cars',
    ],
    [
      'listPartners',
      (c) => c.listPartners(42),
      [{ id: 5, position: 'manager', naturalPerson: person }],
      'GET /companies/42/partners',
    ],
    [
      'listCategories',
      (c) => c.listCategories(42, 'expense', 'train'),
      [{ id: 77, wording: 'Train', keywords: [], description: '' }],
      'GET /companies/42/categories?type=expense&full=true&search=train',
    ],
    [
      'listCollection',
      (c) => c.listCollection(42, 'declarations'),
      [{ id: 1, type: 'vat' }],
      'GET /companies/42/declarations',
    ],
    ['listVendorInvoices', (c) => c.listVendorInvoices(42), [vendorInvoice], 'GET /companies/42/vendor-invoices'],
    ['getOperation', (c) => c.getOperation(42, 9), operation(9), 'GET /companies/42/operations/9'],
    [
      'registerMileageAllowance',
      (c) => c.registerMileageAllowance(42, { date: '2026-03-31', distanceKm: 38 }),
      operation(9),
      'POST /companies/42/operations',
    ],
    ['deleteOperation', (c) => c.deleteOperation(42, 9), undefined, 'DELETE /companies/42/operations/9'],
  ];

  it.each(cases)('%s calls the matching endpoint', async (_, call, body, expected) => {
    const { client, requests } = dougs(loginReply(), body === undefined ? status(204) : json(body));

    await call(client);
    const request = requests[1];
    expect(`${request?.method} ${request?.url.pathname}${request?.url.search}`).toBe(expected);
  });

  it('invalidates an operation', async () => {
    const { client, requests } = dougs(loginReply(), json(operation(9, { validated: true })), json(operation(9)));

    await client.invalidateOperation(42, 9);
    expect(requests[2]?.body).toMatchObject({ validated: false });
  });

  it('exposes the session token for callers that authenticate other tools', async () => {
    const { client } = dougs(loginReply());

    await expect(client.sessionToken()).resolves.toBe('s3ss10n');
  });

  it('lists raw operations with every optional filter combined', async () => {
    const inside = { id: 1, date: '2026-04-02', wording: 'ads', extra: true };
    const outside = { id: 2, date: '2026-01-01', wording: 'ads' };
    const { client, requests } = dougs(loginReply(), json([inside, outside, { id: 3 }]));

    await expect(
      client.listOperationsRaw(42, {
        q: 'ads',
        type: 'expense',
        validated: false,
        date: '2026-04-02',
        from: '2026-04-01',
        to: '2026-04-30',
      }),
    ).resolves.toEqual([inside]);
    expect(requests[1]?.url.search).toBe('?type=expense&validated=false&date=2026-04-02&q=ads&limit=500&offset=0');
  });

  it('lists every page with no filter when the optional fields are empty', async () => {
    const { client, requests } = dougs(loginReply(), json([{ id: 1 }, { id: 2, deleted: true }]));

    await expect(client.listOperationsRaw(42, { q: '  ', from: '', to: '' })).resolves.toEqual([
      { id: 1 },
      { id: 2, deleted: true },
    ]);
    expect(requests[1]?.url.search).toBe('?limit=500&offset=0');
  });

  it('refuses a search longer than 200 characters', async () => {
    const { client, requests } = dougs();

    await expect(client.listOperationsRaw(42, { q: 'a'.repeat(201) })).rejects.toThrow(RangeError);
    expect(requests).toHaveLength(0);
  });

  it.each(ZERO_VAT_REASONS)('clears VAT on the publicité line, then stores %s', async (reason) => {
    const initial = operation(9, {
      breakdowns: [
        {
          id: 7,
          amount: 12.5,
          categoryWording: 'Publicité et référencement',
          isCounterpart: false,
          vatRate: 0.2,
          vatAmount: 2,
          vatAmountWithRecoverageRate: 2,
          isVatAmountManuallyModified: false,
          manualVatAmount: null,
          associationData: { vatExemptionReason: 'old' },
        },
        { id: 8, isCounterpart: true, categoryWording: 'Publicité et référencement' },
      ],
    });
    const { client, requests } = dougs(
      loginReply(),
      json(initial),
      (request) => json(request.body),
      (request) => json(request.body),
      json({ id: 9, stored: true }),
    );

    await expect(client.setZeroVat(42, 9, reason)).resolves.toMatchObject({
      stored: true,
    });
    const posts = requests.filter(
      (request) => request.method === 'POST' && request.url.pathname.endsWith('/operations/9'),
    );
    const firstLine = publicite(posts[0]?.body);
    expect(firstLine).toMatchObject({
      vatRate: null,
      vatAmount: 0,
      vatAmountWithRecoverageRate: 0,
      isVatAmountManuallyModified: true,
      manualVatAmount: 0,
    });
    expect(firstLine.associationData).not.toHaveProperty('vatExemptionReason');
    expect(publicite(posts[1]?.body).associationData).toMatchObject({
      vatExemptionReason: reason,
    });
  });

  it('skips the VAT writes when the line already has the reason', async () => {
    const done = operation(9, {
      breakdowns: [
        {
          id: 7,
          categoryWording: 'Publicité et référencement',
          isCounterpart: false,
          vatRate: null,
          vatAmount: 0,
          vatAmountWithRecoverageRate: 0,
          isVatAmountManuallyModified: true,
          manualVatAmount: 0,
          associationData: { vatExemptionReason: 'exemption:outbound:insideEuropeanUnion' },
        },
      ],
    });
    const { client, requests } = dougs(loginReply(), json(done), json(done));

    await client.setZeroVat(42, 9, 'exemption:outbound:insideEuropeanUnion');
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('downloads a vendor invoice through its file path', async () => {
    const { client, requests } = dougs(loginReply(), json(vendorInvoice), new Response(new Uint8Array([9, 8])));

    await expect(client.downloadVendorInvoice(42, vendorInvoice.id)).resolves.toMatchObject({
      invoice: { fileName: 'invoice.pdf' },
      bytes: new Uint8Array([9, 8]),
    });
    expect(requests.map((request) => request.url.pathname)).toEqual([
      '/auth/api/login',
      `/companies/42/vendor-invoices/${vendorInvoice.id}`,
      vendorInvoice.filePath,
    ]);
  });

  it('refuses a vendor invoice whose file path is not a download action', async () => {
    const { client } = dougs(loginReply(), json({ ...vendorInvoice, filePath: 'https://example.invalid/file' }));

    await expect(client.downloadVendorInvoice(42, vendorInvoice.id)).rejects.toThrow(RangeError);
  });
});

function publicite(body: unknown) {
  const breakdowns = (body as { breakdowns?: Array<Record<string, unknown>> }).breakdowns ?? [];
  const line = breakdowns.find(
    (item) => item.isCounterpart !== true && item.categoryWording === 'Publicité et référencement',
  );
  if (!line) {
    throw new Error('missing publicité line');
  }
  return line as { associationData?: Record<string, unknown> };
}
