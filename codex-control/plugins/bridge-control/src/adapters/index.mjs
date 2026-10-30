import { CmbAdapter } from './cmb.mjs';

const ADAPTERS = new Map([
  ['cmb', CmbAdapter],
]);

export function adapterFor(config) {
  const Adapter = ADAPTERS.get(config.software);
  if (!Adapter) {
    throw new Error(`Unsupported bridge software: ${config.software}`);
  }
  return new Adapter(config);
}

export function adapterNames() {
  return [...ADAPTERS.keys()];
}
