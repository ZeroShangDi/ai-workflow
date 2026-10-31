import path from 'node:path';

export function controlThreadConfig(profile, env = process.env) {
  const pluginRoot = path.resolve(import.meta.dirname, '..');
  const cli = path.join(pluginRoot, 'cli.mjs');
  const configPath = env.BRIDGE_CONTROL_INTEGRATION_CONFIG || '<BRIDGE_CONTROL_INTEGRATION_CONFIG>';
  const command = `${process.execPath} ${cli} --config ${configPath} --profile ${profile} --tool <tool> --args '<json>'`;
  const common = [
    'Use the shell to call Control tools through the public bridge-control CLI.',
    `Command template: ${command}`,
    'The CLI automatically uses CODEX_THREAD_ID as sessionId.',
    'Do not call codex_app.create_thread or another built-in task-creation tool.',
  ];
  if (profile === 'voice-controller') {
    common.push('For task creation use only bridge_chat_create and bridge_chat_confirm through the CLI.');
    common.push('Omit draft.project unless the user explicitly requests a different project; Control defaults to the fixed workspace.');
  } else if (profile === 'work-reporter') {
    common.push('Report progress only through the work-reporter bridge_chat tools.');
    common.push('Do not create or control other tasks.');
  } else {
    throw new Error(`Unsupported Control thread profile: ${profile}`);
  }
  return {
    developerInstructions: common.join(' '),
    permissions: ':danger-full-access',
    approvalPolicy: 'never',
  };
}
