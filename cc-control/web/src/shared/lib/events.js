export function mergeEvents(previous, incoming) {
  const bySeq = new Map(previous.map(e => [e.seq, e]));
  for (const event of incoming) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq).slice(-3000);
}
