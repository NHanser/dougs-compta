import type { IExecuteFunctions, INodeProperties } from 'n8n-workflow';

import {
  DEFAULT_ZERO_VAT_REASON,
  eurosToCents,
  MAX_OPERATION_SEARCH_LENGTH,
  VAT_EXEMPTION_REASONS,
  ZERO_VAT_REASONS,
  type VatExemptionReason,
  type ZeroVatReason,
} from '@plokkke/dougs-compta';

export type FieldProperty = Omit<INodeProperties, 'displayOptions'>;

export type Field<T> = { property: FieldProperty; read: (context: IExecuteFunctions, item: number) => T };

const raw = (context: IExecuteFunctions, name: string, item: number): unknown =>
  context.getNodeParameter(name, item, undefined, { extractValue: true });

function field<T>(property: FieldProperty, parse: (value: unknown) => T): Field<T> {
  return { property, read: (context, item) => parse(raw(context, property.name, item)) };
}

function toId(name: string) {
  return (value: unknown): number => {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new RangeError(`${name} must be a positive integer id, got "${String(value)}"`);
    }
    return id;
  };
}

function locator(name: string, displayName: string, searchListMethod: string, searchable = false): FieldProperty {
  return {
    displayName,
    name,
    type: 'resourceLocator',
    default: { mode: 'list', value: '' },
    required: true,
    modes: [
      { displayName: 'From List', name: 'list', type: 'list', typeOptions: { searchListMethod, searchable } },
      { displayName: 'By ID', name: 'id', type: 'string', placeholder: 'e.g. 12345' },
    ],
  };
}

/** Keeps the calendar day typed in the n8n date picker, whatever the timezone of the instance. */
const toCalendarDate = (value: unknown): string => String(value ?? '').slice(0, 10);

const optionalText = (value: unknown): string | undefined => {
  const text = String(value ?? '').trim();
  return text || undefined;
};

const optionalDate = (value: unknown): string | undefined => {
  const text = optionalText(value);
  return text === undefined ? undefined : text.slice(0, 10);
};

const VAT_OPTIONS = [
  { name: 'No Exemption', value: 'none' },
  { name: 'Exempt', value: 'exempt' },
  { name: 'Purchase Outside EU', value: VAT_EXEMPTION_REASONS[0] },
];

function toVatExemption(value: unknown): boolean | VatExemptionReason {
  if (value === 'none' || value === undefined) {
    return false;
  }
  return value === 'exempt' ? true : (value as VatExemptionReason);
}

