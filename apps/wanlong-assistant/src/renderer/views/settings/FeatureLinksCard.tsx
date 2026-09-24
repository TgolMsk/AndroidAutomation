import { Card } from '../../components/Card';
import type { ViewKey } from '../../navigation';
import { useNavigation } from '../../state/navigation';

const LINKS: ReadonlyArray<{ title: string; detail: string; label: string; view: ViewKey }> = [
  { title: '任务计划', detail: '计划总开关、补跑窗口、排队上限与失败重试。', label: '前往任务计划', view: 'plans' },
  { title: '采集配置', detail: '每个实例的采集资源、搜索等级与自动续跑。', label: '前往采集总览', view: 'gatherOverview' },
  { title: '模板集', detail: '每个实例选用的模板集、截取与测试模板。', label: '前往模板库', view: 'templates' },
];

/** 功能设置: settings that live on their own pages (the foundation page's links, kept after the card split). */
export function FeatureLinksCard() {
  const { navigate } = useNavigation();
  return (
    <Card title="功能设置" icon="settings">
      <ul className="settings-links">
        {LINKS.map((link) => (
          <li key={link.view}>
            <div><strong>{link.title}</strong><span>{link.detail}</span></div>
            <button type="button" className="btn sm settings-nowrap" onClick={() => navigate(link.view)}>{link.label}</button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
