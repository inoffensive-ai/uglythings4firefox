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

function safeSerialize(val, depth = 0, seen = new WeakSet()) {
  if (val === null || val === undefined) return null;
  const t = typeof val;
  if (t === "boolean") return val;
  if (t === "number") return Number.isFinite(val) ? val : null;
  if (t === "string") return val.length > 250000 ? val.slice(0, 250000) : val;
  if (t === "bigint") return val.toString();
  if (t === "function") return `[Function: ${val.name || "anonymous"}]`;
  if (t === "symbol") return String(val);
  if (depth >= 8) return "[MaxDepth]";

  if (t === "object") {
    if (seen.has(val)) return "[Circular]";
    seen.add(val);

    if (Array.isArray(val)) {
      return val.slice(0, 500).map((item) => safeSerialize(item, depth + 1, seen));
    }
    if (val instanceof Set) {
      return Array.from(val).slice(0, 500).map((item) => safeSerialize(item, depth + 1, seen));
    }
    if (val instanceof Map) {
      const obj = {};
      let i = 0;
      for (const [k, v] of val.entries()) {
        if (i++ >= 200) break;
        obj[String(k)] = safeSerialize(v, depth + 1, seen);
      }
      return obj;
    }
    if (val instanceof RegExp || val instanceof Date || val instanceof URL) {
      return String(val);
    }
    if (val instanceof Error) {
      return { name: val.name, message: val.message, stack: val.stack || null };
    }
    if (typeof Element !== "undefined" && val instanceof Element) {
      const tag = val.tagName.toLowerCase();
      const out = {
        tag,
        id: val.id || null,
        className: typeof val.className === "string" ? val.className : null,
        text: (val.innerText ?? val.textContent ?? "").trim().slice(0, 1000)
      };
      if (tag === "a" || val.hasAttribute("href")) {
        out.href = val.href || val.getAttribute("href") || null;
      }
      if (tag === "img" || tag === "script" || tag === "iframe" || val.hasAttribute("src")) {
        out.src = val.src || val.getAttribute("src") || null;
      }
      return out;
    }

    const out = {};
    let count = 0;
    for (const k of Object.keys(val)) {
      if (count++ >= 250) break;
      try {
        out[String(k)] = safeSerialize(val[k], depth + 1, seen);
      } catch (err) {
        out[String(k)] = `[Unserializable: ${err && err.message ? err.message : String(err)}]`;
      }
    }
    return out;
  }

  return String(val);
}

function sanitizeNativePayload(obj) {
  const serialized = safeSerialize(obj);
  if (serialized && typeof serialized === "object" && !Array.isArray(serialized)) {
    return serialized;
  }
  return { ok: false, error: "Invalid native response payload" };
}

function postNativeMessage(targetPort, payload) {
  if (!targetPort) return;
  try {
    targetPort.postMessage(sanitizeNativePayload(payload));
  } catch (err) {
    try {
      targetPort.postMessage({
        requestId: payload && payload.requestId,
        ok: false,
        error: `Native postMessage serialization error: ${err && err.message ? err.message : String(err)}`
      });
    } catch (_) {}
  }
}

