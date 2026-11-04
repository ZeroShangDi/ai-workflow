import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import {
  mkdir,
  writeFile,
  cp,
  readdir,
  readFile,
  rm,
  rename,
} from "node:fs/promises";
import config from "../../plugin.config.js";
import { packageHost } from "../hosts/index.js";
import { serverOrigin } from "../client/index.js";

/** Replace public product variables in Skill text, preserving all non-text resources. */
async function renderSkills(directory: string, origin: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await renderSkills(path, origin);
      continue;
    }
    if (entry.name.endsWith(".md")) {
      const text = await readFile(path, "utf8");
      await writeFile(
        path,
        text
          .replaceAll("{{APP_ORIGIN}}", origin)
          .replaceAll("{{PLUGIN_NAME}}", config.displayName),
      );
    }
  }
}

/** Build a host package in a private staging directory; never modify an installed plugin. */
async function main() {
  const { values } = parseArgs({
    options: {
      host: { type: "string", default: "codex" },
      origin: { type: "string" },
    },
  });
  const host = values.host!;
  if (!/^[a-z][a-z0-9-]*$/.test(config.name))
    throw new Error("Invalid plugin name");
  const origin = serverOrigin(
    values.origin ?? process.env.APP_ORIGIN ?? config.origin,
  );
  const files = packageHost(
    host,
    { ...config, origin },
    resolve("dist/src/cli.js"),
  );
  const parent = resolve("artifacts");
  const output = join(parent, host);
  const staging = join(parent, `.staging-${host}-${process.pid}`);
  await mkdir(staging, { recursive: true });
  try {
    for (const [path, data] of Object.entries(files)) {
      const target = join(staging, path);
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, JSON.stringify(data, null, 2) + "\n");
    }
    if (host === "workbuddy")
      await writeFile(
        join(staging, "icon.svg"),
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#243b53"/><path d="M18 20h28v6H18zm0 12h28v6H18zm0 12h18v6H18z" fill="white"/></svg>',
      );
    await cp("skills", join(staging, "skills"), { recursive: true });
    await renderSkills(join(staging, "skills"), origin);
    const status =
      host === "codex"
        ? "生成包需在目标宿主验收。"
        : "文档适配示例，尚未实机验收或完成平台提审。";
    await writeFile(
      join(staging, "README.md"),
      `${config.displayName}\n\n${status}\n服务：${origin}\n` +
        (host === "dsh"
          ? "\n先在源码项目运行 npm run build 和 npm run cli -- login，再按当前 DSH 版本导入 mcp-entry.json 所描述的配置。该包依赖本机源码项目，不是自包含安装包。\n"
          : ""),
    );
    await rm(output, { recursive: true, force: true });
    await rename(staging, output);
    console.log(output);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
