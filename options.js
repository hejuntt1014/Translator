const fields = {
  apiKey: document.getElementById("apiKey"),
  apiBaseUrl: document.getElementById("apiBaseUrl"),
  model: document.getElementById("model"),
  targetLanguage: document.getElementById("targetLanguage"),
  displayMode: document.getElementById("displayMode"),
  renderMode: document.getElementById("renderMode"),
  segmentCharLimit: document.getElementById("segmentCharLimit"),
  maxSegmentsPerRequest: document.getElementById("maxSegmentsPerRequest"),
  requestDelayMs: document.getElementById("requestDelayMs"),
  thinkingMode: document.getElementById("thinkingMode")
};

const statusNode = document.getElementById("status");

document.addEventListener("DOMContentLoaded", loadSettings);

document.getElementById("saveButton").addEventListener("click", async () => {
  await chrome.storage.local.set(readForm());
  setStatus("设置已保存。");
});

document.getElementById("testButton").addEventListener("click", async () => {
  await chrome.storage.local.set(readForm());
  setStatus("正在测试...");
  const r = await chrome.runtime.sendMessage({ type: "TEST_API_CONNECTION" });
  setStatus(r?.ok ? `连接成功：${r.result.message}` : `失败：${r?.error || "未知错误"}`);
});

document.getElementById("shortcutsButton").addEventListener("click", async () => {
  setStatus("浏览器保留快捷键如 Ctrl+T 不能分配给扩展，请在快捷键页设置其他组合。");
  await chrome.runtime.sendMessage({ type: "OPEN_SHORTCUTS" });
});

async function loadSettings() {
  const s = await chrome.storage.local.get({
    apiKey: "",
    apiBaseUrl: "https://api.cerebras.ai/v1",
    model: "qwen-3-235b-a22b-instruct-2507",
    targetLanguage: "zh-CN",
    displayMode: "bilingual",
    renderMode: "css-pseudo",
    segmentCharLimit: 5000,
    maxSegmentsPerRequest: 24,
    requestDelayMs: 100,
    thinkingMode: "omit"
  });
  fields.apiKey.value = s.apiKey;
  fields.apiBaseUrl.value = s.apiBaseUrl;
  fields.model.value = s.model;
  fields.targetLanguage.value = s.targetLanguage;
  fields.displayMode.value = s.displayMode;
  fields.renderMode.value = s.renderMode;
  fields.segmentCharLimit.value = s.segmentCharLimit;
  fields.maxSegmentsPerRequest.value = s.maxSegmentsPerRequest;
  fields.requestDelayMs.value = s.requestDelayMs;
  fields.thinkingMode.value = s.thinkingMode || "omit";
}

function readForm() {
  return {
    apiKey: fields.apiKey.value.trim(),
    apiBaseUrl: fields.apiBaseUrl.value.trim().replace(/\/+$/, ""),
    model: fields.model.value.trim(),
    targetLanguage: fields.targetLanguage.value,
    displayMode: fields.displayMode.value,
    renderMode: fields.renderMode.value,
    segmentCharLimit: Math.max(500, Number(fields.segmentCharLimit.value) || 5000),
    maxSegmentsPerRequest: Math.max(1, Number(fields.maxSegmentsPerRequest.value) || 24),
    requestDelayMs: Math.max(0, Number(fields.requestDelayMs.value) || 0),
    thinkingMode: fields.thinkingMode.value
  };
}

function setStatus(text) {
  statusNode.textContent = text;
}
