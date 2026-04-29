importScripts("utils/translator.js");

/** DeepSeek Chat 兼容：不传 thinking 可避免其他 OpenAI 兼容端因未知字段报错 */
function buildThinkingExtras(mode) {
  const m = String(mode || "omit").toLowerCase();
  if (m === "enabled") return { thinking: { type: "enabled" } };
  if (m === "disabled") return { thinking: { type: "disabled" } };
  return {};
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "translate-page",
      title: "翻译当前页面",
      contexts: ["page", "frame", "selection"]
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || typeof tab.id !== "number") return;
  const ready = await ensureContentScriptReady(tab.id);
  if (ready.ok) {
    await safeSendMessage(tab.id, { type: "TRANSLATE_PAGE" });
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "translate-page") return;
  const tab = await getActiveTab();
  if (tab && typeof tab.id === "number") {
    const ready = await ensureContentScriptReady(tab.id);
    if (ready.ok) await safeSendMessage(tab.id, { type: "TOGGLE_SHORTCUT_TRANSLATION" });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "POPUP_TRANSLATE_ACTIVE_TAB") {
    handlePopupTranslate(message)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message.type === "OPEN_SHORTCUTS") {
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message.type === "TEST_API_CONNECTION") {
    testApiConnection()
      .then((r) => sendResponse({ ok: true, result: r }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  return false;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "page-translate") return;
  port.onMessage.addListener((message) => {
    if (message.type === "translate-all") {
      translateAll(message, port).catch((error) => {
        safePortPost(port, {
          type: "translate-error",
          requestId: message.requestId,
          error: error.message
        });
      });
    }
  });
});

function safePortPost(port, msg) {
  try { port.postMessage(msg); } catch (_) {}
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function safeSendMessage(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return true;
  } catch (error) {
    const m = String(error.message || "");
    if (
      m.includes("Receiving end does not exist") ||
      m.includes("Cannot access") ||
      m.includes("No tab with id") ||
      m.includes("Extension context invalidated")
    ) return false;
    throw error;
  }
}

async function handlePopupTranslate(message) {
  const tab = await getActiveTab();
  if (!tab || typeof tab.id !== "number") throw new Error("未找到活动标签页。");
  const ready = await ensureContentScriptReady(tab.id);
  if (!ready.ok) throw new Error(ready.error);
  const ok = await safeSendMessage(tab.id, {
    type: "TRANSLATE_PAGE",
    overrideSettings: message.overrideSettings || {}
  });
  if (!ok) throw new Error("页面脚本未就绪，请刷新页面。");
}

async function ensureContentScriptReady(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const url = String(tab.url || "");
  if (!/^(https?:|file:)/i.test(url)) {
    return { ok: false, error: "当前页面无法翻译（浏览器内部页面）。" };
  }
  const existing = await safeSendMessage(tabId, { type: "GET_PAGE_TRANSLATION_STATE" });
  if (existing) return { ok: true };
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["utils/dom-parser.js", "utils/translator.js", "content.js"]
    });
  } catch (error) {
    const m = String(error.message || "");
    if (url.startsWith("file:"))
      return { ok: false, error: "本地文件需在扩展详情中开启「允许访问文件网址」。" };
    return { ok: false, error: `注入脚本失败：${m}` };
  }
  await new Promise((r) => setTimeout(r, 200));
  const injected = await safeSendMessage(tabId, { type: "GET_PAGE_TRANSLATION_STATE" });
  return injected ? { ok: true } : { ok: false, error: "脚本注入后未响应，请刷新页面。" };
}

async function testApiConnection() {
  const s = PageTranslatorCore.mergeSettings(
    await chrome.storage.local.get(PageTranslatorCore.DEFAULT_SETTINGS)
  );
  if (!s.apiKey) throw new Error("请先在设置页保存 API Key。");

  const baseTest = {
    model: s.model,
    max_tokens: 50,
    temperature: 0.1,
    messages: [{ role: "user", content: "Say OK" }]
  };
  Object.assign(baseTest, buildThinkingExtras(s.thinkingMode));

  const r = await fetch(`${PageTranslatorCore.normalizeBaseUrl(s.apiBaseUrl)}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.apiKey}` },
    body: JSON.stringify(baseTest)
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || data.message || "API 连接失败。");
  const text = data.choices?.[0]?.message?.content || "";
  return { model: s.model, message: text || "连接成功。" };
}

