let port = null;
let reconnectTimer = null;

function scheduleReconnect(delayMs = 1000) {
  if (reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectPort();
  }, delayMs);
}

function connectPort() {
  if (port) return port;
  const p = browser.runtime.connectNative("browser_bridge");
  p.onMessage.addListener(async (msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.requestId !== undefined) {
      try {
        const result = await handleCommand(msg);
        postNativeMessage(p, { requestId: msg.requestId, ...result });
      } catch (err) {
        postNativeMessage(p, {
          requestId: msg.requestId,
          ok: false,
          error: err && err.message ? err.message : String(err)
        });
      }
    }
  });
  p.onDisconnect.addListener((disconnectedPort) => {
    const err = disconnectedPort.error ? disconnectedPort.error.message : "disconnected";
    console.warn("Native port disconnected:", err);
    port = null;
    scheduleReconnect(1000);
  });
  port = p;
  return port;
}

async function handleCommand(msg) {
  const method = msg.method || msg.type;
  const params = Array.isArray(msg.params) ? msg.params : [];
  if (!method || typeof method !== "string") {
    return { ok: false, error: "missing method" };
  }
  const fn = typeof ACTION_HANDLERS !== "undefined" ? ACTION_HANDLERS[method] : null;
  if (typeof fn !== "function") {
    return { ok: false, error: "unknown method" };
  }
  try {
    return await fn(msg, params);
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : String(err)
    };
  }
}

connectPort();
