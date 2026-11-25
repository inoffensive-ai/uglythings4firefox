let port = null;
let reconnectTimer = null;
const networkLog = new Map();
const MAX_NETWORK_ENTRIES = 200;
const navLog = [];
const MAX_NAV_ENTRIES = 200;

function trimNetworkLog() {
  while (networkLog.size > MAX_NETWORK_ENTRIES) {
    const oldestKey = networkLog.keys().next().value;
    networkLog.delete(oldestKey);
  }
}

function recordEntry(requestId, patch) {
  const prev = networkLog.get(requestId) || { requestId };
  networkLog.set(requestId, { ...prev, ...patch });
  trimNetworkLog();
}

function recordNav(eventName, details) {
  navLog.push({ event: eventName, ...details, recordedAt: Date.now() });
  if (navLog.length > MAX_NAV_ENTRIES) {
    navLog.splice(0, navLog.length - MAX_NAV_ENTRIES);
  }
}

if (browser.webNavigation) {
  browser.webNavigation.onCommitted.addListener((d) => recordNav("onCommitted", d));
  browser.webNavigation.onDOMContentLoaded.addListener((d) => recordNav("onDOMContentLoaded", d));
  browser.webNavigation.onCompleted.addListener((d) => recordNav("onCompleted", d));
}

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    const entry = {
      requestId: details.requestId,
      url: details.url,
      method: details.method,
      type: details.type,
      tabId: details.tabId,
      timeStamp: details.timeStamp,
      requestBody: details.requestBody || null,
      responseHeaders: null,
      statusCode: null,
      rawBase64: null,
      rawText: null
    };
    recordEntry(details.requestId, entry);

    if (
      typeof browser.webRequest.filterResponseData === "function" &&
      /^https?:/i.test(details.url)
    ) {
      try {
        const filter = browser.webRequest.filterResponseData(details.requestId);
        const chunks = [];
        filter.ondata = (evt) => {
          chunks.push(new Uint8Array(evt.data));
          filter.write(evt.data);
        };
        filter.onstop = () => {
          const totalLen = chunks.reduce((acc, c) => acc + c.byteLength, 0);
          const merged = new Uint8Array(totalLen);
          let offset = 0;
          for (const c of chunks) {
            merged.set(c, offset);
            offset += c.byteLength;
          }
          let bin = "";
          for (let i = 0; i < merged.byteLength; i += 0x8000) {
            bin += String.fromCharCode.apply(null, merged.subarray(i, i + 0x8000));
          }
          recordEntry(details.requestId, {
            rawBase64: btoa(bin),
            rawText: new TextDecoder("utf-8", { fatal: false }).decode(merged),
            rawBytes: totalLen
          });
          if (filter.status === "transferringdata") {
            filter.close();
          }
        };
        filter.onerror = () => {
          recordEntry(details.requestId, { filterError: filter.error || "filter error" });
          if (filter.status === "transferringdata" || filter.status === "open") {
            try { filter.close(); } catch (_) {}
          }
        };
      } catch (_) {}
    }
  },
  { urls: ["<all_urls>"] },
  ["requestBody"]
);

browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    recordEntry(details.requestId, {
      statusCode: details.statusCode,
      statusLine: details.statusLine,
      responseHeaders: details.responseHeaders || []
    });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

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
        p.postMessage({ requestId: msg.requestId, ...result });
      } catch (err) {
        p.postMessage({
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
  const params = msg.params || [];

  try {
    if (method === "getTabs") {
      const tabs = await browser.tabs.query({});
      return { ok: true, data: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, hidden: t.hidden })) };
    }

    if (method === "navigate") {
      const url = params[0] || msg.url;
      const tab = (await browser.tabs.query({ active: true, currentWindow: true }))[0];
      await browser.tabs.update(tab.id, { url });
      return { ok: true, url };
    }

    if (method === "hideTab") {
      const tabId = Number(msg.tabId ?? params[0] ?? (await browser.tabs.query({ active: true, currentWindow: true }))[0].id);
      await browser.tabs.hide(tabId);
      return { ok: true, tabId };
    }

    if (method === "showTab") {
      const tabId = Number(msg.tabId ?? params[0]);
      await browser.tabs.show(tabId);
      return { ok: true, tabId };
    }

    if (method === "getDom") {
      const tab = (await browser.tabs.query({ active: true, currentWindow: true }))[0];
      const res = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => ({ url: location.href, title: document.title })
      });
      return { ok: true, tabUrl: tab ? tab.url : null, data: res && res[0] ? (res[0].result ?? null) : null };
    }

    if (method === "eval") {
      const code = msg.code || params[0];
      const tab = (await browser.tabs.query({ active: true, currentWindow: true }))[0];
      const res = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        args: [code],
        func: (snippet) => (0, eval)(snippet)
      });
      return { ok: true, tabUrl: tab ? tab.url : null, data: res && res[0] ? (res[0].result ?? null) : null };
    }

    if (method === "getHtml") {
      const tab = (await browser.tabs.query({ active: true, currentWindow: true }))[0];
      const res = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => ({
          url: location.href,
          title: document.title,
          length: document.documentElement.outerHTML.length,
          html: document.documentElement.outerHTML
        })
      });
      return { ok: true, tabUrl: tab ? tab.url : null, data: res && res[0] ? (res[0].result ?? null) : null };
    }

    if (method === "collect") {
      const selector = msg.selector || params[0] || null;
      const all = Boolean(msg.all);
      const attr = msg.attr || null;
      const includeHtml = msg.includeHtml !== undefined ? Boolean(msg.includeHtml) : true;
      const includeAssets = msg.includeAssets !== undefined ? Boolean(msg.includeAssets) : true;
      const tab = (await browser.tabs.query({ active: true, currentWindow: true }))[0];

      const res = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        args: [selector, all, attr, includeHtml, includeAssets],
        func: (sel, isAll, attribute, wantHtml, wantAssets) => {
          const serialize = (el) => {
            const out = { tag: el.tagName.toLowerCase(), text: el.innerText ?? el.textContent ?? "" };
            if (wantHtml) out.html = el.outerHTML;
            if (attribute) out.attr = el.getAttribute(attribute);
            return out;
          };
          const collectAssets = () => {
            const scripts = Array.from(document.scripts || []).map(s => ({
              src: s.src || null, type: s.type || null, inline: s.src ? null : s.textContent
            }));
            const styles = Array.from(document.querySelectorAll('link[rel~="stylesheet"], style')).map(el =>
              el.tagName.toLowerCase() === "style"
                ? { kind: "style", href: null, inline: el.textContent }
                : { kind: "link", href: el.href || el.getAttribute("href"), inline: null }
            );
            return { scripts, styles };
          };
          let targetData = null;
          if (!sel) {
            targetData = { url: location.href, title: document.title, text: document.body ? document.body.innerText : "" };
            if (wantHtml) targetData.html = document.documentElement.outerHTML;
          } else if (isAll) {
            targetData = Array.from(document.querySelectorAll(sel)).map(serialize);
          } else {
            const el = document.querySelector(sel);
            targetData = el ? serialize(el) : null;
          }
          return wantAssets ? { target: targetData, assets: collectAssets() } : targetData;
        }
      });

      const entries = Array.from(networkLog.values());
      return {
        ok: true,
        tabUrl: tab ? tab.url : null,
        data: res && res[0] ? (res[0].result ?? null) : null,
        network: {
          requests: entries,
          js: entries.filter(e => e.type === "script"),
          css: entries.filter(e => e.type === "stylesheet")
        }
      };
    }

    if (method === "getCookies") {
      const details = msg.details || (msg.url ? { url: msg.url } : {});
      return { ok: true, data: await browser.cookies.getAll(details) };
    }

    if (method === "setCookie") {
      const details = msg.cookie || msg;
      return { ok: true, data: await browser.cookies.set(details) };
    }

    if (method === "storageGet") {
      const area = msg.area === "sync" ? browser.storage.sync : browser.storage.local;
      return { ok: true, data: await area.get(msg.keys ?? null) };
    }

    if (method === "storageSet") {
      const area = msg.area === "sync" ? browser.storage.sync : browser.storage.local;
      await area.set(msg.items || {});
      return { ok: true };
    }

    if (method === "clearBrowsingData") {
      const options = msg.options || {};
      const dataToRemove = msg.dataToRemove || { cache: true, cookies: true };
      await browser.browsingData.remove(options, dataToRemove);
      return { ok: true };
    }

    if (method === "searchHistory") {
      return { ok: true, data: await browser.history.search({ text: msg.text || "", maxResults: Number(msg.maxResults || 50) }) };
    }

    if (method === "getBookmarks") {
      return { ok: true, data: msg.query ? await browser.bookmarks.search(msg.query) : await browser.bookmarks.getTree() };
    }

    if (method === "createBookmark") {
      return { ok: true, data: await browser.bookmarks.create({ title: msg.title || msg.url, url: msg.url, parentId: msg.parentId }) };
    }

    if (method === "getNavLog") {
      return { ok: true, data: navLog.slice(-Number(msg.limit || 100)) };
    }

    if (method === "registerUserScript") {
      if (!browser.userScripts) {
        const granted = await browser.permissions.request({ permissions: ["userScripts"] });
        if (!granted) {
          return { ok: false, error: "userScripts permission not granted" };
        }
      }
      const scriptSpec = msg.script || {
        id: msg.id || `bridge-us-${Date.now()}`,
        matches: msg.matches || ["<all_urls>"],
        js: msg.js || [{ code: msg.code || "" }]
      };
      await browser.userScripts.register([scriptSpec]);
      return { ok: true, id: scriptSpec.id };
    }

    if (method === "getDynamicRules") {
      return { ok: true, data: await browser.declarativeNetRequest.getDynamicRules() };
    }

    if (method === "updateDynamicRules") {
      await browser.declarativeNetRequest.updateDynamicRules({
        addRules: msg.addRules || [],
        removeRuleIds: msg.removeRuleIds || []
      });
      return { ok: true };
    }

    if (method === "download") {
      const id = await browser.downloads.download({
        url: msg.url || params[0],
        filename: msg.filename,
        saveAs: Boolean(msg.saveAs)
      });
      return { ok: true, downloadId: id };
    }

    if (method === "openDownload") {
      await browser.downloads.open(Number(msg.downloadId ?? params[0]));
      return { ok: true };
    }

    if (method === "readClipboard") {
      return { ok: true, text: await navigator.clipboard.readText() };
    }

    if (method === "writeClipboard") {
      await navigator.clipboard.writeText(String(msg.text ?? params[0] ?? ""));
      return { ok: true };
    }

    if (method === "notify") {
      const notifId = await browser.notifications.create({
        type: "basic",
        title: msg.title || "Browser Bridge",
        message: msg.message || params[0] || ""
      });
      return { ok: true, notificationId: notifId };
    }

    if (method === "getProxy") {
      return { ok: true, data: await browser.proxy.settings.get({}) };
    }

    if (method === "setProxy") {
      return { ok: true, data: await browser.proxy.settings.set({ value: msg.value || {} }) };
    }

    if (method === "getExtensions") {
      return { ok: true, data: await browser.management.getAll() };
    }

    if (method === "setExtensionEnabled") {
      await browser.management.setEnabled(msg.id, Boolean(msg.enabled));
      return { ok: true };
    }

    return { ok: false, error: "unknown method" };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

connectPort();