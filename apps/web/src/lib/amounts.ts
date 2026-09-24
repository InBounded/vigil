/**
 * An amount typed by the user ("1,000.5") as base units with `decimals` decimals, in exact integer
 * arithmetic (never floating point). `undefined` if it is not a plain positive decimal number or
 * has more decimals than the asset.
 */
export function parseDecimalAmount(text: string, decimals: number): bigint | undefined {
  const cleaned = text.trim().replace(/[,_\s]/g, "");
  const match = /^([0-9]+)(?:\.([0-9]*))?$/.exec(cleaned);
  if (match === null) {
    return undefined;
  }
  const whole = match[1] ?? "0";
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  if (fraction.length > decimals) {
    return undefined;
  }
  const value = BigInt(whole + fraction.padEnd(decimals, "0"));
  return value > 0n ? value : undefined;
}
