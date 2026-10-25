import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';

import { requestLoginCode, verifyLoginCode, type DougsClient } from '@plokkke/dougs-compta';

import { authFrom } from '../../credentials/DougsLoginApi.credentials';
import { CREDENTIALS_NAME } from './client';
import { fields, type FieldName } from './fields';

/** Invoice bytes plus the metadata returned by the vendor-invoice GET. */
export class DownloadedFile {
  constructor(
    readonly metadata: Record<string, unknown>,
    readonly propertyName: string,
    readonly fileName: string,
    readonly mimeType: string,
    readonly data: Uint8Array,
  ) {}
}

export const RESOURCES = [
  { name: 'Expense', value: 'expense' },
  { name: 'Mileage Allowance', value: 'mileageAllowance' },
  { name: 'Operation', value: 'operation' },
  { name: 'Session', value: 'session' },
  { name: 'Vendor Invoice', value: 'vendorInvoice' },
] as const;

export type Resource = (typeof RESOURCES)[number]['value'];

export type OperationDefinition = {
  resource: Resource;
  value: string;
  name: string;
  action: string;
  fields: FieldName[];
  run: (client: DougsClient, context: IExecuteFunctions, item: number) => Promise<unknown>;
};

const companyAndOperation = (context: IExecuteFunctions, item: number) =>
  [fields.companyId.read(context, item), fields.operationId.read(context, item)] as const;

const BOOKKEEPING_OPERATIONS: OperationDefinition[] = [
  {
    resource: 'expense',
    value: 'create',
    name: 'Create',
    action: 'Create an expense',
    fields: ['companyId', 'date', 'memo', 'amount', 'categoryId', 'partnerId', 'vatExemption'],
    run: (client, context, item) =>
      client.registerExpense(fields.companyId.read(context, item), {
        date: fields.date.read(context, item),
        memo: fields.memo.read(context, item),
        amountCents: fields.amount.read(context, item),
        categoryId: fields.categoryId.read(context, item),
        partnerId: fields.partnerId.read(context, item),
        vatExemption: fields.vatExemption.read(context, item),
      }),
  },
  {
    resource: 'mileageAllowance',
    value: 'create',
    name: 'Create',
    action: 'Create a mileage allowance',
    fields: ['companyId', 'date', 'memo', 'distance', 'carId'],
    run: (client, context, item) =>
      client.registerMileageAllowance(fields.companyId.read(context, item), {
        date: fields.date.read(context, item),
        memo: fields.memo.read(context, item),
        distanceKm: fields.distance.read(context, item),
        carId: fields.carId.read(context, item),
      }),
  },
  {
    resource: 'operation',
    value: 'validate',
    name: 'Validate',
    action: 'Validate an operation',
    fields: ['companyId', 'operationId'],
    run: (client, context, item) => client.validateOperation(...companyAndOperation(context, item)),
  },
  {
    resource: 'operation',
    value: 'invalidate',
    name: 'Invalidate',
    action: 'Invalidate an operation',
    fields: ['companyId', 'operationId'],
    run: (client, context, item) => client.invalidateOperation(...companyAndOperation(context, item)),
  },
  {
    resource: 'operation',
    value: 'delete',
    name: 'Delete',
    action: 'Delete an operation',
    fields: ['companyId', 'operationId'],
    run: async (client, context, item) => {
      const [companyId, operationId] = companyAndOperation(context, item);
      await client.deleteOperation(companyId, operationId);
      return { deleted: true, operationId };
    },
  },
  {
    resource: 'operation',
    value: 'list',
    name: 'List',
    action: 'List operations',
    fields: ['companyId', 'q', 'type', 'validated', 'filterDate', 'from', 'to'],
    run: (client, context, item) =>
      client.listOperationsRaw(fields.companyId.read(context, item), {
        q: fields.q.read(context, item),
        type: fields.type.read(context, item),
        validated: fields.validated.read(context, item),
        date: fields.filterDate.read(context, item),
        from: fields.from.read(context, item),
        to: fields.to.read(context, item),
      }),
  },
  {
    resource: 'operation',
    value: 'setVat',
    name: 'Set VAT',
    action: 'Set a zero VAT rate and its reason',
    fields: ['companyId', 'operationId', 'vatExemptionReason'],
    run: (client, context, item) => {
      const [companyId, operationId] = companyAndOperation(context, item);
      return client.setZeroVat(companyId, operationId, fields.vatExemptionReason.read(context, item));
    },
  },
  {
    resource: 'vendorInvoice',
    value: 'upload',
    name: 'Upload',
    action: 'Upload a vendor invoice',
    fields: ['companyId', 'binaryPropertyName'],
    run: async (client, context, item) => {
      const property = fields.binaryPropertyName.read(context, item);
      const binary = context.helpers.assertBinaryData(item, property);
      const content = await context.helpers.getBinaryDataBuffer(item, property);
      return client.uploadVendorInvoice(
        fields.companyId.read(context, item),
        binary.fileName ?? 'invoice.pdf',
        content,
      );
    },
  },
  {
    resource: 'vendorInvoice',
    value: 'download',
    name: 'Download',
    action: 'Download a vendor invoice',
    fields: ['companyId', 'vendorInvoiceId', 'outputBinary'],
    run: async (client, context, item) => {
      const file = await client.downloadVendorInvoice(
        fields.companyId.read(context, item),
        fields.vendorInvoiceId.read(context, item),
      );
      const fileName = typeof file.invoice.fileName === 'string' ? file.invoice.fileName : 'invoice';
      const mimeType = typeof file.invoice.fileType === 'string' ? file.invoice.fileType : 'application/octet-stream';
      return new DownloadedFile(file.invoice, fields.outputBinary.read(context, item), fileName, mimeType, file.bytes);
    },
  },
];

const isoDate = (epochMs?: number) => (epochMs === undefined ? null : new Date(epochMs).toISOString());

/** Lets a workflow complete the email verification Dougs requires at login, then store the resulting session. */
const SESSION_OPERATIONS: OperationDefinition[] = [
  {
    resource: 'session',
    value: 'requestCode',
    name: 'Request Code',
    action: 'Request a login code by email',
    fields: [],
    run: async (_client, context) => {
      const { email, password } = authFrom(await context.getCredentials(CREDENTIALS_NAME));
      const request = await requestLoginCode({ email, password });
      return { ...request, requestedAt: new Date().toISOString(), expiresAt: isoDate(request.expiresAt) };
    },
  },
  {
    resource: 'session',
    value: 'verifyCode',
    name: 'Verify Code',
    action: 'Verify the login code received by email',
    fields: ['pendingSessionToken', 'code'],
    run: async (_client, context, item) => {
      const pending = fields.pendingSessionToken.read(context, item);
      const session = await verifyLoginCode(pending, fields.code.read(context, item));
      return { sessionToken: session.token, expiresAt: isoDate(session.expiresAt) };
    },
  },
];

export const OPERATIONS = [...BOOKKEEPING_OPERATIONS, ...SESSION_OPERATIONS];

export function findOperation(resource: string, operation: string): OperationDefinition | undefined {
  return OPERATIONS.find((definition) => definition.resource === resource && definition.value === operation);
}

export const toJson = (value: unknown): IDataObject => JSON.parse(JSON.stringify(value ?? {})) as IDataObject;
