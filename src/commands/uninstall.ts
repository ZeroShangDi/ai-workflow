import * as fs from "fs";
import * as path from "path";
import { getPluginCacheDir } from "../utils/paths";
import { unregisterPlugin, isPluginRegistered } from "../utils/plugin";

export function runUninstall(): void {
  const cacheDir = getPluginCacheDir();

  // Step 1: remove symlink
  console.log("  [1/2] 移除符号链接...");

  if (fs.existsSync(cacheDir)) {
    const stat = fs.lstatSync(cacheDir);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(cacheDir);
    } else {
      fs.rmSync(cacheDir, { recursive: true });
    }
    console.log(`         ✓ 已删除 ${cacheDir}`);

    // Clean up empty parent dirs
    const parent = path.dirname(cacheDir);
    const grandparent = path.dirname(parent);
    if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
      fs.rmdirSync(parent);
    }
    if (fs.existsSync(grandparent) && fs.readdirSync(grandparent).length === 0) {
      fs.rmdirSync(grandparent);
    }
  } else {
    console.log("         - 符号链接不存在，跳过");
  }

  // Step 2: unregister
  console.log("  [2/2] 从 Claude Code 注销...");

  if (!isPluginRegistered()) {
    console.log("         - 插件未注册，跳过");
  } else {
    unregisterPlugin();
    console.log("         ✓ 已更新 installed_plugins.json");
  }

  console.log("");
  console.log("  ✓ 卸载完成！");
}
