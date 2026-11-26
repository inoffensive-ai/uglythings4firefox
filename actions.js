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

const ACTION_HANDLERS = {
  async getTabs() {
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
  },

  async navigate(msg, params) {
    const url = msg.url ?? params[0];
    if (!url || typeof url !== "string") {
      return { ok: false, error: "navigate requires a valid url" };
    }
    const tab = await getTargetTab(msg);
    if (!tab) return { ok: false, error: "no target tab found" };
    await browser.tabs.update(tab.id, { url });
    return { ok: true, tabId: tab.id, url };
  },

  async hideTab(msg, params) {
    const tab = await getTargetTab(msg);
    const tabId = Number(msg.tabId ?? params[0] ?? (tab ? tab.id : undefined));
    if (!Number.isFinite(tabId)) return { ok: false, error: "invalid tabId" };
    await browser.tabs.hide(tabId);
    return { ok: true, tabId };
  },

  async showTab(msg, params) {
    const tab = await getTargetTab(msg);
    const tabId = Number(msg.tabId ?? params[0] ?? (tab ? tab.id : undefined));
    if (!Number.isFinite(tabId)) return { ok: false, error: "invalid tabId" };
    await browser.tabs.show(tabId);
    return { ok: true, tabId };
  },

  async getDom(msg) {
    const tab = await getTargetTab(msg);
    if (!tab) return { ok: false, error: "no target tab found" };
    const res = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      injectImmediately: true,
      func: () => ({
        url: location.href,
        title: document.title || "",
        readyState: document.readyState
      })
    });
    const raw = res && res[0] ? res[0].result : null;
    return { ok: true, tabUrl: tab.url || null, data: safeSerialize(raw) };
  },

  async eval(msg, params) {
    const code = msg.code ?? params[0];
    if (typeof code !== "string" || !code.trim()) {
      return { ok: false, error: "eval requires non-empty code string" };
    }
    const tab = await getTargetTab(msg);
    if (!tab) return { ok: false, error: "no target tab found" };
    const res = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      injectImmediately: true,
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
            if (val instanceof Error) {
              return { name: val.name, message: val.message, stack: val.stack || null };
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

        return serializeInPage(new Function(snippet)());
      }
    });
    const first = res && res[0] ? res[0] : null;
    if (first && first.error) {
      return { ok: false, tabUrl: tab.url || null, error: String(first.error) };
    }
    return { ok: true, tabUrl: tab.url || null, data: safeSerialize(first ? first.result : null) };
  },

  async getHtml(msg) {
    const tab = await getTargetTab(msg);
    if (!tab) return { ok: false, error: "no target tab found" };
    const res = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      injectImmediately: true,
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
  },

  async collect(msg, params) {
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
      injectImmediately: true,
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
  },

  async press(msg, params) {
    const selector = msg.selector ?? params[0] ?? null;
    const matchText = typeof msg.text === "string" ? msg.text.trim().toLowerCase() : null;
    const index = Number.isFinite(Number(msg.index)) ? Number(msg.index) : 0;
    const key = typeof msg.key === "string" && msg.key.trim() ? msg.key.trim() : "Enter";
    const tab = await getTargetTab(msg);
    if (!tab) return { ok: false, error: "no target tab found" };

    const res = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      injectImmediately: true,
      args: [selector, matchText, index, key],
      func: (sel, wantedText, idx, keyName) => {
        let target = document.activeElement;
        let matchedCount = 0;

        if (sel) {
          const candidates = Array.from(document.querySelectorAll(sel)).filter((el) => {
            if (!wantedText) return true;
            const txt = (el.innerText || el.textContent || "").trim().toLowerCase();
            const aria = (el.getAttribute("aria-label") || "").trim().toLowerCase();
            return txt.includes(wantedText) || aria.includes(wantedText);
          });
          matchedCount = candidates.length;
          target = candidates[idx] || null;
        }

        if (!target) {
          return { pressed: false, matchedCount, key: keyName, url: location.href };
        }

        if (typeof target.scrollIntoView === "function") {
          target.scrollIntoView({ block: "center", inline: "nearest" });
        }
        if (typeof target.focus === "function") {
          target.focus({ preventScroll: true });
        }

        const keyCode = keyName === "Enter" ? 13 : keyName === "Space" || keyName === " " ? 32 : keyName === "Escape" ? 27 : 0;
        const code = keyName === " " ? "Space" : keyName;

        for (const evType of ["pointerdown", "mousedown"]) {
          target.dispatchEvent(new MouseEvent(evType, { bubbles: true, cancelable: true, view: window }));
        }
        target.dispatchEvent(new KeyboardEvent("keydown", { key: keyName, code, keyCode, which: keyCode, bubbles: true, cancelable: true }));
        target.dispatchEvent(new KeyboardEvent("keypress", { key: keyName, code, keyCode, which: keyCode, bubbles: true, cancelable: true }));
        for (const evType of ["pointerup", "mouseup", "click"]) {
          target.dispatchEvent(new MouseEvent(evType, { bubbles: true, cancelable: true, view: window }));
        }
        target.dispatchEvent(new KeyboardEvent("keyup", { key: keyName, code, keyCode, which: keyCode, bubbles: true, cancelable: true }));

        return {
          pressed: true,
          matchedCount,
          key: keyName,
          tag: target.tagName.toLowerCase(),
          text: (target.innerText || target.textContent || "").trim().slice(0, 120),
          href: target.href || target.getAttribute("href") || null,
          url: location.href
        };
      }
    });

    const first = res && res[0] ? res[0] : null;
    if (first && first.error) {
      return { ok: false, tabUrl: tab.url || null, error: String(first.error) };
    }
    return { ok: true, tabUrl: tab.url || null, data: safeSerialize(first ? first.result : null) };
  },

  async click(msg, params) {
    const selector = msg.selector ?? params[0];
    const matchText = typeof msg.text === "string" ? msg.text.trim().toLowerCase() : null;
    const index = Number.isFinite(Number(msg.index)) ? Number(msg.index) : 0;
    if (!selector || typeof selector !== "string") {
      return { ok: false, error: "click requires a CSS selector" };
    }
    const tab = await getTargetTab(msg);
    if (!tab) return { ok: false, error: "no target tab found" };

    const res = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      injectImmediately: true,
      args: [selector, matchText, index],
      func: (sel, wantedText, idx) => {
        const candidates = Array.from(document.querySelectorAll(sel)).filter((el) => {
          if (!wantedText) return true;
          const txt = (el.innerText || el.textContent || "").trim().toLowerCase();
          const aria = (el.getAttribute("aria-label") || "").trim().toLowerCase();
          return txt.includes(wantedText) || aria.includes(wantedText);
        });
        const target = candidates[idx];
        if (!target) {
          return { clicked: false, matchedCount: candidates.length, url: location.href };
        }
        if (typeof target.scrollIntoView === "function") {
          target.scrollIntoView({ block: "center", inline: "nearest" });
        }
        target.click();
        return {
          clicked: true,
          matchedCount: candidates.length,
          tag: target.tagName.toLowerCase(),
          text: (target.innerText || target.textContent || "").trim().slice(0, 120),
          href: target.href || target.getAttribute("href") || null,
          url: location.href
        };
      }
    });

    const first = res && res[0] ? res[0] : null;
    if (first && first.error) {
      return { ok: false, tabUrl: tab.url || null, error: String(first.error) };
    }
    return { ok: true, tabUrl: tab.url || null, data: safeSerialize(first ? first.result : null) };
  },

  async getCookies(msg) {
    const details = msg.details || (msg.url ? { url: msg.url } : {});
    return { ok: true, data: safeSerialize(await browser.cookies.getAll(details)) };
  },

  async setCookie(msg) {
    const details = msg.cookie || msg;
    return { ok: true, data: safeSerialize(await browser.cookies.set(details)) };
  },

  async storageGet(msg) {
    const area = msg.area === "sync" ? browser.storage.sync : browser.storage.local;
    return { ok: true, data: safeSerialize(await area.get(msg.keys ?? null)) };
  },

  async storageSet(msg) {
    const area = msg.area === "sync" ? browser.storage.sync : browser.storage.local;
    await area.set(msg.items || {});
    return { ok: true };
  },

  async clearBrowsingData(msg) {
    const options = msg.options || {};
    const dataToRemove = msg.dataToRemove || { cache: true, cookies: true };
    await browser.browsingData.remove(options, dataToRemove);
    return { ok: true };
  },

  async searchHistory(msg) {
    return {
      ok: true,
      data: safeSerialize(await browser.history.search({
        text: msg.text || "",
        maxResults: Number(msg.maxResults || 50)
      }))
    };
  },

  async getBookmarks(msg) {
    return {
      ok: true,
      data: safeSerialize(msg.query ? await browser.bookmarks.search(msg.query) : await browser.bookmarks.getTree())
    };
  },

  async createBookmark(msg) {
    return {
      ok: true,
      data: safeSerialize(await browser.bookmarks.create({
        title: msg.title || msg.url,
        url: msg.url,
        parentId: msg.parentId
      }))
    };
  },

  async getNavLog(msg) {
    return { ok: true, data: safeSerialize(navLog.slice(-Number(msg.limit || 100))) };
  },

  async registerUserScript(msg) {
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
  },

  async getDynamicRules() {
    return { ok: true, data: safeSerialize(await browser.declarativeNetRequest.getDynamicRules()) };
  },

  async updateDynamicRules(msg) {
    await browser.declarativeNetRequest.updateDynamicRules({
      addRules: msg.addRules || [],
      removeRuleIds: msg.removeRuleIds || []
    });
    return { ok: true };
  },

  async download(msg, params) {
    const id = await browser.downloads.download({
      url: msg.url || params[0],
      filename: msg.filename,
      saveAs: Boolean(msg.saveAs)
    });
    return { ok: true, downloadId: id };
  },

  async openDownload(msg, params) {
    await browser.downloads.open(Number(msg.downloadId ?? params[0]));
    return { ok: true };
  },

  async readClipboard() {
    return { ok: true, text: safeSerialize(await navigator.clipboard.readText()) };
  },

  async writeClipboard(msg, params) {
    await navigator.clipboard.writeText(String(msg.text ?? params[0] ?? ""));
    return { ok: true };
  },

  async notify(msg, params) {
    const notifId = await browser.notifications.create({
      type: "basic",
      title: msg.title || "Browser Bridge",
      message: msg.message || params[0] || ""
    });
    return { ok: true, notificationId: notifId };
  },

  async getProxy() {
    return { ok: true, data: safeSerialize(await browser.proxy.settings.get({})) };
  },

  async setProxy(msg) {
    return { ok: true, data: safeSerialize(await browser.proxy.settings.set({ value: msg.value || {} })) };
  },

  async getExtensions() {
    return { ok: true, data: safeSerialize(await browser.management.getAll()) };
  },

  async setExtensionEnabled(msg) {
    await browser.management.setEnabled(msg.id, Boolean(msg.enabled));
    return { ok: true };
  }
};
