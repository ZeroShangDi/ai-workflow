import { useEffect, useRef, useState } from 'react';
import { display, formatTime } from '../../../shared/lib/format.js';
export function useLogsPage(props) {
  const { events, data, runId } = props;
  const [source, setSource] = useState('run'),
    [search, setSearch] = useState(''),
    [follow, setFollow] = useState(true),
    [cleared, setCleared] = useState({});
  const output = useRef(null);
  const clearedSeq = (events.at(-1)?.seq || 0) < (cleared[runId] || 0) ? 0 : cleared[runId] || 0;
  const filtered = events.filter(
    e =>
      (!runId || e.runId === runId) &&
      e.seq > clearedSeq &&
      display(e).toLowerCase().includes(search.toLowerCase()),
  );
  const text =
    source === 'session'
      ? (data.status?.snapshot || '')
          .split('\n')
          .filter(line => line.toLowerCase().includes(search.toLowerCase()))
          .join('\n')
      : filtered
          .map(e => `${formatTime(e.at || e.ts)}  ${e.type}  ${JSON.stringify(e.payload || {})}`)
          .join('\n');
  useEffect(() => {
    if (follow && output.current) output.current.scrollTop = output.current.scrollHeight;
  }, [text, follow]);
  return {
    ...props,
    source,
    setSource,
    search,
    setSearch,
    follow,
    setFollow,
    setCleared,
    output,
    filtered,
    text,
  };
}
