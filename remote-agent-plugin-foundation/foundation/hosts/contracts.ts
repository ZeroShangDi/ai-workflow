export interface PackageInput {
  name: string;
  displayName: string;
  description: string;
  version: string;
  origin: string;
  auth: { scopes: string[] };
  hosts: { codex: { appId: string } };
}
export type HostFiles = Record<string, unknown>;
