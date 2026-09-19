#!/usr/bin/env bash
# install-fixture.sh — 离线装配探针插件到隔离 profile（替代 `dsh plugin add`，见 F13：本机无 pnpm）
#
# 做什么：
#   ① 在 $DSH_HOME/profiles/$AWF_PROBE_PROFILE/ 建 profile（package.json / cordis.yml / cordis.patch.yml）
#   ② 把仓库里的探针插件**符号链接**进 profile 的 node_modules（不拷贝，改代码即时生效）
#   ③ 用 profile 的 cordis.patch.yml 插入插件行（patch 语法：`- insert: [{id, name, config}]`）
#
# 幂等：profile 已存在就复用，patch 里已有的行不重复插。
# 纪律：只写 $DSH_HOME（隔离），绝不写真实 ~/.dsh。

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"

PROFILE_DIR="$DSH_HOME/profiles/$AWF_PROBE_PROFILE"
PLUGIN_NAME="awf-probe-plugin"

mkdir -p "$PROFILE_DIR/node_modules"

# ① profile 声明（bundles = 与真实 web profile 相同的两层）
cat > "$PROFILE_DIR/package.json" <<'JSON'
{
  "name": "dsh-profile-awf-probe",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app"
      ]
    }
  }
}
JSON

# ② profile 根（空入口列表；树由 patch 层组合出来）
cat > "$PROFILE_DIR/cordis.yml" <<'YML'
# 空入口列表：树 = bundles 的各层 patch + cordis.patch.yml。
# 探针的插件行写在 cordis.patch.yml 里（本文件不要手改）。
[]
YML

# ③ 插件符号链接（改仓库里的源码即时生效）：探针夹具 + AWF 的生产 host 半侧
ln -sfn "$AWF_PROBE_PLUGIN_SRC" "$PROFILE_DIR/node_modules/$PLUGIN_NAME"
ln -sfn "$AWF_DSH_PLUGIN_SRC" "$PROFILE_DIR/node_modules/awf-dsh-plugin"

# ④ patch 层：插入探针插件行 + AWF 插件行（幂等：**两行都在**才跳过）
if grep -q "id: awf-probe" "$PROFILE_DIR/cordis.patch.yml" 2>/dev/null \
   && grep -q "id: awf-dsh" "$PROFILE_DIR/cordis.patch.yml" 2>/dev/null; then
  echo "[install-fixture] patch 已含两个插件行，跳过"
else
  cat > "$PROFILE_DIR/cordis.patch.yml" <<YML
# awf-probe profile 的用户 patch 层：只插 AWF 自己的两个插件。
# 两者都只在隔离 DSH_HOME 下加载；不参与任何产品装配之外的路径。
- insert:
    - id: awf-probe
      name: '$PLUGIN_NAME'
      config:
        pathPrefix: '/api/awf-probe'
        echo: 'p2-3'
    # AWF 的 DSH host 半侧：指令通道地址经 AWF_DSH_BASE 注入（见 scripts/probe/dsh/roundtrip.cjs）
    - id: awf-dsh
      name: 'awf-dsh-plugin'
      config:
        webPort: 39081
YML
  echo "[install-fixture] 已写入 patch：$PROFILE_DIR/cordis.patch.yml"
fi

# ⑤ 插件自己的依赖：生产插件 import 平台的 dsh-mcp-client（会话级挂 MCP）、dsh-llm（注入消息）、
#    dsh-agent（模型选择）、dsh-tool-subagent（命名子 Agent，C3）。
#    本机无 pnpm，故把它们从真实 home 的 hoisted node_modules **符号链接**进插件 node_modules
#    （已被 .gitignore 的 node_modules/ 覆盖）。缺它时插件会**明确报错**而不是静默不挂。
#
#    注意：这一步只服务**探针**（夹具把插件连同源码目录一起用符号链接装进 profile，所以插件的
#    裸 import 从仓库往上找，必须在这里有）。生产安装（`awf plugin install`）不用这套 ——
#    它把插件**整目录拷进** profile 的 node_modules，依赖经 profile 的 node_modules 解析
#    （为什么不能软链，见 docs/discuss/dsh-plugin-structure.md §4）。
PLUGIN_DEPS="$AWF_DSH_PLUGIN_SRC/node_modules/@deepseek-ai"
REAL_DEPS="$HOME/.dsh/profiles/node_modules/@deepseek-ai"
mkdir -p "$PLUGIN_DEPS"
for pkg in dsh-mcp-client dsh-agent dsh-llm dsh-tool-subagent; do
  if [[ -d "$REAL_DEPS/$pkg" ]]; then
    ln -sfn "$REAL_DEPS/$pkg" "$PLUGIN_DEPS/$pkg"
  else
    echo "[install-fixture] ⚠ 找不到 $REAL_DEPS/$pkg —— 依赖它的能力会明确失败（不是静默跳过）" >&2
  fi
done

echo "[install-fixture] profile=$PROFILE_DIR"
echo "[install-fixture] probe   plugin -> $AWF_PROBE_PLUGIN_SRC"
echo "[install-fixture] awf-dsh plugin -> $AWF_DSH_PLUGIN_SRC"
