# Initial decisions

The canonical product requirements remain in ../remote-agent-plugin-foundation.md.

## Reuse review

- MCP: use the official @modelcontextprotocol/sdk rather than implement protocol framing.
- Authentication: use Better Auth email/password, bearer and device-authorization plugins. This is first-party device login to the same application, not a third-party scoped OAuth platform. Device tokens are application sessions; scopes are not represented as enforced permissions.
- HTTP: Hono provides routing and standard Request/Response interoperability.
- Storage: SQLite through Node 24 node:sqlite for a single-instance starter. Persistence is behind a small repository interface; deployments requiring multiple replicas need another implementation.
- Validation: Zod provides shared runtime schemas.
- UI: semantic HTML and browser JavaScript are sufficient for the initial login, consent and notes flow. No frontend build system is needed.
- Full Next.js SaaS and FastAPI templates were considered. They introduce framework/product choices unnecessary for the minimal flow; retain them as alternatives, not dependencies.

Sources checked 2026-11-03:

- https://github.com/modelcontextprotocol/typescript-sdk
- https://better-auth.com/docs/plugins/device-authorization
- https://better-auth.com/docs/installation
- https://github.com/nextjs/saas-starter
- https://github.com/fastapi/full-stack-fastapi-template

## Boundaries

contracts has no application dependencies. notes depends only on contracts. storage, auth and client implement contracts. server and mcp compose public interfaces. Browser code uses HTTP only. The composition root chooses concrete implementations.

API: GET /api/notes returns {notes}; POST /api/notes accepts {text} and returns {note}. Identity is always derived server-side. The first version returns up to 100 newest notes; pagination is deferred and this bound is explicit.

No transparent retry for writes. A lost create response is an unknown outcome: inspect the list before attempting another create. Authentication expiry requires another login. Device logout revokes the active device session before removing its local credential.

No paid services, deployment account, production credentials or supported-host claims are implied by this starter. Host configuration is a portable stdio example to verify per product.

## Validation record

- Type checking and production JavaScript compilation run locally.
- Automated tests use in-memory SQLite, the real Better Auth device grant, fake repository/client contracts and the official MCP in-memory transport.
- Browser smoke test on a temporary localhost database: register, create note, device-code verification and explicit approval.
- Built CLI login saved credentials into a temporary directory. A real stdio MCP child process read the browser note and created a second note visible after a browser refresh.
- The browser test caught an async DOM event lifetime bug; the handler now captures the form before awaiting the network.
- No real user credentials, production service or deployment account was used. Docker execution and named Agent host installation have not been tested.

## Native plugin OAuth (2026-11-04)

The installable `plugin/` package now declares HTTP MCP at `/mcp` with OAuth. The original stdio + device login remains a separate portable client.

Better Auth OAuth Provider owns authorization codes, S256 PKCE, dynamic client registration and refresh tokens. Public client registration is explicitly enabled for this local trial, bound only to the notes resource, with PKCE required. Production registration policy needs a deployment-specific decision.

HTTP MCP accepts signed resource-bound access tokens with `notes` scope and a currently active backing user session. Session tokens cannot be used as OAuth access tokens. Access-token TTL is five minutes. Each request receives a fresh MCP transport bound to its authenticated user; transport state cannot cross users. Cookie-based web API access retains the existing authorization path.

Consent details are displayed only after signed-query validation. The browser returns to the provider-selected callback. The notes page refreshes on focus so returning from the Agent reveals its completed writes.

Acceptance evidence:

- Codex CLI installed and enabled `remote-notes@remote-agent-foundation` version 0.2.0.
- Automated tests cover consent, signature tampering, resource access, HTTP MCP write → web API read, refresh, missing authentication, session-token rejection and revocation.
- The actual Codex OAuth client discovered the isolated localhost MCP server, registered itself and opened the signed login flow. Browser registration correctly reached consent.
- The final browser consent click was blocked by automatic approval review and requires user confirmation. No test credential was installed by that unfinished flow. Full desktop UI connection and an actual AI turn remain pending.
- Desktop automation cannot control Codex itself in this environment. CLI installation is verified; the plugin panel's display and Connect button still require manual verification.

## Connection UI correction (2026-11-04)

The user confirmed that the installed plugin has no Connect action. Installation and the temporary CLI OAuth override did not validate the plugin-directory connection UI. The current package contains direct MCP configuration, but no registered app mapping.

Official packaging documentation describes registering a custom MCP connection in ChatGPT, obtaining its real `plugin_asdk_app...` ID, and referencing `.app.json` from the OpenAI manifest extension. This is the documented next integration path; the exact desktop button behavior remains unverified. Do not fabricate an app ID or treat `authentication: ON_INSTALL` as app registration. Publicly reachable service setup (or a supported tunnel), platform registration and desktop verification remain outstanding.

Source: https://developers.openai.com/plugins/build/plugins

## Website sessions and Agent connections (2026-11-04)

