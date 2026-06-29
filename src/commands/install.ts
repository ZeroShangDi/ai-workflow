import * as fs from "fs";
import * as path from "path";
import {
  getProjectRoot,
  getPluginCacheDir,
  getClaudePluginsDir,
} from "../utils/paths";
import { registerPlugin, isPluginRegistered } from "../utils/plugin";

export function runInstall(): void {
  const root = getProjectRoot();
  const cacheDir = getPluginCacheDir();
  const pluginsRoot = getClaudePluginsDir();

  // Step 1: detect project structure
  const commandsDir = path.join(root, ".claude", "commands");
  const skillsDir = path.join(root, ".claude", "skills");
  const pluginJson = path.join(root, ".claude-plugin", "plugin.json");

  const commandCount = fs.existsSync(commandsDir)
    ? fs.readdirSync(commandsDir).filter((f) => f.endsWith(".md")).length
    : 0;
  const skillCount = fs.existsSync(skillsDir)
    ? fs.readdirSync(skillsDir).filter((f) => {
        const stat = fs.statSync(path.join(skillsDir, f));
        return stat.isDirectory();
      }).length
    : 0;

  console.log("  [1/4] 检测项目结构...");
  console.log(`         ✓ 找到 ${commandCount} 个斜杠命令`);
  console.log(`         ✓ 找到 ${skillCount} 个技能`);

  if (!fs.existsSync(pluginJson)) {
    console.error("  ✗ 未找到 .claude-plugin/plugin.json，请先创建插件清单");
    process.exit(1);
  }
  console.log(`         ✓ 找到插件清单`);

  // Step 2: verify plugin manifest
  console.log("  [2/4] 验证插件清单...");
  const manifest = JSON.parse(fs.readFileSync(pluginJson, "utf-8"));
  console.log(`         ✓ ${manifest.name} v${manifest.version}`);

  // Step 3: create symlink
  console.log("  [3/4] 创建符号链接...");

  if (!fs.existsSync(pluginsRoot)) {
    fs.mkdirSync(pluginsRoot, { recursive: true });
  }

  const cacheParent = path.dirname(cacheDir);
  if (!fs.existsSync(cacheParent)) {
    fs.mkdirSync(cacheParent, { recursive: true });
  }

  // Remove existing symlink/node if present
  if (fs.existsSync(cacheDir)) {
    const stat = fs.lstatSync(cacheDir);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(cacheDir);
    } else {
      fs.rmSync(cacheDir, { recursive: true });
    }
  }

  fs.symlinkSync(root, cacheDir);
  console.log(`         ✓ ${cacheDir} → ${root}`);

  // Step 4: register in Claude Code
  console.log("  [4/4] 注册到 Claude Code...");

  if (isPluginRegistered()) {
    console.log("         ⚠ 插件已注册，将更新记录");
  }

  registerPlugin();
  console.log("         ✓ 已写入 installed_plugins.json");
  console.log("");
  console.log("  🎉 安装完成！重启 Claude Code 即可使用 /w-plan、/w-dev 等命令。");
}