async function translateAll(message, port) {
  const s = PageTranslatorCore.mergeSettings(
    await chrome.storage.local.get(PageTranslatorCore.DEFAULT_SETTINGS)
  );
  if (!s.apiKey) throw new Error("缺少 API Key。");

  const segments = Array.isArray(message.segments) ? message.segments : [];
  if (!segments.length) {
    safePortPost(port, { type: "translate-complete", requestId: message.requestId, translations: {} });
    return;
  }

  const prompt = PageTranslatorCore.buildPrompt({
    segments,
    targetLanguage: message.targetLanguage || s.targetLanguage,
    url: message.url
  });

  const baseBody = {
    model: s.model,
    max_tokens: Math.max(4096, segments.length * 800),
    temperature: 0.1,
    stream: true,
    messages: [
      { role: "system", content: "你是专业网页翻译引擎。只输出格式化的译文。" },
      { role: "user", content: prompt }
    ]
  };
  Object.assign(baseBody, buildThinkingExtras(s.thinkingMode));

  const r = await fetch(`${PageTranslatorCore.normalizeBaseUrl(s.apiBaseUrl)}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.apiKey}` },
    body: JSON.stringify(baseBody)
  });

  if (!r.ok) {
    let detail = "";
    try { const b = await r.json(); detail = b.error?.message || ""; } catch (_) {}
    throw new Error(`API ${r.status}: ${detail || "请求失败"}`);
  }

  const ct = r.headers.get("content-type") || "";
  if (ct.includes("text/event-stream")) {
    await handleSSEStream(r, port, message.requestId);
  } else {
    await handleJSONResponse(r, port, message.requestId);
  }
}

async function handleJSONResponse(response, port, requestId) {
  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || "";
  const parsed = PageTranslatorCore.parseTaggedTranslations(text);
  const translations = {};
  parsed.forEach((e) => {
    translations[e.id] = e.translation;
    safePortPost(port, { type: "translate-segment", requestId, segmentId: e.id, translation: e.translation });
  });
  safePortPost(port, { type: "translate-complete", requestId, translations });
}

async function handleSSEStream(response, port, requestId) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const emittedIds = new Set();
  const allTranslations = new Map();
  let buffer = "";
  let textContent = "";
  let done = false;

  while (!done) {
    const chunk = await reader.read();
    done = chunk.done;
    buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !done });
    buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");

      const dataLine = rawEvent
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");

      if (!dataLine || dataLine === "[DONE]") continue;

      let parsed;
      try { parsed = JSON.parse(dataLine); } catch (_) { continue; }

      const delta = parsed.choices?.[0]?.delta;
      if (delta && delta.content) {
        textContent += delta.content;

        const newSegs = PageTranslatorCore.parseClosedTranslationsDelta(textContent, emittedIds);
        newSegs.forEach((e) => {
          emittedIds.add(e.id);
          allTranslations.set(e.id, e.translation);
          safePortPost(port, { type: "translate-segment", requestId, segmentId: e.id, translation: e.translation });
        });
      }
    }
  }

  const finalSegs = PageTranslatorCore.parseTaggedTranslations(textContent);
  finalSegs.forEach((e) => {
    if (!emittedIds.has(e.id)) {
      emittedIds.add(e.id);
      allTranslations.set(e.id, e.translation);
      safePortPost(port, { type: "translate-segment", requestId, segmentId: e.id, translation: e.translation });
    }
  });

  if (!allTranslations.size) {
    if (textContent) {
      console.warn("[Translator] 有内容但无法解析:", textContent.slice(0, 500));
    }
    throw new Error("翻译结果解析失败。");
  }

  safePortPost(port, {
    type: "translate-complete",
    requestId,
    translations: Object.fromEntries(allTranslations.entries())
  });
}
