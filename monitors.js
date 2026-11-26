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
