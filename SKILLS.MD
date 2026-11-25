---
name: browser-extension-bridge
description: >-
  Drive the browser automation WebExtension bridge (bg.js) over WebSocket. Use to
  list, hide, or show tabs, navigate the active tab, run JS in the active tab,
  collect DOM/assets/network logs, read/write cookies/storage/history/bookmarks/
  clipboard, manage downloads, notifications, proxy, extensions, user scripts,
  and dynamic rules. Trigger words: getTabs, navigate, hideTab, showTab, eval,
  getDom, getHtml, collect, getCookies, setCookie, storageGet, storageSet,
  clearBrowsingData, searchHistory, getBookmarks, createBookmark, getNavLog,
  registerUserScript, getDynamicRules, updateDynamicRules, download,
  openDownload, readClipboard, writeClipboard, notify, getProxy, setProxy,
  getExtensions, setExtensionEnabled.
---

# Browser Extension Bridge Skill (bg.js)

Call these methods over a **WebSocket endpoint** (`ws://HOST:PORT`). Each call is
one message; each response is independent. Field names below are exact. `params`
may be sent as an array or via named fields (`url`, `code`, etc.).

## Connection target (read first)

- **Default SERVER:** `127.0.0.1:8767` (WebSocket relay port; `bg.js` connects
  to native host `browser_bridge` over `runtime.connectNative` using stdin/stdout).

### How to resolve the target

IF CONTAINER_MODE is "auto" OR CONTAINER_MODE is "manual":
    HOST = CONTAINER_HOST if set, ELSE "host.containers.internal"
ELSE:
    HOST = "127.0.0.1"
PORT = 8767

- In container mode, use `host.containers.internal` (or explicit
  `CONTAINER_HOST`) to reach the host. Never substitute a guessed IP or fall
  back to loopback if resolution fails; surface the connection error instead.

## Actions (exact field names required by bg.js)

- getTabs() -> {ok, data:[{id,url,title,hidden}]}
- navigate(url=... | params[0]) -> {ok, url}
- hideTab(tabId=... | params[0]) -> {ok, tabId}
- showTab(tabId=... | params[0]) -> {ok, tabId}
- getDom() -> {ok, tabUrl, data:{url,title}}
- eval(code="..." | params[0]) -> {ok, tabUrl, data:result}
- getHtml() -> {ok, tabUrl, data:{url,title,length,html}}
- collect(selector=... | params[0], all=bool, attr=?, includeHtml=bool, includeAssets=bool) -> {ok, tabUrl, data, network:{requests,js,css}}
- getCookies(details={...} | url=...) -> {ok, data:[cookies]}
- setCookie(cookie={...} | msg fields) -> {ok, data:...}
- storageGet(area="local"|"sync", keys=...) -> {ok, data:...}
- storageSet(area="local"|"sync", items={...}) -> {ok}
- clearBrowsingData(options={}, dataToRemove={cache:true,cookies:true}) -> {ok}
- searchHistory(text="", maxResults=50) -> {ok, data:[...]}
- getBookmarks(query="...") -> {ok, data:[...]}
- createBookmark(url, title=?, parentId?) -> {ok, data:...}
- getNavLog(limit=100) -> {ok, data:[...]}
- registerUserScript(script={...} | id,matches,js,code) -> {ok, id:...}
- getDynamicRules() -> {ok, data:[...]}
- updateDynamicRules(addRules=[], removeRuleIds=[]) -> {ok}
- download(url=... | params[0], filename=?, saveAs=bool) -> {ok, downloadId:...}
- openDownload(downloadId=Number(...) | params[0]) -> {ok}
- readClipboard() -> {ok, text:...}
- writeClipboard(text=... | params[0]) -> {ok}
- notify(title=..., message=... | params[0]) -> {ok, notificationId:...}
- getProxy() -> {ok, data:...}
- setProxy(value={...}) -> {ok, data:...}
- getExtensions() -> {ok, data:[...]}
- setExtensionEnabled(id=..., enabled=bool) -> {ok}

## Usage (bash) — named fields and positional params both supported

python3 client_call.py getTabs
python3 client_call.py navigate url="https://example.com"
python3 client_call.py eval code="document.title"
python3 client_call.py collect selector=".item" all=true attr="data-id"
python3 client_call.py storageGet area=local keys='["a"]'

## Notes

- Transport is **WebSocket** (`ws://`), not raw TCP.
- If `CONTAINER_MODE` is active and `host.containers.internal` cannot be
  resolved or reached, fail fast and report the error rather than falling back
  to `127.0.0.1`.
- If something looks wrong with the browser UI, check active tab state (`getTabs`,
  `getDom`) or inspect the page (`getHtml`, `collect`) rather than guessing.