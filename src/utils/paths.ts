import * as os from "os";
import * as path from "path";

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

export function getHomeDir(): string {
  return os.homedir();
}

export function getClaudePluginsDir(): string {
  return path.join(getHomeDir(), ".claude", "plugins");
}

export function getPluginCacheDir(): string {
  return path.join(getClaudePluginsDir(), "cache", "ai-workflow", "ai-workflow", "1.0.0");
}

export function getInstalledPluginsPath(): string {
  return path.join(getClaudePluginsDir(), "installed_plugins.json");
}

export function getProjectRoot(): string {
  return PROJECT_ROOT;
}

export function getPluginJsonPath(): string {
  return path.join(PROJECT_ROOT, ".claude-plugin", "plugin.json");
}
