import type { z } from 'zod';

import { DougsSchemaError } from './errors';
import { connection, HttpClient, type ConnectionOptions, type Query } from './http';
import {
  expensePayload,
  mergeDeep,
  mileagePayload,
  uploadMimeType,
  type ExpenseInput,
  type MileageInput,
} from './payloads';
import * as schemas from './schemas';
import { login, type MfaHandler } from './login';
import { SessionAuthenticator, type DougsAuth } from './session';
import { zeroVatStep } from './vat';

/** Read-only company collections confirmed against the live API. */
export const COMPANY_COLLECTIONS = [
  'partners',
  'cars',
  'accounts',
  'attachments',
  'declarations',
  'vendor-invoices',
  'sales-invoices',
  'customers',
  'suppliers',
] as const;

export type CompanyCollection = (typeof COMPANY_COLLECTIONS)[number];

export type CategoryType = 'expense' | 'revenue';

/** Free-text search sent as `q`. Dougs rejects a longer value. */
export const MAX_OPERATION_SEARCH_LENGTH = 200;

export type OperationsQuery = {
  type?: string;
  validated?: boolean;
  /** One calendar day, `YYYY-MM-DD`, sent as the `date` query parameter. */
  date?: string;
  /** Free text, sent as `q`. Combined with the other filters in the same request. */
  q?: string;
  /** Inclusive lower bound, `YYYY-MM-DD`. Applied locally: the API has no range parameter. */
  from?: string;
  /** Inclusive upper bound, `YYYY-MM-DD`. Applied locally, together with `from` and the API filters. */
  to?: string;
};

