import {
  NodeConnectionTypes,
  NodeOperationError,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
  type INodeTypeDescription,
} from 'n8n-workflow';

import type { DougsClient } from '@plokkke/dougs-compta';

import { CREDENTIALS_NAME, dougsClient } from './client';
import { toNodeError } from './errors';
import { listSearch } from './lookups';
import { DownloadedFile, findOperation, OPERATIONS, toJson, type OperationDefinition } from './operations';
import { buildProperties } from './properties';

export class Dougs implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Dougs',
    name: 'dougs',
    icon: { light: 'file:../../icons/dougs.png', dark: 'file:../../icons/dougs.png' },
    group: ['transform'],
    version: 1,
    subtitle: '={{ $parameter["operation"] + ": " + $parameter["resource"] }}',
    description: 'List operations, record expenses and invoices, and set a zero VAT rate in Dougs',
    defaults: { name: 'Dougs' },
    usableAsTool: true,
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: CREDENTIALS_NAME, required: true }],
    properties: buildProperties(OPERATIONS),
  };

  methods = { listSearch };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const resource = this.getNodeParameter('resource', 0) as string;
    const operation = this.getNodeParameter('operation', 0) as string;
    const definition = findOperation(resource, operation);
    if (!definition) {
      throw new NodeOperationError(this.getNode(), `Unsupported operation "${operation}" on "${resource}"`);
    }
    const client = await dougsClient(this);
    const output: INodeExecutionData[] = [];
    for (let item = 0; item < this.getInputData().length; item++) {
      output.push(...(await runItem(this, client, definition, item)));
    }
    return [output];
  }
}

async function runItem(
  context: IExecuteFunctions,
  client: DougsClient,
  definition: OperationDefinition,
  item: number,
): Promise<INodeExecutionData[]> {
  try {
    const value = await definition.run(client, context, item);
    if (value instanceof DownloadedFile) {
      const binary = await context.helpers.prepareBinaryData(Buffer.from(value.data), value.fileName, value.mimeType);
      return [{ json: toJson(value.metadata), binary: { [value.propertyName]: binary }, pairedItem: { item } }];
    }
    const rows = Array.isArray(value) ? value : [value];
    return rows.map((row) => ({ json: toJson(row), pairedItem: { item } }));
  } catch (error) {
    if (!context.continueOnFail()) {
      throw toNodeError(context.getNode(), error, item);
    }
    return [{ json: { error: (error as Error).message }, pairedItem: { item } }];
  }
}
