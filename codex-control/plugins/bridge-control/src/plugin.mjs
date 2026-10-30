import { ControlService } from './control-service.mjs';

export function createControlPlugin(options) {
  return new ControlService(options);
}

export { ControlService } from './control-service.mjs';
export { CreateDraftMachine } from './create-machine.mjs';
export { assertHubClient, requiredHubMethods } from './hub-client.mjs';
export { HOST_TOOL_NAMES } from './tool-contracts.mjs';
export {
  DEFAULT_PROFILE,
  PROFILE_NAMES,
  PROFILE_VOICE_CONTROLLER,
  PROFILE_WORK_REPORTER,
  devMode,
  parseProfile,
  toolNamesForProfile,
  toolsForProfile,
} from './profiles.mjs';
