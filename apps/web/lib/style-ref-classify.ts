/**
 * On-blur gate for repurpose.classifyStyleReference. Blur fires every time the
 * user tabs through the style-reference field; re-classifying an unchanged URL
 * spends a rate-limited vision call for nothing.
 */
export function shouldClassifyStyleRefOnBlur(value: string, lastClassified: string | null): boolean {
  const v = value.trim();
  if (!/^https?:\/\//i.test(v)) return false;
  return v !== lastClassified;
}
