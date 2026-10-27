/** Popup: configure the relay URL + pairing token, show connection state. */
const $ = (id) => document.getElementById(id);
const STATE_KEY = "mcodeState";

async function refreshStatus() {
  const st = await new Promise((resolve) => chrome.runtime.sendMessage({ type: "status" }, resolve));
  const el = $("status");
  if (st && st.connected) {
    el.textContent = `● 已连接 ${st.url}`;
    el.className = "ok";
  } else {
    el.textContent = "○ 未连接(保存后自动重试)";
    el.className = "bad";
  }
}

chrome.storage.local.get(STATE_KEY).then((got) => {
  const s = got[STATE_KEY];
  if (s) {
    $("url").value = s.serverUrl || "";
    $("token").value = s.token || "";
  }
  refreshStatus();
});

$("save").addEventListener("click", async () => {
  const serverUrl = $("url").value.trim();
  const token = $("token").value.trim();
  const el = $("status");
  if (!/^wss?:\/\/.+:\d+$/.test(serverUrl)) {
    el.textContent = "地址应为 ws://127.0.0.1:端口 形式";
    el.className = "bad";
    return;
  }
  if (!token) {
    el.textContent = "请填写配对令牌";
    el.className = "bad";
    return;
  }
  await chrome.storage.local.set({ [STATE_KEY]: { serverUrl, token } });
  // storage.onChanged re-arms the background connection; give it a beat.
  setTimeout(refreshStatus, 800);
});
