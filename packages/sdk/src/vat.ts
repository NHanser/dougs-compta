/** The accounting line the zero-rate write is applied to, and the justifications Dougs offers. */
export const PUBLICITE_CATEGORY = 'Publicité et référencement';
export const ZERO_VAT_REASONS = [
  'exemption:outbound:insideEuropeanUnion',
  'exemption:outbound:outsideEuropeanUnion',
  'exemption:outbound:nonApplicable',
  'exemption:outbound:noAccountingDocument',
] as const;
export type ZeroVatReason = (typeof ZERO_VAT_REASONS)[number];
export const DEFAULT_ZERO_VAT_REASON: ZeroVatReason = 'exemption:outbound:insideEuropeanUnion';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isZero(value: unknown): boolean {
  return typeof value === 'number' && value === 0;
}

/** The single non-counterpart line categorized as publicité. */
export function publiciteLine(operation: JsonObject): JsonObject {
  const breakdowns = Array.isArray(operation.breakdowns) ? operation.breakdowns : [];
  const lines = breakdowns.filter(
    (line): line is JsonObject =>
      isObject(line) && line.isCounterpart !== true && line.categoryWording === PUBLICITE_CATEGORY,
  );
  const [line] = lines;
  if (lines.length !== 1 || line === undefined) {
    throw new RangeError(`Expected one "${PUBLICITE_CATEGORY}" line, found ${lines.length}`);
  }
  return line;
}

function exemptionReason(line: JsonObject): unknown {
  return isObject(line.associationData) ? line.associationData.vatExemptionReason : undefined;
}

/**
 * Next POST body for a zero-rate write, or `done` when the line already has
 * a null rate, a manual zero amount and the requested justification.
 * The reason is written only after the rate has been cleared.
 */
export function zeroVatStep(
  operation: JsonObject,
  reason: string,
): { done: true } | { done: false; payload: JsonObject } {
  const text = reason.trim();
  if (!text) {
    throw new RangeError('Zero VAT reason is required');
  }
  const line = publiciteLine(operation);
  const rateCleared =
    line.vatRate == null &&
    line.isVatAmountManuallyModified === true &&
    isZero(line.vatAmount) &&
    isZero(line.vatAmountWithRecoverageRate) &&
    isZero(line.manualVatAmount);
  if (rateCleared && exemptionReason(line) === text) {
    return { done: true };
  }

  const payload = structuredClone(operation);
  const editable = publiciteLine(payload);
  if (!rateCleared) {
    editable.vatRate = null;
    editable.vatAmount = 0;
    editable.vatAmountWithRecoverageRate = 0;
    editable.isVatAmountManuallyModified = true;
    editable.manualVatAmount = 0;
    if (isObject(editable.associationData)) {
      delete editable.associationData.vatExemptionReason;
    }
  } else {
    const association = isObject(editable.associationData) ? editable.associationData : {};
    editable.associationData = association;
    association.vatExemptionReason = text;
  }
  payload.updatedBreakdown = structuredClone(editable);
  return { done: false, payload };
}
