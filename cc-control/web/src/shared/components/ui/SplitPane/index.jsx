import { useRef, useState } from 'react';

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
 *
 * **只在用户动作（拖动/键盘）时用**，不在窗口 resize 时用 —— 见文件末尾的说明。
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
 * （≤1279px 收窄到 panel-min、≤767px 转纵向）。只有用户真拖过才固定一个像素宽度。
 *
 * ## 为什么窗口变窄时不在 JS 里改宽度
 * 最初这里是「窗口 resize → 用新容器宽重新夹一次 → 写回 state 与 localStorage」。
 * 那是错的：**瞬时**的窄视口（拖动中的重排、无头截图、浏览器临时缩小）会把用户
 * 记住的宽度永久改成下限，之后窗口变宽也回不来 —— 用户没做任何操作，偏好却没了。
 *
 * 现在「装不下」交给 CSS 的 `clamp()` 算（见 styles.css 的 `--split-panel`）：
 * 渲染时自动收窄，**存的值一个字不动**，窗口变宽就回到用户选的那个宽度。
 * 组件里只保留「用户动作产生的宽度必须落在可达区间内」这一条。
 *
 * @param {{ primary: React.ReactNode, detail: React.ReactNode }} props
 */
export default function SplitPane({ primary, detail }) {
  const host = useRef(null);
  const detailPane = useRef(null);
  const anchor = useRef(null); // 拖动起点 { clientX, width }
  const [width, setWidth] = useState(readStoredWidth);
  const [dragging, setDragging] = useState(false);

  /** 当前**实际**宽度：从 DOM 量。拖动/键盘都从渲染出来的值起步，不从存的值起步 */
  function currentWidth() {
    if (detailPane.current) return detailPane.current.offsetWidth;
    if (width !== null) return width;
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
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      return resize(currentWidth() + KEY_STEP);
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      return resize(currentWidth() - KEY_STEP);
    }
    if (event.key === 'Home') {
      event.preventDefault();
      return resize(0);
    } // 夹到最小
    if (event.key === 'End') {
      event.preventDefault();
      return resize(Number.MAX_SAFE_INTEGER);
    } // 夹到最大
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      return reset();
    }
    return undefined;
  }

  return (
    <div
      className={`split-view${dragging ? ' is-dragging' : ''}`}
      ref={host}
      style={width === null ? undefined : { '--split-panel': `${width}px` }}>
      <section className="primary-pane">{primary}</section>
      <aside className="detail-pane" ref={detailPane}>
        {detail}
      </aside>
      <div
        className="split-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整详情栏宽度"
        aria-valuenow={width === null ? undefined : Math.round(width)}
        title="拖动调整宽度，双击复位"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={reset}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
