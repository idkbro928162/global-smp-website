/** Stable element id for a form field name ("features.0.title" → "field-features-0-title"). */
export function fieldId(name: string): string {
  return `field-${name.replace(/[^A-Za-z0-9_-]+/g, '-')}`;
}
