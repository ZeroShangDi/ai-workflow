import { useEffect, useRef, useState } from 'react';
import { display, formatTime } from '@/shared/lib/format.js';
import { API } from '@/shared/api/index.js';
export function useLogsPage(props) {
  const { events, data, runId, client } = props;
  const [source, setSource] = useState('run'),
    [search, setSearch] = useState(''),
    [follow, setFollow] = useState(true),
    [cleared, setCleared] = useState({}),
    [selectedFile, setSelectedFile] = useState(''),
    [fileContent, setFileContent] = useState('');
  const allFiles = data.logFiles?.files || [];
  const files = props.sessionId
    ? allFiles.filter(file => file.sessionId === props.sessionId)
    : allFiles;
  const selected = files.find(file => `${file.sessionId}:${file.name || ''}` === selectedFile) || files.find(file => file.name) || null;
  useEffect(() => {
    if (!files.some(file => `${file.sessionId}:${file.name || ''}` === selectedFile)) {
      const first = files.find(file => file.name);
      setSelectedFile(first ? `${first.sessionId}:${first.name}` : '');
    }
  }, [files, selectedFile]);
  useEffect(() => {
    if (!selected?.name) { setFileContent(''); return undefined; }
    let stopped = false;
    let timer;
    const load = async () => {
      const query = new URLSearchParams({ sessionId: selected.sessionId, file: selected.name });
      const response = await client.get(`${API.sourceLog}?${query}`).catch(() => null);
      if (!stopped) setFileContent(response?.content || response?.error || '暂时无法读取日志');
    };
    load();
    timer = window.setInterval(load, 1500);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [client, selected?.sessionId, selected?.name]);
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
      ? (fileContent || '')
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
    files: files.filter(file => file.name),
    selectedFile,
    setSelectedFile,
    selected,
    text,
  };
}
