/**
 * Merge by Excalidraw version/nonce, retaining deletion tombstones so a stale
 * participant cannot resurrect an element. Fractional indices retain z-order.
 * @template {{ id: string, version?: number, versionNonce?: number, index?: string | null }} T
 * @param {readonly T[]} local
 * @param {readonly T[]} remote
 * @returns {T[]}
 */
export function mergeElements(local, remote) {
  const merged = new Map(local.map((element) => [element.id, element]));
  for (const element of remote) {
    const previous = merged.get(element.id);
    if (
      !previous ||
      (element.version ?? 0) > (previous.version ?? 0) ||
      ((element.version ?? 0) === (previous.version ?? 0) &&
        (element.versionNonce ?? 0) < (previous.versionNonce ?? 0))
    ) {
      merged.set(element.id, element);
    }
  }
  return [...merged.values()].sort((a, b) => {
    const left = a.index || a.id;
    const right = b.index || b.id;
    return left < right ? -1 : left > right ? 1 : a.id.localeCompare(b.id);
  });
}
