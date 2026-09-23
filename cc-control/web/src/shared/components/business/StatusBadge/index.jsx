import { label } from '@/shared/lib/format.js';
export default function StatusBadge({ value }) {
  return <span className={`badge status-${value}`}>{label(value)}</span>;
}