async function getTargetTab(msg) {
  const explicitTabId = msg.tabId ?? msg.targetTabId;
  if (explicitTabId !== undefined && explicitTabId !== null && explicitTabId !== "") {
    return await browser.tabs.get(Number(explicitTabId));
  }
  const activeTabs = await browser.tabs.query({ active: true, currentWindow: true });
  if (activeTabs && activeTabs[0]) return activeTabs[0];
  const anyActive = await browser.tabs.query({ active: true });
  if (anyActive && anyActive[0]) return anyActive[0];
  const allTabs = await browser.tabs.query({});
  return allTabs[0] || null;
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

  try {
    if (method === "getTabs") {
      const tabs = await browser.tabs.query({});
      return {
        ok: true,
        data: safeSerialize(tabs.map((t) => ({
          id: t.id,
          url: t.url,
          title: t.title,
          hidden: t.hidden,
          active: t.active
        })))
      };
    }

    if (method === "navigate") {
      const url = msg.url ?? params[0];
      if (!url || typeof url !== "string") {
        return { ok: false, error: "navigate requires a valid url" };
      }
      const tab = await getTargetTab(msg);
      if (!tab) return { ok: false, error: "no target tab found" };
      await browser.tabs.update(tab.id, { url });
      return { ok: true, tabId: tab.id, url };
    }

    if (method === "hideTab") {
      const tab = await getTargetTab(msg);
      const tabId = Number(msg.tabId ?? params[0] ?? (tab ? tab.id : undefined));
      if (!Number.isFinite(tabId)) return { ok: false, error: "invalid tabId" };
      await browser.tabs.hide(tabId);
      return { ok: true, tabId };
    }

    if (method === "showTab") {
      const tab = await getTargetTab(msg);
      const tabId = Number(msg.tabId ?? params[0] ?? (tab ? tab.id : undefined));
      if (!Number.isFinite(tabId)) return { ok: false, error: "invalid tabId" };
      await browser.tabs.show(tabId);
      return { ok: true, tabId };
    }

    if (method === "getDom") {
      const tab = await getTargetTab(msg);
      if (!tab) return { ok: false, error: "no target tab found" };
      const res = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => ({
          url: location.href,
          title: document.title || "",
          readyState: document.readyState
        })
      });
      const raw = res && res[0] ? res[0].result : null;
      return { ok: true, tabUrl: tab.url || null, data: safeSerialize(raw) };
    }

    if (method === "eval") {
      const code = msg.code ?? params[0];
      if (typeof code !== "string" || !code.trim()) {
        return { ok: false, error: "eval requires non-empty code string" };
      }
      const tab = await getTargetTab(msg);
      if (!tab) return { ok: false, error: "no target tab found" };
      const res = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        args: [code],
        func: (snippet) => {
          const serializeInPage = (val, depth = 0, seen = new WeakSet()) => {
            if (val === null || val === undefined) return null;
            const t = typeof val;
            if (t === "boolean") return val;
            if (t === "number") return Number.isFinite(val) ? val : null;
            if (t === "string") return val.length > 250000 ? val.slice(0, 250000) : val;
            if (t === "bigint") return val.toString();
            if (t === "function") return `[Function: ${val.name || "anonymous"}]`;
            if (t === "symbol") return String(val);
            if (depth >= 8) return "[MaxDepth]";
            if (t === "object") {
              if (seen.has(val)) return "[Circular]";
              seen.add(val);
              if (Array.isArray(val)) {
                return val.slice(0, 500).map((item) => serializeInPage(item, depth + 1, seen));
              }
              if (val instanceof Set) {
                return Array.from(val).slice(0, 500).map((item) => serializeInPage(item, depth + 1, seen));
              }
              if (val instanceof Map) {
                const obj = {};
                let i = 0;
                for (const [k, v] of val.entries()) {
                  if (i++ >= 200) break;
                  obj[String(k)] = serializeInPage(v, depth + 1, seen);
                }
                return obj;
              }
              if (val instanceof RegExp || val instanceof Date || val instanceof URL) {
                return String(val);
              }
              if (typeof Element !== "undefined" && val instanceof Element) {
                const tag = val.tagName.toLowerCase();
                const item = {
                  tag,
                  id: val.id || null,
                  className: typeof val.className === "string" ? val.className : null,
                  text: (val.innerText ?? val.textContent ?? "").trim().slice(0, 1000)
                };
                if (tag === "a" || val.hasAttribute("href")) {
                  item.href = val.href || val.getAttribute("href") || null;
                }
                if (tag === "img" || tag === "script" || val.hasAttribute("src")) {
                  item.src = val.src || val.getAttribute("src") || null;
                }
                return item;
              }
              const obj = {};
              let count = 0;
              for (const k of Object.keys(val)) {
                if (count++ >= 250) break;
                try {
                  obj[String(k)] = serializeInPage(val[k], depth + 1, seen);
                } catch (e) {
                  obj[String(k)] = `[Unserializable: ${e && e.message ? e.message : String(e)}]`;
                }
              }
              return obj;
            }
            return String(val);
          };

          const rawResult = (0, eval)(snippet);
          return serializeInPage(rawResult);
        }
      });
      const first = res && res[0] ? res[0] : null;
      if (first && first.error) {
        return { ok: false, tabUrl: tab.url || null, error: String(first.error) };
      }
      return { ok: true, tabUrl: tab.url || null, data: safeSerialize(first ? first.result : null) };
    }

    if (method === "getHtml") {
      const tab = await getTargetTab(msg);
      if (!tab) return { ok: false, error: "no target tab found" };
      const res = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const html = document.documentElement ? document.documentElement.outerHTML : "";
          return {
            url: location.href,
            title: document.title || "",
            length: html.length,
            html: html.length > 500000 ? html.slice(0, 500000) : html,
            truncated: html.length > 500000
          };
        }
      });
      const raw = res && res[0] ? res[0].result : null;
      return { ok: true, tabUrl: tab.url || null, data: safeSerialize(raw) };
    }

    if (method === "collect") {
      const selector = msg.selector ?? params[0] ?? null;
      const all = Boolean(msg.all);
      const attr = msg.attr ?? null;
      const includeHtml = msg.includeHtml !== undefined ? Boolean(msg.includeHtml) : false;
      const includeAssets = msg.includeAssets !== undefined ? Boolean(msg.includeAssets) : false;
      const includeNetwork = msg.includeNetwork !== undefined ? Boolean(msg.includeNetwork) : false;
      const tab = await getTargetTab(msg);
      if (!tab) return { ok: false, error: "no target tab found" };

      const res = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        args: [selector, all, attr, includeHtml, includeAssets],
        func: (sel, isAll, attribute, wantHtml, wantAssets) => {
          const serializeEl = (el) => {
            const tag = el.tagName.toLowerCase();
            const out = {
              tag,
              text: (el.innerText ?? el.textContent ?? "").trim().slice(0, 2000)
            };
            if (tag === "a" || el.hasAttribute("href")) {
              out.href = el.href || el.getAttribute("href") || null;
            }
            if (tag === "img" || tag === "script" || el.hasAttribute("src")) {
              out.src = el.src || el.getAttribute("src") || null;
            }
            if (wantHtml) {
              out.html = el.outerHTML.slice(0, 10000);
            }
            if (attribute) {
              out.attr = el.getAttribute(attribute);
            }
            return out;
          };

          const collectAssets = () => {
            const scripts = Array.from(document.scripts || []).slice(0, 100).map((s) => ({
              src: s.src || null,
              type: s.type || null,
              inlineLength: s.src ? 0 : (s.textContent || "").length
            }));
            const styles = Array.from(document.querySelectorAll('link[rel~="stylesheet"], style')).slice(0, 100).map((el) =>
              el.tagName.toLowerCase() === "style"
                ? { kind: "style", href: null, inlineLength: (el.textContent || "").length }
                : { kind: "link", href: el.href || el.getAttribute("href") || null, inlineLength: 0 }
            );
            return { scripts, styles };
          };

          let targetData = null;
          if (!sel) {
            const bodyText = document.body ? (document.body.innerText || "") : "";
            targetData = {
              url: location.href,
              title: document.title || "",
              text: bodyText.slice(0, 50000),
              textTruncated: bodyText.length > 50000
            };
            if (wantHtml) {
              const docHtml = document.documentElement ? document.documentElement.outerHTML : "";
              targetData.html = docHtml.slice(0, 200000);
              targetData.htmlTruncated = docHtml.length > 200000;
            }
          } else if (isAll) {
            targetData = Array.from(document.querySelectorAll(sel))
              .slice(0, 500)
              .map(serializeEl);
          } else {
            const el = document.querySelector(sel);
            targetData = el ? serializeEl(el) : null;
          }

          return wantAssets ? { target: targetData, assets: collectAssets() } : targetData;
        }
      });

      const response = {
        ok: true,
        tabUrl: tab.url || null,
        data: safeSerialize(res && res[0] ? res[0].result : null)
      };

      if (includeNetwork) {
        const entries = Array.from(networkLog.values()).slice(-100).map((e) => ({
          requestId: e.requestId,
          url: e.url,
          method: e.method,
          type: e.type,
          tabId: e.tabId,
          statusCode: e.statusCode ?? null,
          statusLine: e.statusLine ?? null,
          rawBytes: e.rawBytes ?? null
        }));
        response.network = {
          requests: entries,
          js: entries.filter((e) => e.type === "script"),
          css: entries.filter((e) => e.type === "stylesheet")
        };
      }

      return safeSerialize(response);
    }

    if (method === "getCookies") {
      const details = msg.details || (msg.url ? { url: msg.url } : {});
      return { ok: true, data: safeSerialize(await browser.cookies.getAll(details)) };
    }

    if (method === "setCookie") {
      const details = msg.cookie || msg;
      return { ok: true, data: safeSerialize(await browser.cookies.set(details)) };
    }

    if (method === "storageGet") {
      const area = msg.area === "sync" ? browser.storage.sync : browser.storage.local;
      return { ok: true, data: safeSerialize(await area.get(msg.keys ?? null)) };
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
      return {
        ok: true,
        data: safeSerialize(await browser.history.search({
          text: msg.text || "",
          maxResults: Number(msg.maxResults || 50)
        }))
      };
    }

    if (method === "getBookmarks") {
      return {
        ok: true,
        data: safeSerialize(msg.query ? await browser.bookmarks.search(msg.query) : await browser.bookmarks.getTree())
      };
    }

    if (method === "createBookmark") {
      return {
        ok: true,
        data: safeSerialize(await browser.bookmarks.create({
          title: msg.title || msg.url,
          url: msg.url,
          parentId: msg.parentId
        }))
      };
    }

    if (method === "getNavLog") {
      return { ok: true, data: safeSerialize(navLog.slice(-Number(msg.limit || 100))) };
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
      return { ok: true, data: safeSerialize(await browser.declarativeNetRequest.getDynamicRules()) };
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
      return { ok: true, text: safeSerialize(await navigator.clipboard.readText()) };
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
      return { ok: true, data: safeSerialize(await browser.proxy.settings.get({})) };
    }

    if (method === "setProxy") {
      return { ok: true, data: safeSerialize(await browser.proxy.settings.set({ value: msg.value || {} })) };
    }

    if (method === "getExtensions") {
      return { ok: true, data: safeSerialize(await browser.management.getAll()) };
    }

    if (method === "setExtensionEnabled") {
      await browser.management.setEnabled(msg.id, Boolean(msg.enabled));
      return { ok: true };
    }

    return { ok: false, error: "unknown method" };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : String(err)
    };
  }
}

connectPort();
