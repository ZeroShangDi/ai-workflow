/**
 * 极简 logger — 无外部依赖
 */

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';

export const logger = {
  info(msg) {
    console.log(`${DIM}  ${msg}${RESET}`);
  },
  success(msg) {
    console.log(`${GREEN}✔ ${msg}${RESET}`);
  },
  warn(msg) {
    console.log(`${YELLOW}⚠ ${msg}${RESET}`);
  },
  error(msg) {
    console.error(`${RED}✘ ${msg}${RESET}`);
  },
};
