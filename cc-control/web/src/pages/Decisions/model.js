export function aggregateDecisions(entries = []) {
  const groups = new Map();
  for (const [index, entry] of entries.entries()) {
    const id = entry.decision_id || entry.decisionId;
    const key = `${entry.runStamp || ''}:${id || index}`;
    const previous = groups.get(key) || {
      key,
      id,
      records: [],
    };
    const result = entry.result || entry;
    groups.set(key, {
      ...previous,
      ...entry,
      ...result,
      key,
      id,
      records: [...previous.records, entry],
      status:
        entry.event === 'decision_overridden' ? 'overridden' : entry.status || previous.status,
      completed:
        previous.completed ||
        entry.event === 'decision_completed' ||
        (!entry.event && entry.answer !== undefined),
    });
  }
  return [...groups.values()];
}
