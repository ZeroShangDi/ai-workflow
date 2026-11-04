/** Render signed OAuth context without accepting permission labels from an unverified URL. */
export async function showConnection(request, loggedIn) {
  const panel = document.querySelector("#oauth");
  panel.hidden = true;
  if (location.pathname !== "/connect" || !loggedIn) return;
  const context = await request("/api/connection-context", {
    query: location.search.slice(1),
  });
  const client = loggedIn
    ? await request(
        `/api/auth/oauth2/public-client?client_id=${encodeURIComponent(context.clientId)}`,
      )
    : null;
  const scopes = context.scopes.split(" ").join("、");
  document.querySelector("#oauth-details").textContent =
    `客户端：${client?.client_name ?? context.clientId}。请求权限：${scopes}。`;
  panel.hidden = !loggedIn;
  if (loggedIn)
    document.querySelector("#status").textContent =
      "请确认是否允许此客户端访问你的数据。";
}

/** Complete provider-validated consent and return to the requesting Agent. */
export function bindConnection(action, request) {
  for (const accept of [true, false]) {
    action(accept ? "#oauth-approve" : "#oauth-deny", "click", async () => {
      const data = await request("/api/auth/oauth2/consent", {
        accept,
        oauth_query: location.search.slice(1),
      });
      if (!data.url) throw new Error("授权服务未返回跳转地址");
      location.assign(data.url);
    });
  }
}
