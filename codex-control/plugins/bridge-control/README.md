# Bridge Control

`bridge-control` is a Codex MCP plugin for operating external agent bridges through one stable tool surface.

## Architecture

- `server.mjs` owns MCP protocol and tool schemas.
- `src/adapters/index.mjs` selects a bridge implementation.
- `src/adapters/cmb.mjs` adapts Codex Mobile Bridge.
- New bridge software should add an adapter, not another copy of the MCP server or tool schemas.
- A different host environment with an incompatible plugin format should use a thin host-specific shell over the same adapter/core contract.

## Configuration

Configuration is stored at `${CODEX_HOME}/bridge-control/config.json` with mode `0600`.

Supported values:

- `software`: `cmb`
- `baseUrl`: bridge origin
- `username`
- `passwordEnv`: environment variable containing the password
- `passwordFile`: local file containing the password
- `defaultProject`: project used for a new test chat

The plugin never accepts or stores a plaintext password in MCP arguments.

## Setup

Add this marketplace to Codex:

```sh
codex plugin marketplace add /Users/v-shangjunhao/MyProject/ai-workflow/codex-control/plugins
codex plugin add bridge-control@codex-control
```

Then configure the password file through `bridge_configure`, for example:

```json
{
  "software": "cmb",
  "baseUrl": "http://127.0.0.1:18787",
  "username": "admin",
  "passwordFile": "/absolute/path/to/首次登录.txt",
  "defaultProject": "cc-control"
}
```
