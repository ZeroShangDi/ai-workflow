import { showConnection, bindConnection } from "./connection.js";
let onLogin = async () => {};
let onLogout = () => {};
const status = document.querySelector("#status");
let verifiedCode = null;

/** Call same-origin endpoints without storing session tokens in browser JavaScript. */
export async function request(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.message || data.error?.code || "请求失败，请检查状态后重试",
    );
  return data;
}

/** Serialize each UI action and announce failures accessibly. */
export function action(selector, event, handler) {
  document.querySelector(selector).addEventListener(event, async (e) => {
    e.preventDefault();
    const controls = [
      ...e.currentTarget.querySelectorAll("button"),
      ...(e.currentTarget.tagName === "BUTTON" ? [e.currentTarget] : []),
    ];
    controls.forEach((button) => {
      button.disabled = true;
    });
    status.textContent = "处理中…";
    try {
      await handler(e);
    } catch (error) {
      status.textContent = error.message;
    } finally {
      controls.forEach((button) => {
        button.disabled = false;
      });
    }
  });
}

/** Refresh authentication-dependent views after login or logout. */
async function session() {
  const current = await request("/api/auth/get-session");
  const loggedIn = Boolean(current?.user);
  document.querySelector("#account").hidden = loggedIn;
  document.querySelector("#workspace").hidden = !loggedIn;
  document.querySelector("#device").hidden =
    !loggedIn || location.pathname !== "/device";
  document.querySelector("#consent").hidden = true;
  verifiedCode = null;
  if (loggedIn) {
    await onLogin(current.user);
  } else {
    onLogout();
    document.querySelector("#devices").replaceChildren();
    status.textContent = "请先登录。";
  }
  await showConnection(request, loggedIn);
}

action("#account-form", "submit", async (e) => {
  const form = e.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  const endpoint = e.submitter.value;
  if (location.pathname === "/connect")
    values.oauth_query = location.search.slice(1);
  const result = await request(`/api/auth/${endpoint}/email`, values);
  if (location.pathname === "/connect" && result.url) {
    location.assign(result.url);
    return;
  }
  form.reset();
  await session();
});
action("#logout", "click", async () => {
  await request("/api/auth/sign-out", {});
  await session();
});
action("#device-form", "submit", async (e) => {
  verifiedCode = null;
  document.querySelector("#consent").hidden = true;
  const code = String(new FormData(e.currentTarget).get("code")).trim();
  const data = await request(
    `/api/auth/device?user_code=${encodeURIComponent(code)}`,
  );
  verifiedCode = code;
  document.querySelector("#client-info").textContent =
    `客户端：${data.client_id}；代码：${code}`;
  document.querySelector("#consent").hidden = false;
  status.textContent = "请核对客户端与设备代码后选择。";
});
for (const decision of ["approve", "deny"]) {
  action(`#${decision}`, "click", async () => {
    if (!verifiedCode) throw new Error("请先核对设备代码");
    await request(`/api/auth/device/${decision}`, { userCode: verifiedCode });
    verifiedCode = null;
    document.querySelector("#consent").hidden = true;
    status.textContent =
      decision === "approve" ? "已授权，可以返回本地客户端。" : "已拒绝。";
  });
}
action("#sessions", "click", async () => {
  const { connections: sessions } = await request("/api/connections");
  const items = sessions.map((device) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    item.textContent = `${device.name} · ${new Date(device.createdAt).toLocaleString()} `;
    button.textContent = "撤销";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await request("/api/connections/revoke", { id: device.id });
        item.remove();
        status.textContent = "Agent 连接已撤销。";
        await session();
      } catch (error) {
        status.textContent = error.message;
        button.disabled = false;
      }
    });
    item.append(button);
    return item;
  });
  document.querySelector("#devices").replaceChildren(...items);
  status.textContent = `共 ${sessions.length} 个 Agent 授权连接`;
});

/** Initialize generic account views with product-owned workspace renderers. */
export async function initializeAccount(handlers) {
  onLogin = handlers.onLogin;
  onLogout = handlers.onLogout;
  bindConnection(action, request);
  await session();
}
