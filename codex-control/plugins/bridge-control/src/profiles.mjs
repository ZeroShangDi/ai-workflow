import { VOICE_TOOL_DEFINITIONS, WORK_TOOL_DEFINITIONS, DEV_TOOL_DEFINITION } from './tool-contracts.mjs';

export const PROFILE_VOICE_CONTROLLER = 'voice-controller';
export const PROFILE_WORK_REPORTER = 'work-reporter';
export const PROFILE_NAMES = Object.freeze([
  PROFILE_VOICE_CONTROLLER,
  PROFILE_WORK_REPORTER,
]);
export const DEFAULT_PROFILE = PROFILE_WORK_REPORTER;

export function parseProfile(argv = [], env = process.env) {
  let argumentProfile;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--profile') {
      argumentProfile = argv[index + 1];
      if (!argumentProfile || argumentProfile.startsWith('--')) {
        throw new Error('--profile requires a value');
      }
      index += 1;
    } else if (value.startsWith('--profile=')) {
      argumentProfile = value.slice('--profile='.length);
    }
  }
  const envProfile = env.BRIDGE_CONTROL_PROFILE;
  if (argumentProfile && envProfile && argumentProfile !== envProfile) {
    throw new Error('BRIDGE_CONTROL_PROFILE conflicts with --profile');
  }
  const profile = argumentProfile || envProfile || DEFAULT_PROFILE;
  if (!PROFILE_NAMES.includes(profile)) {
    throw new Error(`Unknown bridge-control profile: ${profile}`);
  }
  return profile;
}

export function devMode(argv = [], env = process.env) {
  return argv.includes('--dev') || env.BRIDGE_CONTROL_DEV === '1';
}

export function toolsForProfile(profile, { dev = false } = {}) {
  if (profile === PROFILE_VOICE_CONTROLLER) {
    const tools = [...VOICE_TOOL_DEFINITIONS];
    if (dev) tools.push(DEV_TOOL_DEFINITION);
    return tools;
  }
  if (profile === PROFILE_WORK_REPORTER) return [...WORK_TOOL_DEFINITIONS];
  throw new Error(`Unknown bridge-control profile: ${profile}`);
}

export function toolNamesForProfile(profile, options) {
  return toolsForProfile(profile, options).map((tool) => tool.name);
}

export function assertToolAvailable(profile, toolName, { dev = false } = {}) {
  if (!toolNamesForProfile(profile, { dev }).includes(toolName)) {
    throw new Error(`Tool ${toolName} is not available in profile ${profile}`);
  }
}
