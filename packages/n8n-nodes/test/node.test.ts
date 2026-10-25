import type { IExecuteFunctions, INodeProperties } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import { Dougs } from '../nodes/Dougs/Dougs.node';
import { fields } from '../nodes/Dougs/fields';
import { OPERATIONS } from '../nodes/Dougs/operations';
import { buildProperties } from '../nodes/Dougs/properties';

const shownFor = (properties: INodeProperties[], name: string) =>
  properties.filter((p) => p.name === name).map((p) => p.displayOptions?.show);

describe('buildProperties', () => {
  const properties = buildProperties(OPERATIONS);

  it('shows each field only for the resource and operations that use it', () => {
    expect(shownFor(properties, 'amount')).toEqual([{ resource: ['expense'], operation: ['create'] }]);
    expect(shownFor(properties, 'operationId')).toEqual([
      { resource: ['operation'], operation: ['validate', 'invalidate', 'delete', 'setVat'] },
    ]);
    expect(shownFor(properties, 'q')).toEqual([{ resource: ['operation'], operation: ['list'] }]);
    expect(shownFor(properties, 'from')).toEqual([{ resource: ['operation'], operation: ['list'] }]);
    expect(shownFor(properties, 'companyId')).toHaveLength(4);
  });

  it('lists the operations of every resource', () => {
    const operations = properties.filter((p) => p.name === 'operation').map((p) => p.options?.map((o) => o.name));
    expect(operations).toEqual([
      ['Create'],
      ['Create'],
      ['Validate', 'Invalidate', 'Delete', 'List', 'Set VAT'],
      ['Request Code', 'Verify Code'],
      ['Upload', 'Download'],
    ]);
  });
});

function contextWith(parameters: Record<string, unknown>) {
  return {
    getNodeParameter: (name: string) => parameters[name],
  } as unknown as IExecuteFunctions;
}

describe('fields', () => {
  it('turns the euro amount typed in n8n into integer cents', () => {
    expect(fields.amount.read(contextWith({ amount: 12.3 }), 0)).toBe(1230);
  });

  it('keeps the calendar day of the date picker', () => {
    expect(fields.date.read(contextWith({ date: '2026-03-31T23:30:00' }), 0)).toBe('2026-03-31');
  });

  it('rejects an id that is not a positive integer', () => {
    expect(() => fields.companyId.read(contextWith({ companyId: 'abc' }), 0)).toThrow(/positive integer/);
  });

  it('maps VAT options to the SDK exemption', () => {
    expect(fields.vatExemption.read(contextWith({ vatExemption: 'none' }), 0)).toBe(false);
    expect(fields.vatExemption.read(contextWith({ vatExemption: 'exempt' }), 0)).toBe(true);
  });

  it('accepts each zero-rate VAT reason', () => {
    const reasons = [
      'exemption:outbound:insideEuropeanUnion',
      'exemption:outbound:outsideEuropeanUnion',
      'exemption:outbound:nonApplicable',
      'exemption:outbound:noAccountingDocument',
    ];
    const reasonField = buildProperties(OPERATIONS).find((property) => property.name === 'vatExemptionReason');
    expect(reasonField?.type).toBe('options');
    expect(reasonField?.options?.map((option) => option.value)).toEqual(reasons);
    for (const reason of reasons) {
      expect(fields.vatExemptionReason.read(contextWith({ vatExemptionReason: reason }), 0)).toBe(reason);
    }
  });

  it('treats an empty car as none', () => {
    expect(fields.carId.read(contextWith({ carId: '' }), 0)).toBeUndefined();
  });
});

describe('Dougs node', () => {
  it('describes a node wired to the Dougs credentials', () => {
    const { description } = new Dougs();
    expect(description.credentials).toEqual([{ name: 'dougsLoginApi', required: true }]);
    expect(description.properties[0]?.name).toBe('resource');
  });
});
