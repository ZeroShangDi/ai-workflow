'use strict';

/** Build a clean environment for a newly started project conversation. */
function projectSessionEnv(env, { projectRoot, port, sessionName }) {
  const clean = { ...env };
  for (const key of ['CC_SESSION', 'CC_PROJECT', 'CC_WORKDIR', 'CC_AWF_STATE_SERVER', 'CC_SID']) delete clean[key];
  return {
    ...clean,
    CC_SESSION: sessionName,
    CC_WORKDIR: projectRoot,
    CC_PROJECT: projectRoot,
    CC_PORT: String(port),
    CC_AWF_STATE_SERVER: '1',
  };
}

module.exports = { projectSessionEnv };
