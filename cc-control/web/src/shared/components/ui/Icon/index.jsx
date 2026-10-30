import { ICONS } from '@/shared/assets/index.js';
export default function Icon({ name, className = '' }) {
  return (
    <img
      src={ICONS[name]}
      className={`ui-icon ${className}`}
      alt=""
      aria-hidden="true"
      width="20"
      height="20"
    />
  );
}
