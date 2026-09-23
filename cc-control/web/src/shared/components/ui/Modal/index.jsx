import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

/**
 * 基础弹窗。**必须 portal 到 body** —— 详情面板是 `overflow:auto` 的滚动容器，
 * 就地渲染的弹窗会跟着内容滚、还会被面板裁掉。
 *
 * 关掉的三条路径：Esc、点遮罩、点「关闭 ×」。不做焦点陷阱（本页弹窗内没有表单流），
 * 只把焦点移到面板上，Read 键位不会被浏览器默认行为带走。
 *
 * @param {{ title: string, subtitle?: string, toolbar?: React.ReactNode, note?: string,
 *           width?: string, onClose: () => void, children: React.ReactNode }} props
 */
export default function Modal({
  title,
  subtitle,
  toolbar,
  note,
  width = '800px',
  onClose,
  children,
}) {
  const panel = useRef(null);

  useEffect(() => {
    panel.current?.focus();
    const onKey = event => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="modal-scrim"
      onClick={event => {
        if (event.target === event.currentTarget) onClose();
      }}>
      <section
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panel}
        style={{ '--modal-width': width }}>
        <header className="modal-head">
          <h2 className="modal-title">{title}</h2>
          <button type="button" className="link-button modal-close" onClick={onClose}>
            关闭 ×
          </button>
        </header>
        {subtitle && <p className="modal-subtitle">{subtitle}</p>}
        {toolbar && <div className="modal-toolbar">{toolbar}</div>}
        <div className="modal-body">{children}</div>
        {note && <p className="modal-note">{note}</p>}
      </section>
    </div>,
    document.body,
  );
}