Website sign-in is a SaaS session, not a connected Agent. The UI no longer labels the authentication library's full session list as devices. `/api/connections` lists active OAuth refresh grants grouped by client and backing session, excludes unredeemed consent and browser-only logins, and never returns credentials. Revocation checks ownership, revokes the rotation family, and makes existing MCP access tokens unusable without signing out the website. Physical machine count cannot be inferred from standard OAuth registration. This list currently covers OAuth connections, not the legacy device-code CLI. Provider session lifetime still bounds authorization lifetime; independent grant lifetime is a separate follow-up.

Platform registration was attempted in the in-app browser; ChatGPT redirected to its login page. No authenticated platform session, registered app ID, deployment endpoint or tunnel resource is available yet. Registration remains pending user login and service reachability setup.

## Verified Codex packaging correction (2026-11-04)

Local Codex 0.166.0-alpha.5.1 `plugin/read` parsed the portable root manifest's skills but returned an empty MCP list. Adding a compatibility manifest alongside the portable root did not change that. Removing the root manifest and using `.codex-plugin/plugin.json` with `mcpServers: "./.mcp.json"` and server `type: "http"` made the same API return `["remote-notes"]`. Installed version 0.2.1 uses this tested compatibility layout. Portable examples moved to docs and are not installation inputs.

The earlier conclusion that a registered ChatGPT app was required for local Codex MCP was unsupported. Official MCP documentation explicitly supports plugin-provided HTTP servers and their OAuth settings. Platform registration is a separate route. No duplicate global MCP entry was added. Desktop UI behavior remains unverified.

Source: https://learn.chatgpt.com/docs/extend/mcp?surface=cli

## Installed Gmail and Figma comparison (2026-11-04)

Read the installed `openai-curated-remote/gmail/0.1.10` and `figma/17.0.0` manifests without modifying either plugin. Gmail references `.app.json` with a required registered `connector_…` app and has no bundled MCP manifest in that package. Figma references skills, `.mcp.json` (`https://mcp.figma.com/mcp`) and `.app.json` containing its registered connector. Their interface declarations supply introduction text, logos and other listing metadata; Figma separately supplies skills.

Remote Notes 0.2.1 has a direct bundled HTTP MCP and skills, but no registered connector mapping. Its successful local `mcpServer/oauth/login` validates direct MCP authentication only; it does not validate the plugin-detail account-linking UX described by the user. The observed file difference is consistent with the platform connector being responsible for that account-linking UX, but desktop rendering remains unobserved because computer use cannot control Codex. Do not claim that fixing MCP loading alone fixes the plugin-detail Connect button.

Product acceptance target: plugin details show account association, introduction and available skills; Connect opens this application's OAuth login/consent; callback completes credential exchange in the host; host refreshes connection/tool state; Agent executes; website shows results. A manual return-to-host button is optional UX and must use a documented host callback/deep link, never an invented scheme. Standard loopback OAuth callback can complete without restarting the desktop process.

Matching the registered connector path requires a real platform registration ID and supported platform setup. It cannot be achieved by copying Gmail/Figma connector IDs or by changing the website URL. Official references: https://developers.openai.com/plugins/build/plugins and https://developers.openai.com/plugins/deploy/submission-errors .

## Completed platform connection acceptance (2026-11-04)

After action-time user confirmation, registered Remote Notes through ChatGPT's Add custom MCP server UI. OAuth DCR/PKCE discovery succeeded over a Cloudflare Quick Tunnel to an isolated instance on port 8789 (`.data/platform-trial`). Alice logged in and consented; the browser returned automatically to ChatGPT and displayed Primary connected. The platform discovered notes_create and notes_list.

Observed identifiers: plugin page `plugin_asdk_app_6aeadf7492088191a1769a0ccfbe101a`; management page application ID `asdk_app_6aeadf7492088191a1769a0ccfbe101a`. The platform-generated installed personal plugin's `.app.json` confirms the latter mapping. Final local package 0.2.3 references that real application ID and skills, without a second direct MCP transport. Do not put the plugin-page ID into the app mapping.

Live tool discovery added Remote Notes to this Codex conversation. Called its actual platform notes_create and notes_list tools; created note ID `413857a8-b6ea-409e-b69c-eb5dbc7441b5`, then observed the same text in Alice's HTTPS website. No direct database write or bypass token was used for this evidence. Current local-source plugin detail UI still requires refresh/manual verification, while the automatically installed platform plugin has been used successfully.

Trial origin: https://bottom-encourage-mechanisms-performances.trycloudflare.com . Temporary tunnel availability is tied to the local processes. Production needs a stable deployment and platform configuration update. Original localhost:8787 data remains separate. Also fixed the OAuth login view requesting authenticated connection-context before a user is logged in; this source fix takes effect on the next server restart.

## Copyable development template (2026-11-04)

The project now separates foundation mechanisms from product server, MCP and web code. It remains one npm project with the existing dependencies. Business contracts and SQL moved to src/server/notes; foundation uses injected auth configuration and per-request server factories. Common account UI is composed from shared fragments and JavaScript. Root tool configuration retains standard locations.

Added Node built-in scripts for independent creation, initialization, build asset copying and host-package generation. Reused existing Prettier for generated config formatting. Codex association and direct-MCP packages are mutually exclusive; other hosts are explicitly unverified examples. Added small transaction-based migration runner because copying a server template without a schema recovery path would leave a basic operational gap; tests cover repeat runs, history mismatch and rollback.
