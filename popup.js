const statusNode = document.getElementById("status");
const translateButton = document.getElementById("translateButton");
const targetLanguageSelect = document.getElementById("targetLanguage");
const autoTranslateCheckbox = document.getElementById("autoTranslate");

document.addEventListener("DOMContentLoaded", async () => {
  const s = await chrome.storage.local.get({ targetLanguage: "zh-CN", displayMode: "bilingual", autoTranslate: false });
  autoTranslateCheckbox.checked = s.autoTranslate;
  targetLanguageSelect.value = s.targetLanguage;
  await refreshState();
});

autoTranslateCheckbox.addEventListener("change", async () => {
  await chrome.storage.local.set({ autoTranslate: autoTranslateCheckbox.checked });
});

translateButton.addEventListener("click", async () => {
  const overrideSettings = { targetLanguage: targetLanguageSelect.value };
  translateButton.disabled = true;
  try {
    await chrome.storage.local.set(overrideSettings);
    setStatus("已发送翻译请求...");
    const r = await chrome.runtime.sendMessage({ type: "POPUP_TRANSLATE_ACTIVE_TAB", overrideSettings });
    if (!r?.ok) {
      setStatus(`失败：${r?.error || "未知错误"}`);
      return;
    }
    await refreshState();
  } catch (error) {
    setStatus(`失败：${error.message || "未知错误"}`);
  } finally {
    translateButton.disabled = false;
  }
});

document.querySelectorAll(".mode-actions button[data-mode]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const displayMode = btn.dataset.mode;
    await chrome.storage.local.set({ displayMode });
    const tab = await getActiveTab();
    if (tab?.id) {
      await chrome.tabs.sendMessage(tab.id, { type: "SET_DISPLAY_MODE", displayMode }).catch(() => {});
    }
    await refreshState();
  });
});

document.getElementById("openOptionsButton").addEventListener("click", () => {
  chrome.runtime.openOptionsPage().catch((error) => setStatus(`打开设置失败：${error.message}`));
});

document.getElementById("openShortcutsButton").addEventListener("click", async () => {
  setStatus("浏览器保留快捷键如 Ctrl+T 不能分配给扩展。");
  try {
    await chrome.runtime.sendMessage({ type: "OPEN_SHORTCUTS" });
  } catch (error) {
    setStatus(`打开快捷键页失败：${error.message}`);
  }
});

async function refreshState() {
  const tab = await getActiveTab();
  if (!tab?.id) { setStatus("没有活动标签页。"); return; }
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_TRANSLATION_STATE" });
    if (!r?.ok) { setStatus("就绪"); return; }
    const { translatedCount, totalCount, isTranslating } = r.state;
    setStatus(isTranslating ? `翻译中 ${translatedCount}/${totalCount}` : (totalCount ? `完成 ${translatedCount}/${totalCount}` : "就绪"));
  } catch (_) { setStatus("就绪"); }
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

function setStatus(t) { statusNode.textContent = t; }
