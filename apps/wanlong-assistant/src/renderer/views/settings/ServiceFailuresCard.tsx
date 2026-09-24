import { Card } from '../../components/Card';
import { beijingTime } from '../../format';
import { serviceFailureDetail, useServiceFailures } from '../../hooks/useServiceFailures';

/** Background services that failed to start (the top-bar badge links here). Hidden while everything runs. */
export function ServiceFailuresCard() {
  const failures = useServiceFailures();
  if (failures.length === 0) return null;
  return (
    <Card title="后台服务未启动" icon="alert">
      <ul className="settings-links">
        {failures.map((failure) => (
          <li key={failure.name}>
            <div><strong>{failure.name}</strong><span>{serviceFailureDetail(failure)}</span></div>
            <span className="mono settings-nowrap">{beijingTime(failure.at, 'full')}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
