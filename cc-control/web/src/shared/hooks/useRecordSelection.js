import { useState } from 'react';
export function useRecordSelection(entries, keyOf) {
  const [selected, setSelected] = useState(null),
    [filter, setFilter] = useState('all');
  const [drafts, setDrafts] = useState({}),
    [reviewer, setReviewer] = useState('');
  const visible = entries.filter(e => filter === 'all' || e.status === filter);
  const item = visible.find(e => keyOf(e) === selected) || visible[0];
  const key = item ? keyOf(item) : '';
  return {
    entries,
    visible,
    item,
    keyOf,
    setSelected,
    filter,
    setFilter,
    reviewer,
    setReviewer,
    instruction: drafts[key] || '',
    setInstruction: value => setDrafts(old => ({
      ...old,
      [key]: value
    }))
  };
}
