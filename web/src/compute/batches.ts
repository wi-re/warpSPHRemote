/** A scheduling target per submission, never a dataset/workload rejection limit.
 * Smaller submissions yield between query ranges without dropping neighbours.
 */
export const CANDIDATES_PER_BATCH = 16_000_000;
export function* queryBatches(
  count: number,
  candidatesPerQuery: number,
  maxWorkgroups: number,
) {
  const target = Math.min(
    maxWorkgroups * 128,
    Math.max(
      1,
      Math.floor(CANDIDATES_PER_BATCH / Math.max(1, candidatesPerQuery)),
    ),
  );
  const size = target >= 128 ? Math.floor(target / 128) * 128 : target;
  for (let offset = 0; offset < count; offset += size)
    yield { offset, count: Math.min(size, count - offset) };
}
