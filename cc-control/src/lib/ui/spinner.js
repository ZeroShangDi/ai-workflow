import { DIM, RESET } from './colors.js';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * 创建终端旋转动画
 * @param {string} label - 动画旁显示的文本
 * @returns {{ stop: () => void }}
 */
export function createSpinner(label) {
  let i = 0;
  let active = true;
  const timer = setInterval(() => {
    if (active) {
      process.stdout.write(`\r     ${DIM}${SPINNER[i++ % SPINNER.length]} ${label}${RESET}`);
    }
  }, 80);
  return {
    stop() {
      active = false;
      clearInterval(timer);
      process.stdout.write('\r\x1b[K');
    },
  };
}
