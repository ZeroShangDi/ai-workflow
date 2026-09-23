import Icon from '../../../shared/components/ui/Icon/index.jsx';
import { Button } from '../../../shared/components/ui/index.js';
export default function ViewRail({ view, setView, views }) {
  return (
    <nav className="view-rail" aria-label="页面">
      {views.map(v => (
        <Button
          key={v.key}
          title={v.label}
          aria-label={v.label}
          aria-current={view === v.key ? 'page' : undefined}
          className={view === v.key ? 'selected' : ''}
          onClick={() => setView(v.key)}>
          <Icon name={v.icon} />
          <span>{v.label}</span>
        </Button>
      ))}
    </nav>
  );
}
