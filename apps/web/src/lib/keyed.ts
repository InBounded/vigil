/**
 * Stable React keys for a list that may repeat values: each item's own identity, with a counter
 * appended only when the same identity occurs again.
 */
export function keyed<T>(
  items: readonly T[],
  identity: (item: T) => string,
): { readonly key: string; readonly item: T }[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = identity(item);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return { item, key: count === 0 ? base : `${base}#${count}` };
  });
}
