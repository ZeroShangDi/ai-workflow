import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadHubFromEnvironment(env = process.env) {
  const modulePath = env.BRIDGE_CONTROL_HUB_MODULE;
  if (!modulePath) {
    const failure = new Error('BRIDGE_CONTROL_HUB_MODULE must point to a Hub client factory module');
    failure.code = 'HUB_NOT_CONFIGURED';
    throw failure;
  }
  const resolved = path.resolve(modulePath);
  const module = await import(pathToFileURL(resolved).href);
  if (typeof module.createHubClient !== 'function') {
    throw new TypeError('Hub module must export createHubClient(config)');
  }
  return module.createHubClient({ env });
}
