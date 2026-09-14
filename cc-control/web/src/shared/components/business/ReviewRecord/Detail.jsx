import { EmptyState as Empty, DetailField as Field } from '../../ui/index.js';
import Badge from '../StatusBadge/index.jsx';
import { display } from '../../../lib/format.js';
export default function ReviewRecordDetail({
  item,
  id,
  titleOf,
  children,
  message
}) {
  return (<>{item ? <><div className="card-meta"><small>{id}</small><Badge value={item.status} /></div><h1>{display(titleOf(item))}</h1><Field title="决策" value={item.answer} /><Field title="判断依据" value={item.decisive_factors} /><Field title="风险" value={item.risks} /><Field title="变更操作" value={item.operations} /><Field title="受影响任务" value={item.analysis?.affectedTaskIds} /><Field title="替代指令" value={item.instruction} />{children}<p role="status">{message}</p></> : <Empty>选择记录查看详情</Empty>}</>);
}
