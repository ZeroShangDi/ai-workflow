import { action, request, initializeAccount } from "/foundation/account.js";
const status = document.querySelector("#status");
/** Render validated business content as text instead of executable markup. */
async function refresh() {
  const { notes } = await request("/api/notes");
  const items = notes.map((note) => {
    const item = document.createElement("li");
    item.textContent = note.text;
    return item;
  });
  document.querySelector("#notes").replaceChildren(...items);
  status.textContent = notes.length
    ? `显示最近 ${notes.length} 条笔记`
    : "还没有笔记，写下第一条吧。";
}
action("#note-form", "submit", async (event) => {
  const form = event.currentTarget;
  await request("/api/notes", { text: new FormData(form).get("text") });
  form.reset();
  await refresh();
});
action("#refresh", "click", refresh);
initializeAccount({
  /** Refresh the product workspace after website login. */
  async onLogin(user) {
    document.querySelector("#welcome").textContent = `${user.name} 的笔记`;
    await refresh();
  },
  /** Remove account-owned content immediately after logout. */
  onLogout() {
    document.querySelector("#notes").replaceChildren();
  },
}).catch((error) => {
  status.textContent = error.message;
});
window.addEventListener("focus", () => {
  if (
    location.pathname === "/connect" ||
    document.querySelector("#workspace").hidden
  )
    return;
  refresh().catch((error) => {
    status.textContent = error.message;
  });
});
