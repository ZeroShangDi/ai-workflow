import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const metrics = require('./run-metrics.cjs');

export const {
  readRunMetrics,
  readRunMeta,
  resetRunMeta,
  updateRunMeta,
} = metrics;

export default metrics;
