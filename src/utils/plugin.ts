import * as fs from "fs";
import * as path from "path";
import { getInstalledPluginsPath, getPluginCacheDir, getProjectRoot } from "./paths";

export interface PluginEntry {
  scope: "user";
  installPath: string;
  version: string;
  installedAt: string;
  lastUpdated: string;
}

export interface InstalledPlugins {
  version: number;
  plugins: Record<string, PluginEntry[]>;
}

export function readInstalledPlugins(): InstalledPlugins {
  const filePath = getInstalledPluginsPath();
  if (!fs.existsSync(filePath)) {
    return { version: 2, plugins: {} };
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as InstalledPlugins;
}

export function writeInstalledPlugins(data: InstalledPlugins): void {
  const filePath = getInstalledPluginsPath();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export function registerPlugin(): void {
  const data = readInstalledPlugins();
  const installPath = getPluginCacheDir();
  const now = new Date().toISOString();

  const entry: PluginEntry = {
    scope: "user",
    installPath,
    version: "1.0.0",
    installedAt: now,
    lastUpdated: now,
  };

  data.plugins["ai-workflow@local"] = [entry];
  writeInstalledPlugins(data);
}

export function unregisterPlugin(): void {
  const data = readInstalledPlugins();
  delete data.plugins["ai-workflow@local"];
  writeInstalledPlugins(data);
}

export function isPluginRegistered(): boolean {
  const data = readInstalledPlugins();
  return "ai-workflow@local" in data.plugins;
}