export const fields = {
  companyId: field(locator('companyId', 'Company', 'getCompanies'), toId('Company')),
  date: field({ displayName: 'Date', name: 'date', type: 'dateTime', default: '', required: true }, toCalendarDate),
  memo: field({ displayName: 'Memo', name: 'memo', type: 'string', default: '' }, (v) => String(v ?? '') || undefined),
  amount: field(
    {
      displayName: 'Amount (EUR)',
      name: 'amount',
      type: 'number',
      default: 0,
      required: true,
      typeOptions: { numberPrecision: 2 },
    },
    (v) => eurosToCents(Number(v)),
  ),
  categoryId: field(locator('categoryId', 'Category', 'getCategories', true), toId('Category')),
  partnerId: field(locator('partnerId', 'Partner', 'getPartners'), toId('Partner')),
  vatExemption: field(
    { displayName: 'VAT Exemption', name: 'vatExemption', type: 'options', default: 'none', options: VAT_OPTIONS },
    toVatExemption,
  ),
  distance: field({ displayName: 'Distance (Km)', name: 'distance', type: 'number', default: 0, required: true }, (v) =>
    Math.round(Number(v)),
  ),
  carId: field({ ...locator('carId', 'Car', 'getCars'), required: false }, (v) => (v ? toId('Car')(v) : undefined)),
  operationId: field(
    { displayName: 'Operation ID', name: 'operationId', type: 'number', default: 0, required: true },
    toId('Operation ID'),
  ),
  pendingSessionToken: field(
    {
      displayName: 'Pending Session Token',
      name: 'pendingSessionToken',
      type: 'string',
      typeOptions: { password: true },
      default: '={{ $json.sessionToken }}',
      required: true,
      hint: 'The session token returned by Request Code',
    },
    (v) => String(v ?? ''),
  ),
  code: field(
    {
      displayName: 'Code',
      name: 'code',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'e.g. 517261',
      hint: 'The code received by email',
    },
    (v) => String(v ?? ''),
  ),
  q: field(
    {
      displayName: 'Search',
      name: 'q',
      type: 'string',
      default: '',
      placeholder: 'e.g. invoice, supplier, FaceBK',
      hint: `Free text sent as q, up to ${MAX_OPERATION_SEARCH_LENGTH} characters. Leave empty to skip.`,
    },
    (value) => {
      const text = optionalText(value);
      if (text !== undefined && text.length > MAX_OPERATION_SEARCH_LENGTH) {
        throw new RangeError(`Search must be at most ${MAX_OPERATION_SEARCH_LENGTH} characters`);
      }
      return text;
    },
  ),
  type: field(
    {
      displayName: 'Type',
      name: 'type',
      type: 'string',
      default: '',
      hint: 'Optional operation type. Leave empty to skip.',
    },
    optionalText,
  ),
  validated: field(
    {
      displayName: 'Validated',
      name: 'validated',
      type: 'options',
      default: 'any',
      options: [
        { name: 'Any', value: 'any' },
        { name: 'Validated', value: 'true' },
        { name: 'Not Validated', value: 'false' },
      ],
    },
    (value): boolean | undefined => (value === 'true' ? true : value === 'false' ? false : undefined),
  ),
  filterDate: field(
    {
      displayName: 'Date',
      name: 'filterDate',
      type: 'dateTime',
      default: '',
      hint: 'Optional single day, sent as date. Leave empty to skip.',
    },
    optionalDate,
  ),
  from: field(
    {
      displayName: 'From',
      name: 'from',
      type: 'dateTime',
      default: '',
      hint: 'Optional start of a date range, inclusive. Applied together with the other filters.',
    },
    optionalDate,
  ),
  to: field(
    {
      displayName: 'To',
      name: 'to',
      type: 'dateTime',
      default: '',
      hint: 'Optional end of a date range, inclusive.',
    },
    optionalDate,
  ),
  vatExemptionReason: field(
    {
      displayName: 'Zero VAT Reason',
      name: 'vatExemptionReason',
      type: 'options',
      default: DEFAULT_ZERO_VAT_REASON,
      required: true,
      options: [
        { name: 'Inside EU Purchase at 20%', value: 'exemption:outbound:insideEuropeanUnion' },
        { name: 'Outside EU Purchase', value: 'exemption:outbound:outsideEuropeanUnion' },
        { name: 'VAT Not Applicable', value: 'exemption:outbound:nonApplicable' },
        { name: 'Lost Supporting Documents', value: 'exemption:outbound:noAccountingDocument' },
      ],
    },
    (value): ZeroVatReason => {
      const text = String(value ?? '');
      if (!(ZERO_VAT_REASONS as readonly string[]).includes(text)) {
        throw new RangeError(`Unknown zero VAT reason "${text}"`);
      }
      return text as ZeroVatReason;
    },
  ),
  vendorInvoiceId: field(
    {
      displayName: 'Vendor Invoice ID',
      name: 'vendorInvoiceId',
      type: 'string',
      default: '',
      required: true,
    },
    (value) => {
      const id = String(value ?? '').trim();
      if (!id) {
        throw new RangeError('Vendor Invoice ID is required');
      }
      return id;
    },
  ),
  outputBinary: field(
    {
      displayName: 'Output Binary Field',
      name: 'outputBinary',
      type: 'string',
      default: 'data',
      required: true,
      hint: 'Field that receives the downloaded invoice file',
    },
    (value) => {
      const name = String(value ?? '').trim();
      if (!name) {
        throw new RangeError('Output binary field is required');
      }
      return name;
    },
  ),
  binaryPropertyName: field(
    {
      displayName: 'Input Binary Field',
      name: 'binaryPropertyName',
      type: 'string',
      default: 'data',
      required: true,
      hint: 'The name of the input binary field containing the invoice file',
    },
    (v) => String(v),
  ),
};

export type FieldName = keyof typeof fields;
