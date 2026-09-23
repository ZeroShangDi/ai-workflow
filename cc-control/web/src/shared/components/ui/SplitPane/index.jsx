import { useEffect, useRef, useState } from 'react';

// 右栏宽度记忆：**全局一份**（四个页面共用同一条分界线，在任一页拖过，其余页保持一致）。
// 沿用 theme 的 localStorage 写法：私密模式下静默降级，存不下来不影响本次拖动。
const STORAGE_KEY = 'cc-work.split';
const KEY_STEP = 24; // 方向键每次调宽的像素
const PRIMARY_BUTTON = 0;

function readStoredWidth() {
  try {
    const value = Number.parseFloat(window.localStorage.getItem(STORAGE_KEY) || '');
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function storeWidth(value) {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(Math.round(value)));
  } catch {
    /* 私密模式：记不住就算了 */
  }
}

/** design token 的像素值 —— 宽度上下限的来源是 token，不在这里另立魔数 */
function tokenPx(element, name, fallback) {
  if (!element) return fallback;
  const value = Number.parseFloat(window.getComputedStyle(element).getPropertyValue(name));
  return Number.isFinite(value) ? value : fallback;
}

/**
 * 夹到「右栏 ≥ panel-min、左栏 ≥ content-min」之间。
 * 放在组件外：拖动、键盘、窗口缩放三条路径共用同一份判据。
 */
function clampWidth(element, next) {
  if (!element) return next;
  const min = tokenPx(element, '--cc-layout-panel-min', 320);
  const keep = tokenPx(element, '--cc-layout-content-min', 360);
  return Math.min(Math.max(next, min), Math.max(min, element.clientWidth - keep));
}

/**
 * 左右分栏（列表 + 详情），中间分界线可拖动。四个页面共用这一个布局：
 * 原先各页手抄的 `.split-view / .primary-pane / .detail-pane` 结构收在这里。
 *
 * 宽度**默认不接管** —— `width === null` 时不写行内样式，完全交给 CSS 与媒体查询
 * （≤1279px 收窄到 panel-min、≤767px 转纵向），改版前什么样现在就什么样。
 * 只有用户真拖过（或 localStorage 里有记忆）才固定一个像素宽度。
 *
 * @param {{ primary: React.ReactNode, detail: React.ReactNode }} props
 */
export default function SplitPane({ primary, detail }) {
  const host = useRef(null);
  const detailPane = useRef(null);
  const anchor = useRef(null); // 拖动起点 { clientX, width }
  const [width, setWidth] = useState(readStoredWidth);
  const [dragging, setDragging] = useState(false);

  /** 当前实际宽度：未接管时从 DOM 量 —— 拖动/键盘都从真实值起步，不从假定的默认值起步 */
  function currentWidth() {
    if (width !== null) return width;
    if (detailPane.current) return detailPane.current.offsetWidth;
    return tokenPx(host.current, '--cc-layout-panel-width', 392);
  }

  function resize(next) {
    const clamped = clampWidth(host.current, next);
    setWidth(clamped);
    storeWidth(clamped);
  }

  function onPointerDown(event) {
    if (event.button !== PRIMARY_BUTTON) return;
    // 指针捕获：拖出分界线（DSH 里还有 iframe 边界）也不会丢事件
    event.currentTarget.setPointerCapture(event.pointerId);
    anchor.current = { clientX: event.clientX, width: currentWidth() };
    setDragging(true);
  }

  function onPointerMove(event) {
    if (!anchor.current) return;
    // 指针左移 → 右栏变宽。始终用起点宽度减总位移，避免逐帧累加漂移
    resize(anchor.current.width - (event.clientX - anchor.current.clientX));
  }

  function onPointerUp(event) {
    if (!anchor.current) return;
    anchor.current = null;
    setDragging(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  /** 回到 CSS 默认宽度，并把记忆一并清掉（双击 / 回车 / 空格） */
  function reset() {
    setWidth(null);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* 私密模式 */
    }
  }

  function onKeyDown(event) {
    if (event.key === 'ArrowLeft') { event.preventDefault(); return resize(currentWidth() + KEY_STEP); }
    if (event.key === 'ArrowRight') { event.preventDefault(); return resize(currentWidth() - KEY_STEP); }
    if (event.key === 'Home') { event.preventDefault(); return resize(0); } // 夹到最小
    if (event.key === 'End') { event.preventDefault(); return resize(Number.MAX_SAFE_INTEGER); } // 夹到最大
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); return reset(); }
    return undefined;
  }

  // 窗口变窄时把固定宽度收回来：行内宽度会盖住媒体查询，不夹的话左栏会被挤没
  const pinned = width !== null;
  useEffect(() => {
    if (!pinned) return undefined;
    const onResize = () => setWidth(current => (current === null ? current : clampWidth(host.current, current)));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [pinned]);

  return <div
    className={`split-view${dragging ? ' is-dragging' : ''}`}
    ref={host}
    style={pinned ? { '--split-panel': `${width}px` } : undefined}
  >
    <section className="primary-pane">{primary}</section>
    <aside className="detail-pane" ref={detailPane}>{detail}</aside>
    <div
      className="split-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整详情栏宽度"
      aria-valuenow={pinned ? Math.round(width) : undefined}
      title="拖动调整宽度，双击复位"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={reset}
      onKeyDown={onKeyDown}
    />
  </div>;
}
