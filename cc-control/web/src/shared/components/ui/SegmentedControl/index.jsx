export default function SegmentedControl({ label, value, options, onChange, disabled }) {
  return <div className="segmented-control" role="group" aria-label={label}>{options.map(option => <button key={option.value} disabled={disabled} aria-pressed={value === option.value} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>;
}
