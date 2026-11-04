import { ControlService } from './control-service.mjs';
import { createDirectBackend } from './direct-backend.mjs';
import { loadControlConfig } from './config.mjs';
import { PROFILE_NAMES } from './profiles.mjs';

export class ControlToolGateway {
  constructor({ backend = null, profiles = PROFILE_NAMES, defaultProject = null } = {}) {
    this.backend = backend || createDirectBackend(loadControlConfig());
    this.services = new Map(profiles.map((profile) => [
      profile,
      new ControlService({ backend: this.backend, profile, defaultProject }),
    ]));
  }

  async call({ profile, tool, args }) {
    const service = this.service(profile);
    return service.call(tool, args);
  }

  service(profile) {
    const service = this.services.get(profile);
    if (!service) throw new Error(`Unknown Control profile: ${profile}`);
    return service;
  }

  close() {
    this.backend?.close?.();
  }
}