/** The operations endpoint caps pages at 500 items. */
export const OPERATIONS_PAGE_SIZE = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function present(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

function searchText(q: string | undefined): string | undefined {
  const text = present(q);
  if (text !== undefined && text.length > MAX_OPERATION_SEARCH_LENGTH) {
    throw new RangeError(`q must be at most ${MAX_OPERATION_SEARCH_LENGTH} characters`);
  }
  return text;
}

function assertDateRange(from: string | undefined, to: string | undefined): void {
  if (from !== undefined && to !== undefined && from > to) {
    throw new RangeError(`from must be on or before to, got "${from}" then "${to}"`);
  }
}

function withinDates(date: string, from: string | undefined, to: string | undefined): boolean {
  if (from !== undefined && date < from) {
    return false;
  }
  return to === undefined || date <= to;
}

export type DougsClientOptions = ConnectionOptions & {
  auth: DougsAuth;
  /** Provides the verification code Dougs sends by email when a login needs a second factor. */
  onMfaChallenge?: MfaHandler;
  now?: () => number;
};

export class DougsClient {
  private readonly http: HttpClient;
  private readonly session: SessionAuthenticator;

  constructor(options: DougsClientOptions) {
    const now = options.now ?? Date.now;
    const base = connection(options);
    const anonymous = new HttpClient(base);
    const context = { http: anonymous, now, onMfaChallenge: options.onMfaChallenge };
    this.session = new SessionAuthenticator(options.auth, (email, password) => login(context, email, password), now);
    this.http = new HttpClient({ ...base, auth: this.session });
  }

  sessionToken(): Promise<string> {
    return this.session.token();
  }

  getMe(): Promise<schemas.User> {
    return this.get('/users/me', schemas.userSchema);
  }

  getCompany(companyId: number): Promise<schemas.ApiRecord> {
    return this.get(`/companies/${companyId}`, schemas.recordSchema);
  }

  listCars(companyId: number): Promise<schemas.Car[]> {
    return this.get(`/companies/${companyId}/cars`, schemas.carSchema.array());
  }

  listPartners(companyId: number): Promise<schemas.Partner[]> {
    return this.get(`/companies/${companyId}/partners`, schemas.partnerSchema.array());
  }

  listCategories(companyId: number, type: CategoryType, search?: string): Promise<schemas.Category[]> {
    const query = { type, full: true, search: search || undefined };
    return this.get(`/companies/${companyId}/categories`, schemas.categorySchema.array(), query);
  }

  listCollection(companyId: number, collection: CompanyCollection): Promise<schemas.ApiRecord[]> {
    return this.get(`/companies/${companyId}/${collection}`, schemas.recordSchema.array());
  }

  listVendorInvoices(companyId: number): Promise<schemas.VendorInvoice[]> {
    return this.get(`/companies/${companyId}/vendor-invoices`, schemas.vendorInvoiceSchema.array());
  }

  async *iterateOperations(companyId: number, filter: OperationsQuery = {}): AsyncGenerator<schemas.Operation> {
    const from = present(filter.from);
    const to = present(filter.to);
    assertDateRange(from, to);
    const query = {
      type: present(filter.type),
      validated: filter.validated,
      date: present(filter.date),
      q: searchText(filter.q),
    };
    for (let offset = 0; ; offset += OPERATIONS_PAGE_SIZE) {
      const page = await this.get(`/companies/${companyId}/operations`, schemas.operationSchema.array(), {
        ...query,
        limit: OPERATIONS_PAGE_SIZE,
        offset,
      });
      for (const operation of page) {
        if (withinDates(operation.date, from, to)) {
          yield operation;
        }
      }
      if (page.length < OPERATIONS_PAGE_SIZE) {
        return;
      }
    }
  }

  async listOperations(companyId: number, filter?: OperationsQuery): Promise<schemas.Operation[]> {
    const operations: schemas.Operation[] = [];
    for await (const operation of this.iterateOperations(companyId, filter)) {
      operations.push(operation);
    }
    return operations;
  }

  /**
   * Same paging and filters as {@link listOperations}, but each page is returned
   * as the JSON Dougs sent. A date range is applied locally and combined with
   * the query filters.
   */
  async listOperationsRaw(companyId: number, filter: OperationsQuery = {}): Promise<unknown[]> {
    const from = present(filter.from);
    const to = present(filter.to);
    assertDateRange(from, to);
    const query = {
      type: present(filter.type),
      validated: filter.validated,
      date: present(filter.date),
      q: searchText(filter.q),
    };
    const found: unknown[] = [];
    for (let offset = 0; ; offset += OPERATIONS_PAGE_SIZE) {
      const page = await this.http.json('GET', `/companies/${companyId}/operations`, {
        query: { ...query, limit: OPERATIONS_PAGE_SIZE, offset },
      });
      if (!Array.isArray(page)) {
        throw new RangeError('Operations listing was not a JSON array');
      }
      for (const item of page) {
        if (!from && !to) {
          found.push(item);
          continue;
        }
        const date = isRecord(item) ? item.date : undefined;
        if (typeof date === 'string' && withinDates(date, from, to)) {
          found.push(item);
        }
      }
      if (page.length < OPERATIONS_PAGE_SIZE) {
        return found;
      }
    }
  }

  getOperation(companyId: number, operationId: number): Promise<schemas.Operation> {
    return this.get(`/companies/${companyId}/operations/${operationId}`, schemas.operationSchema);
  }

  registerExpense(companyId: number, expense: ExpenseInput): Promise<schemas.Operation> {
    return this.createOperation(companyId, expensePayload(expense));
  }

  registerMileageAllowance(companyId: number, mileage: MileageInput): Promise<schemas.Operation> {
    return this.createOperation(companyId, mileagePayload(mileage));
  }

  /** Dougs has no PATCH: the full operation is read, merged with `changes` and posted back. */
  async updateOperation(companyId: number, operationId: number, changes: Record<string, unknown>) {
    const path = `/companies/${companyId}/operations/${operationId}`;
    const current = await this.get(path, schemas.recordSchema);
    return this.send('POST', path, schemas.operationSchema, { json: mergeDeep(current, changes), idempotent: true });
  }

  validateOperation(companyId: number, operationId: number): Promise<schemas.Operation> {
    return this.updateOperation(companyId, operationId, { validated: true });
  }

  invalidateOperation(companyId: number, operationId: number): Promise<schemas.Operation> {
    return this.updateOperation(companyId, operationId, { validated: false });
  }

  /**
   * Clears VAT on the publicité line, then stores the zero-rate justification.
   * The two writes are skipped when the line already has that state.
   */
  async setZeroVat(companyId: number, operationId: number, reason: string): Promise<unknown> {
    const path = `/companies/${companyId}/operations/${operationId}`;
    let current = await this.rawRecord(path);
    for (let step = 0; step < 2; step++) {
      const next = zeroVatStep(current, reason);
      if (next.done) {
        break;
      }
      const posted = await this.http.json('POST', path, { json: next.payload, idempotent: true });
      current = isRecord(posted) && posted.id === operationId ? posted : await this.rawRecord(path);
    }
    return this.rawRecord(path);
  }

  async deleteOperation(companyId: number, operationId: number): Promise<void> {
    await this.http.request('DELETE', `/companies/${companyId}/operations/${operationId}`);
  }

  async uploadVendorInvoice(companyId: number, fileName: string, content: Uint8Array): Promise<schemas.VendorInvoice> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(content)], { type: uploadMimeType(fileName) }), fileName);
    const query = { filename: fileName, type: 'attachment' };
    return this.send('POST', `/companies/${companyId}/vendor-invoices`, schemas.vendorInvoiceSchema, { form, query });
  }

  /** Downloads a stored document, given the `filePath` found on invoices and attachments. */
  async downloadFile(filePath: string): Promise<Uint8Array> {
    const response = await this.http.request('GET', filePath);
    return new Uint8Array(await response.arrayBuffer());
  }

  /** Reads a vendor invoice and downloads its file when the path is a Dougs download URL. */
  async downloadVendorInvoice(
    companyId: number,
    invoiceId: string,
  ): Promise<{ invoice: Record<string, unknown>; bytes: Uint8Array }> {
    const invoice = await this.rawRecord(`/companies/${companyId}/vendor-invoices/${encodeURIComponent(invoiceId)}`);
    const filePath = invoice.filePath;
    if (typeof filePath !== 'string' || !filePath.startsWith('/files/') || !filePath.endsWith('/actions/download')) {
      throw new RangeError('Invoice filePath is not a Dougs download path');
    }
    return { invoice, bytes: await this.downloadFile(filePath) };
  }

  private async rawRecord(path: string): Promise<Record<string, unknown>> {
    const body = await this.http.json('GET', path);
    if (!isRecord(body)) {
      throw new RangeError(`Expected a JSON object from ${path}`);
    }
    return body;
  }

  private createOperation(companyId: number, payload: unknown): Promise<schemas.Operation> {
    return this.send('POST', `/companies/${companyId}/operations`, schemas.operationSchema, { json: payload });
  }

  private get<S extends z.ZodType>(path: string, schema: S, query?: Query): Promise<z.infer<S>> {
    return this.send('GET', path, schema, { query });
  }

  private async send<S extends z.ZodType>(
    method: string,
    path: string,
    schema: S,
    opts: Parameters<HttpClient['json']>[2],
  ): Promise<z.infer<S>> {
    const result = schema.safeParse(await this.http.json(method, path, opts));
    if (!result.success) {
      throw new DougsSchemaError(path, result.error.issues);
    }
    return result.data;
  }
}
