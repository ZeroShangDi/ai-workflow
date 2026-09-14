import { label } from '../../../lib/format.js';
import { Select } from '../../ui/index.js';
export default function RunSelect({
  runs,
  selectedRunId,
  setRunId
}) {
  return (<Select aria-label="选择 Run" value={selectedRunId || ''} onChange={e => setRunId(e.target.value)}>
    <option value="">自动跟随当前 Run</option>
    {selectedRunId && !runs.some(r => r.runId === selectedRunId) && <option value={selectedRunId}>{selectedRunId} · 暂不可用</option>}
    {runs.map(r => <option key={r.runId} value={r.runId}>{r.runId} · {label(r.status)}</option>)}
  </Select>);
}
