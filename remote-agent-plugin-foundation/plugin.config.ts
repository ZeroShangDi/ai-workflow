/** Product metadata and host bindings; credentials belong only in private runtime storage. */
export default {
  name: "remote-notes",
  displayName: "Remote Notes",
  version: "0.3.0",
  description: "在个人账号中保存和读取笔记，并在网页查看 Agent 操作结果。",
  origin: "http://localhost:8787",
  auth: {
    scopes: ["notes", "offline_access"],
    accessScope: "notes",
    deviceClientId: "foundation-cli",
  },
  hosts: { codex: { appId: "asdk_app_6aeadf7492088191a1769a0ccfbe101a" } },
};
