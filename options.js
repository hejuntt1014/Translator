const fields = {
  apiKey: document.getElementById("apiKey"),
  apiBaseUrl: document.getElementById("apiBaseUrl"),
  model: document.getElementById("model"),
  targetLanguage: document.getElementById("targetLanguage"),
  displayMode: document.getElementById("displayMode"),
  renderMode: document.getElementById("renderMode"),
  cacheEnabled: document.getElementById("cacheEnabled"),
  segmentCharLimit: document.getElementById("segmentCharLimit"),
  maxSegmentsPerRequest: document.getElementById("maxSegmentsPerRequest"),
  requestDelayMs: document.getElementById("requestDelayMs"),
  thinkingMode: document.getElementById("thinkingMode")
};

const statusNode = document.getElementById("status");

document.addEventListener("DOMContentLoaded", loadSettings);

document.getElementById("saveButton").addEventListener("click", async () => {
  await runWithStatus(async () => {
    const settings = readForm();
    await chrome.storage.local.set(settings);
    setStatus("设置已保存。");
  });
});

document.getElementById("testButton").addEventListener("click", async () => {
  await runWithStatus(async () => {
    const settings = readForm();
    await chrome.storage.local.set(settings);
    setStatus("正在测试...");
    const r = await chrome.runtime.sendMessage({ type: "TEST_API_CONNECTION" });
    setStatus(r?.ok ? `连接成功：${r.result.message}` : `失败：${r?.error || "未知错误"}`);
  });
});

document.getElementById("shortcutsButton").addEventListener("click", async () => {
  setStatus("浏览器保留快捷键如 Ctrl+T 不能分配给扩展，请在快捷键页设置其他组合。");
  try {
    await chrome.runtime.sendMessage({ type: "OPEN_SHORTCUTS" });
  } catch (error) {
    setStatus(`打开快捷键页失败：${error.message}`);
  }
});

async function loadSettings() {
  const s = PageTranslatorCore.mergeSettings(
    await chrome.storage.local.get(PageTranslatorCore.DEFAULT_SETTINGS)
  );
  fields.apiKey.value = s.apiKey;
  fields.apiBaseUrl.value = s.apiBaseUrl;
  fields.model.value = s.model;
  fields.targetLanguage.value = s.targetLanguage;
  fields.displayMode.value = s.displayMode;
  fields.renderMode.value = s.renderMode;
  fields.cacheEnabled.checked = Boolean(s.cacheEnabled);
  fields.segmentCharLimit.value = s.segmentCharLimit;
  fields.maxSegmentsPerRequest.value = s.maxSegmentsPerRequest;
  fields.requestDelayMs.value = s.requestDelayMs;
  fields.thinkingMode.value = s.thinkingMode || "omit";
}

function readForm() {
  const apiBaseUrl = PageTranslatorCore.validateApiBaseUrl(fields.apiBaseUrl.value);
  const model = fields.model.value.trim();
  if (!model) {
    throw new Error("请填写模型名称。");
  }

  return {
    apiKey: fields.apiKey.value.trim(),
    apiBaseUrl,
    model,
    targetLanguage: fields.targetLanguage.value,
    displayMode: fields.displayMode.value,
    renderMode: fields.renderMode.value,
    cacheEnabled: fields.cacheEnabled.checked,
    segmentCharLimit: Math.max(500, Number(fields.segmentCharLimit.value) || 5000),
    maxSegmentsPerRequest: Math.max(1, Number(fields.maxSegmentsPerRequest.value) || 24),
    requestDelayMs: Math.max(0, Number(fields.requestDelayMs.value) || 0),
    thinkingMode: fields.thinkingMode.value
  };
}

function setStatus(text) {
  statusNode.textContent = text;
}

async function runWithStatus(task) {
  try {
    await task();
  } catch (error) {
    setStatus(`失败：${error.message || "未知错误"}`);
  }
}
