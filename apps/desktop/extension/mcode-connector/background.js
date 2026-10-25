/**
 * Mcode Connector — service worker.
 *
 * Keeps one WebSocket connection to the Mcode app's loopback relay (see
 * main/browser/chromeRelay.ts), authenticating with the pairing token from
 * chrome.storage.local. Forwards the relay's whitelisted CDP commands into
 * this Chrome:
 *
 *   - Target.* commands are translated to chrome.tabs API calls (extensions
 *     cannot attach the debugger to the browser-level target).
 *   - Page.navigate / Runtime.evaluate / Page.captureScreenshot run through
 *     chrome.debugger on the given tab ("targetId" == chrome.tabs tab id).
 *
 * Reconnects with capped backoff. MV3 service-worker suspension is held off
 * by the WebSocket itself on Chrome ≥116 (an active WS counts as an
 * extended-lifetime activity); on unexpected suspension the onStartup /
 * onInstalled hooks plus the popup's poke re-arm the connection.
 */

const STATE_KEY = "mcodeState";
/** { serverUrl: "ws://127.0.0.1:PORT", token: "..." } */
let cfg = null;
let ws = null;
let backoffMs = 1000;
let reconnectTimer = null;
/** Debuggee targets this worker has attached to (tabId -> true). */
const attached = new Set();

async function loadCfg() {
  const got = await chrome.storage.local.get(STATE_KEY);
  cfg = got[STATE_KEY] || null;
  return cfg;
}

function send(frame) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  backoffMs = Math.min(backoffMs * 2, 30000);
  reconnectTimer = setTimeout(connect, backoffMs);
}

function connect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (!cfg || !cfg.serverUrl || !cfg.token) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try {
    ws = new WebSocket(cfg.serverUrl);
  } catch (e) {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    backoffMs = 1000;
    send({ v: 1, type: "hello", token: cfg.token });
  };
  ws.onmessage = (ev) => {
    let frame;
    try {
      frame = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object") return;
    if (frame.type === "welcome") {
      const m = navigator.userAgent.match(/Chrome\/(\S+)/);
      send({ type: "status", chromeVersion: m ? m[1] : "unknown" });
      return;
    }
    if (frame.type === "cmd") handleCommand(frame);
  };
  ws.onclose = (ev) => {
    ws = null;
    attached.clear();
    // 4401 = bad token / token reset — don't hammer the server.
    if (ev.code === 4401 || ev.code === 4409) {
      backoffMs = 1000;
      reconnectTimer = setTimeout(connect, 5000);
      return;
    }
    scheduleReconnect();
  };
  ws.onerror = () => {
    /* onclose follows */
  };
}

function cdpSend(tabId, method, params) {
  return new Promise((resolve, reject) => {
    const debuggee = { tabId };
    const run = () =>
      chrome.debugger.sendCommand(debuggee, method, params || {}, (result) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(result);
      });
    if (attached.has(tabId)) {
      run();
      return;
    }
    chrome.debugger.attach(debuggee, "1.3", () => {
      const err = chrome.runtime.lastError;
      // "Already attached" (another debugger/devtools) — try the command
      // anyway; sendCommand fails through the same reject path if not.
      if (err && !String(err.message).includes("Already attached")) {
        reject(new Error(err.message));
        return;
      }
      attached.add(tabId);
      run();
    });
  });
}

/** Target.* → chrome.tabs translation (no debugger needed). */
function tabsCommand(method, params) {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error(chrome.runtime.lastError?.message || "tabs api failed"));
    if (method === "Target.getTargets") {
      chrome.tabs.query({}, (tabs) => {
        if (chrome.runtime.lastError) return fail();
        resolve({
          targetInfos: tabs.map((t) => ({
            targetId: String(t.id),
            url: t.url || "",
            title: t.title || "",
            attached: attached.has(t.id),
          })),
        });
      });
      return;
    }
    if (method === "Target.createTarget") {
      chrome.tabs.create({ url: (params && params.url) || "about:blank", active: false }, (tab) => {
        if (chrome.runtime.lastError) return fail();
        resolve({ targetId: String(tab.id) });
      });
      return;
    }
    if (method === "Target.activateTarget") {
      chrome.tabs.update(Number(params && params.targetId), { active: true }, () => {
        if (chrome.runtime.lastError) return fail();
        resolve({ ok: true });
      });
      return;
    }
    if (method === "Target.closeTarget") {
      chrome.tabs.remove(Number(params && params.targetId), () => {
        if (chrome.runtime.lastError) return fail();
        resolve({ ok: true });
      });
      return;
    }
    reject(new Error("unsupported method: " + method));
  });
}

async function handleCommand(frame) {
  const reply = { type: "cmdResult", id: frame.id, ok: true };
  try {
    if (frame.method.startsWith("Target.")) {
      reply.result = await tabsCommand(frame.method, frame.params);
    } else {
      const tabId = Number(frame.targetId);
      if (!Number.isFinite(tabId)) throw new Error("cmd requires a numeric targetId (chrome tab id)");
      reply.result = await cdpSend(tabId, frame.method, frame.params);
    }
  } catch (e) {
    reply.ok = false;
    reply.error = String((e && e.message) || e);
  }
  send(reply);
}

chrome.debugger.onDetach.addListener((debuggee) => {
  attached.delete(debuggee.tabId);
});

chrome.runtime.onStartup.addListener(async () => {
  await loadCfg();
  connect();
});
chrome.runtime.onInstalled.addListener(async () => {
  await loadCfg();
  connect();
});
// Popup "save" pokes the worker (storage.onChange also fires in the worker).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STATE_KEY]) {
    loadCfg().then(() => {
      if (ws) {
        try {
          ws.close(1000, "reconfigured");
        } catch (_) {}
        ws = null;
      }
      connect();
    });
  }
});
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg && msg.type === "status") {
    respond({ connected: !!(ws && ws.readyState === WebSocket.OPEN), url: cfg ? cfg.serverUrl : "" });
  }
  return true;
});

// Cold start of the service worker (no event beyond evaluation).
loadCfg().then(connect);
