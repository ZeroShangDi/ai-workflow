import { EmptyState as Empty, DetailField as Field } from '@/shared/components/ui/index.js';
import Badge from '@/shared/components/business/StatusBadge/index.jsx';
import { display, formLabel } from '@/shared/lib/format.js';
import { optionDescription, optionLabel } from './model.js';
export default function ReviewRecordDetail({ item, id, titleOf, children, message }) {
  return (
    <>
      {item ? (
        <>
          <div className="card-meta">
            <small>{item.displayId || id}</small>
            {/* 作答形态与审核状态并排：单看状态不知道 AI 是在答一道选择题还是一句自由问 */}
            <span className="card-meta-badges">
              {formLabel(item.form) && <span className="badge">{formLabel(item.form)}</span>}
              <Badge value={item.status} />
            </span>
          </div>
          <h1>{display(titleOf(item))}</h1>
          {/* 问题不再单独占一行：它已经是标题。选项只在这条决策有出题形态时才有值。 */}
          {item.questions?.length > 0 ? item.questions.map((question, questionIndex) => <section className="field decision-options" key={questionIndex}>
            <h3>{question.header || `问题 ${questionIndex + 1}`} · {question.question}</h3>
            {(question.options || []).map((option, index) => <div className="decision-option" key={index}>
              <strong>{optionLabel(option)}</strong>
              {optionDescription(option) && <small>{optionDescription(option)}</small>}
            </div>)}
          </section>) : item.options?.length > 0 && <section className="field decision-options">
            <h3>选项</h3>
            {item.options.map((option, index) => <div className="decision-option" key={index}>
              <strong>{optionLabel(option)}</strong>
              {optionDescription(option) && <small>{optionDescription(option)}</small>}
            </div>)}
          </section>}
          {item.selectedOption && <Field title="已选择" value={optionLabel(item.selectedOption)} />}
          {/* 结论侧：AI 判了什么 */}
          <Field title="决策" value={item.answer} />
          <Field title="判断依据" value={item.decisive_factors} />
          <Field title="风险" value={item.risks} />
          <Field title="变更操作" value={item.operations} />
          <Field title="受影响任务" value={item.analysis?.affectedTaskIds} />
          <Field title="替代指令" value={item.instruction} />
          {children}
          <p role="status">{message}</p>
        </>
      ) : (
        <Empty>选择记录查看详情</Empty>
      )}
    </>
  );
}
