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
      if (tag === "img" || tag === "script" || val.hasAttribute("src")) {
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
