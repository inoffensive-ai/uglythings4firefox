// Runs in page context — exposes an API callable by the background worker.
// Communicates back via browser.runtime messaging (cross-context).

(function () {
  // Guard against double-injection
  if (window.__BRIDGE_INJECTED__) return;
  window.__BRIDGE_INJECTED__ = true;

  const BRIDGE_CHANNEL = "bridge-api-v1";

  // Execute arbitrary code in the PAGE context (not isolated extension world)
  async function evalInPage(code) {
    try {
      const result = await new Promise((resolve, reject) => {
        window.postMessage({ __BRIDGE__: true, code }, "*");
        window.addEventListener("message", function handler(evt) {
          if (evt.data && evt.data.__BRIDGE_RESULT__) {
            window.removeEventListener("message", handler);
            resolve(evt.data.payload);
          }
        });
      });
      return { ok: true, value: result };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // Read DOM info from the page context
  function readDom() {
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      cookies: document.cookie,
      userAgent: navigator.userAgent,
      height: document.documentElement.scrollHeight,
    };
  }

  // Handle messages from the background worker
  browser.runtime.onMessage.addListener(async (msg) => {
    switch (msg.type) {
      case "getDom":
        return { ok: true, data: readDom() };
      case "eval":
        return evalInPage(msg.code);
      case "getPageInfo":
        return { ok: true, data: readDom() };
    }
    return { ok: false, error: "unknown type" };
  });

  // Notify background that the content script is live (optional)
  browser.runtime.sendMessage({ type: "bridgeReady", url: location.href }).catch(() => {});
})();

