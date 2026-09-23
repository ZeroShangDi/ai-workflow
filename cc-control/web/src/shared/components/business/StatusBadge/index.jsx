import { label } from '../../../lib/format.js';
export default function StatusBadge({ value }) {
  return <span className={`badge status-${value}`}>{label(value)}</span>;
}
