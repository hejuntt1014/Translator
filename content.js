(function initContentScript() {
  if (window.__pageTranslatorLoaded) return;
  window.__pageTranslatorLoaded = true;

  function toUserFacingError(error) {
    const message = String(error && error.message ? error.message : error || "");
    if (message.includes("Extension context invalidated")) {
      return new Error("扩展已重新加载，请刷新页面。");
    }
    if (message.includes("disconnected port")) {
      return new Error("连接中断，请重试。");
    }
    return error instanceof Error ? error : new Error(message || "未知错误");
  }

  const state = {
    requestId: null,
    blocks: [],
    blockMap: new Map(),
    blockElements: new Set(),
    translatedCount: 0,
    totalCount: 0,
    displayMode: "bilingual",
    renderMode: "css-pseudo",
    controller: null,
    statusNode: null,
    progressNode: null,
    isTranslating: false
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "TRANSLATE_PAGE") {
      translateCurrentPage(message.overrideSettings || {})
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === "TOGGLE_SHORTCUT_TRANSLATION") {
      toggleShortcutTranslation()
        .then((result) => sendResponse({ ok: true, result }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === "SET_DISPLAY_MODE") {
      setDisplayMode(message.displayMode);
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "GET_PAGE_TRANSLATION_STATE") {
      sendResponse({
        ok: true,
        state: {
          totalCount: state.totalCount,
          translatedCount: state.translatedCount,
          isTranslating: state.isTranslating,
          displayMode: state.displayMode
        }
      });
      return false;
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.displayMode) setDisplayMode(changes.displayMode.newValue);
    if (changes.renderMode) setRenderMode(changes.renderMode.newValue);
  });

  async function translateCurrentPage(overrideSettings, options) {
    if (state.isTranslating) return;
    const persistOverrides = options?.persistOverrides !== false;

    let settings;
    try {
      const stored = await chrome.storage.local.get(PageTranslatorCore.DEFAULT_SETTINGS);
      settings = PageTranslatorCore.mergeSettings(Object.assign({}, stored, overrideSettings || {}));
    } catch (error) {
      throw toUserFacingError(error);
    }

    if (!settings.apiKey) throw new Error("请先在设置页保存 API Key。");

    if (persistOverrides && overrideSettings && Object.keys(overrideSettings).length) {
      try { await chrome.storage.local.set(overrideSettings); } catch (_) {}
    }

    clearPreviousTranslation();

    const blocks = PageTranslatorDOMParser.collectTranslatableBlocks(document.body);
    if (!blocks.length) {
      showStatus("没有可翻译内容。");
      return;
    }

    state.requestId = `req_${Date.now()}`;
    state.blocks = blocks.map((block) => ({
      ...block,
      originalHTML: block.element.innerHTML,
      translationText: "",
      cacheKey: "",
      _replaced: false,
      _insertedNode: null,
      _textNodeSnapshot: null,
      _appendedTranslationNode: null,
      _hiddenElements: null
    }));
    state.blockMap = new Map(state.blocks.map((block) => [block.id, block]));
    state.blockElements = new Set(state.blocks.map((block) => block.element));
    state.translatedCount = 0;
    state.totalCount = state.blocks.length;
    state.displayMode = settings.displayMode;
    state.renderMode = settings.renderMode || "css-pseudo";
    state.isTranslating = true;

    showStatus("正在翻译...");
    updateController();

    try {
      const uncached = await hydrateFromCache(state.blocks, settings);
      updateController();

      if (!uncached.length) {
        showStatus(`完成 ${state.translatedCount}/${state.totalCount}`);
        return;
      }

      const batches = PageTranslatorCore.buildSegmentBatches(
        uncached,
        settings.segmentCharLimit,
        settings.maxSegmentsPerRequest
      );

      for (let index = 0; index < batches.length; index += 1) {
        const batch = batches[index];
        showStatus(`正在翻译第 ${index + 1}/${batches.length} 批（${batch.length} 段）`);
        await sendForTranslation(batch, settings);
        if (index < batches.length - 1 && settings.requestDelayMs > 0) {
          await sleep(settings.requestDelayMs);
        }
      }

      showStatus(`完成 ${state.translatedCount}/${state.totalCount}`);
    } catch (error) {
      const friendly = toUserFacingError(error);
      showStatus(`失败：${friendly.message}`);
      throw friendly;
    } finally {
      state.isTranslating = false;
      updateController();
    }
  }

  async function hydrateFromCache(blocks, settings) {
    const keyById = new Map();
    blocks.forEach((block) => {
      const key = PageTranslatorCore.createCacheKey(
        location.href,
        settings.targetLanguage,
        settings.model,
        block.text
      );
      keyById.set(block.id, key);
      block.cacheKey = key;
    });

    let cached;
    try {
      cached = await chrome.storage.local.get([...keyById.values()]);
    } catch (error) {
      throw toUserFacingError(error);
    }

    const uncached = [];
    blocks.forEach((block) => {
      const translation = cached[keyById.get(block.id)];
      if (translation) {
        applyTranslation(block.id, translation);
      } else {
        uncached.push({ id: block.id, text: block.text });
      }
    });

    return uncached;
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, Math.max(0, Number(ms) || 0));
    });
  }

  function sendForTranslation(segments, settings) {
    return new Promise((resolve, reject) => {
      let port;
      try {
        port = chrome.runtime.connect({ name: "page-translate" });
      } catch (error) {
        reject(toUserFacingError(error));
        return;
      }

      let settled = false;
      function finish(callback) {
        if (settled) return;
        settled = true;
        try { port.disconnect(); } catch (_) {}
        callback();
      }

      port.onDisconnect.addListener(() => {
        const runtimeError = chrome.runtime.lastError;
        if (!settled) {
          finish(() => reject(new Error(runtimeError ? runtimeError.message : "连接中断。")));
        }
      });

      port.onMessage.addListener(async (message) => {
        if (message.requestId !== state.requestId) return;

        if (message.type === "translate-segment") {
          applyTranslation(message.segmentId, message.translation);
          showStatus(`已翻译 ${state.translatedCount}/${state.totalCount}`);
          updateController();
          return;
        }

        if (message.type === "translate-error") {
          finish(() => reject(new Error(message.error)));
          return;
        }

        if (message.type === "translate-complete") {
          await persistCache(segments, message.translations || {}, settings);
          finish(() => resolve());
        }
      });

      try {
        port.postMessage({
          type: "translate-all",
          requestId: state.requestId,
          segments,
          targetLanguage: settings.targetLanguage,
          url: location.href
        });
      } catch (error) {
        finish(() => reject(toUserFacingError(error)));
      }
    });
  }

  async function persistCache(segments, translations, settings) {
    const payload = {};
    segments.forEach((segment) => {
      const block = state.blockMap.get(segment.id);
      const translation = translations[segment.id];
      if (!block || !translation) return;
      payload[block.cacheKey || PageTranslatorCore.createCacheKey(
        location.href,
        settings.targetLanguage,
        settings.model,
        block.text
      )] = translation;
    });

    if (Object.keys(payload).length) {
      try { await chrome.storage.local.set(payload); } catch (_) {}
    }
  }

  function applyTranslation(blockId, translation) {
    const block = state.blockMap.get(blockId);
    if (!block || !translation) return;

    if (!block.translationText) {
      state.translatedCount += 1;
    }

    block.translationText = translation;
    applyModeToBlock(block);
  }

  function setDisplayMode(mode) {
    state.displayMode = mode || "bilingual";
    state.blocks.forEach((block) => {
      if (block.translationText) applyModeToBlock(block);
    });
    updateController();
  }

  async function toggleShortcutTranslation() {
    if (state.isTranslating) {
      return { action: "busy" };
    }

    if (!state.totalCount || !state.blocks.length) {
      await translateCurrentPage({ displayMode: "translated" }, { persistOverrides: false });
      return { action: "translated" };
    }

    setDisplayMode(state.displayMode === "original" ? "translated" : "original");
    return { action: state.displayMode };
  }

  function setRenderMode(mode) {
    state.renderMode = mode || "css-pseudo";
    state.blocks.forEach((block) => {
      if (block.translationText) applyModeToBlock(block);
    });
  }

  function applyModeToBlock(block) {
    restoreBlock(block);
    if (!block.translationText) return;
    getStrategy(state.renderMode).apply(block, state.displayMode, block.translationText);
  }

  function getStrategy(renderMode) {
    if (renderMode === "text-node") return textNodeStrategy;
    if (renderMode === "insert-block") return insertBlockStrategy;
    return cssPseudoStrategy;
  }

  function isFlexOrGrid(element) {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    const d = style.display;
    return d === "flex" || d === "inline-flex" || d === "grid" || d === "inline-grid";
  }

  function restoreProtectedTokens(text, inlineTokens) {
    return (inlineTokens || []).reduce((result, tokenItem) => {
      return result.replaceAll(tokenItem.token, tokenItem.text);
    }, String(text || ""));
  }

  function splitTranslationByTokens(text, inlineTokens) {
    if (!inlineTokens || !inlineTokens.length) {
      return [String(text || "")];
    }

    let rest = String(text || "");
    const parts = [];
    inlineTokens.forEach((tokenItem) => {
      const index = rest.indexOf(tokenItem.token);
      if (index === -1) {
        return;
      }
      parts.push(rest.slice(0, index));
      rest = rest.slice(index + tokenItem.token.length);
    });
    parts.push(rest);
    return parts.length ? parts : [String(text || "")];
  }

  function restoreBlock(block) {
    const element = block.element;
    element.removeAttribute("data-pt-bi");
    element.removeAttribute("data-pt-original-hidden");

    if (block._hiddenElements) {
      block._hiddenElements.forEach((el) => {
        if (el.isConnected && el.dataset.ptOriginalDisplay != null) {
          el.style.display = el.dataset.ptOriginalDisplay || "";
          delete el.dataset.ptOriginalDisplay;
        }
      });
      block._hiddenElements = null;
    }

    if (block._insertedNode && block._insertedNode.isConnected) {
      block._insertedNode.remove();
    }
    block._insertedNode = null;

    if (block._appendedTranslationNode && block._appendedTranslationNode.isConnected) {
      block._appendedTranslationNode.remove();
    }
    block._appendedTranslationNode = null;

    if (block._textNodeSnapshot && !block._replaced) {
      block._textNodeSnapshot.nodes.forEach((node, index) => {
        if (node && node.isConnected) {
          node.nodeValue = block._textNodeSnapshot.values[index];
        }
      });
    }

    if (block._replaced && block.originalHTML != null) {
      element.innerHTML = block.originalHTML;
      block._replaced = false;
      block._textNodeSnapshot = null;
    }
  }

  function ensureTextNodeSnapshot(block) {
    if (
      block._textNodeSnapshot &&
      block._textNodeSnapshot.nodes.every((node) => node && node.isConnected)
    ) {
      return block._textNodeSnapshot;
    }

    const blockEl = block.element;
    const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest("code, pre, script, style, noscript, svg, math")) {
          return NodeFilter.FILTER_REJECT;
        }
        const text = (node.nodeValue || "").trim();
        if (!text) return NodeFilter.FILTER_REJECT;

        let ancestor = parent;
        while (ancestor && ancestor !== blockEl) {
          if (state.blockElements.has(ancestor)) {
            return NodeFilter.FILTER_REJECT;
          }
          ancestor = ancestor.parentElement;
        }

        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const nodes = [];
    const values = [];
    let current;
    while ((current = walker.nextNode())) {
      nodes.push(current);
      values.push(current.nodeValue);
    }

    block._textNodeSnapshot = { nodes, values };
    return block._textNodeSnapshot;
  }

  function blankAndHide(textNode, block) {
    textNode.nodeValue = "";
    if (!block._hiddenElements) block._hiddenElements = [];
    let el = textNode.parentElement;
    while (el && el !== block.element) {
      if (
        el.textContent.trim() === "" &&
        !el.querySelector("img, svg, video, canvas, input")
      ) {
        el.dataset.ptOriginalDisplay = el.style.display;
        el.style.display = "none";
        block._hiddenElements.push(el);
        return;
      }
      el = el.parentElement;
    }
  }

  function findCodeElements(blockElement, inlineTokens) {
    const candidates = Array.from(
      blockElement.querySelectorAll("code:not(pre code)")
    );
    const result = [];
    const used = new Set();
    for (const token of inlineTokens) {
      const trimmed = token.text.trim();
      const idx = candidates.findIndex(
        (el, i) => !used.has(i) && (el.textContent || "").trim() === trimmed
      );
      if (idx !== -1) {
        result.push(candidates[idx]);
        used.add(idx);
      }
    }
    return result;
  }

  function buildNodeGroups(nodes, codeElements) {
    const groups = [];
    for (let i = 0; i <= codeElements.length; i++) {
      groups.push([]);
    }
    for (const node of nodes) {
      let groupIndex = 0;
      for (let c = 0; c < codeElements.length; c++) {
        const pos = codeElements[c].compareDocumentPosition(node);
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) {
          groupIndex = c + 1;
        }
      }
      groups[groupIndex].push(node);
    }
    return groups;
  }

  function applyTranslationViaTextNodes(block, displayMode, translation) {
    const snapshot = ensureTextNodeSnapshot(block);
    const fullTranslation = restoreProtectedTokens(translation, block.inlineTokens);

    if (!snapshot.nodes.length) return;

    if (displayMode === "bilingual") {
      const appended = document.createTextNode(` ${fullTranslation}`);
      const anchor = snapshot.nodes[snapshot.nodes.length - 1];
      if (anchor.parentNode) {
        anchor.parentNode.insertBefore(appended, anchor.nextSibling);
      } else {
        block.element.appendChild(appended);
      }
      block._appendedTranslationNode = appended;
      return;
    }

    const inlineTokens = block.inlineTokens || [];
    const nodes = snapshot.nodes;
    block._hiddenElements = [];

    if (!inlineTokens.length) {
      nodes[0].nodeValue = fullTranslation;
      for (let i = 1; i < nodes.length; i++) {
        blankAndHide(nodes[i], block);
      }
      return;
    }

    const codeElements = findCodeElements(block.element, inlineTokens);

    if (!codeElements.length) {
      nodes[0].nodeValue = fullTranslation;
      for (let i = 1; i < nodes.length; i++) {
        blankAndHide(nodes[i], block);
      }
      return;
    }

    const groups = buildNodeGroups(nodes, codeElements);
    const parts = splitTranslationByTokens(translation, inlineTokens);

    if (parts.length < groups.length) {
      nodes[0].nodeValue = fullTranslation;
      for (let i = 1; i < nodes.length; i++) {
        blankAndHide(nodes[i], block);
      }
      return;
    }

    for (let g = 0; g < groups.length; g++) {
      const group = groups[g];
      if (!group.length) continue;
      group[0].nodeValue = g < parts.length ? parts[g] : "";
      for (let j = 1; j < group.length; j++) {
        blankAndHide(group[j], block);
      }
    }

    if (parts.length > groups.length) {
      const lastGroup = groups[groups.length - 1];
      const extra = parts.slice(groups.length).join("");
      if (lastGroup.length) {
        lastGroup[0].nodeValue += extra;
      }
    }
  }

  const cssPseudoStrategy = {
    apply(block, displayMode, translation) {
      if (displayMode === "original") return;

      if (displayMode === "bilingual") {
        if (isFlexOrGrid(block.element) || isFlexOrGrid(block.element.parentElement)) {
          applyTranslationViaTextNodes(block, displayMode, translation);
          return;
        }
        block.element.setAttribute(
          "data-pt-bi",
          restoreProtectedTokens(translation, block.inlineTokens)
        );
        return;
      }

      applyTranslationViaTextNodes(block, displayMode, translation);
    }
  };

  const textNodeStrategy = {
    apply(block, displayMode, translation) {
      if (displayMode === "original") return;
      applyTranslationViaTextNodes(block, displayMode, translation);
    }
  };

  const insertBlockStrategy = {
    apply(block, displayMode, translation) {
      if (displayMode === "original") return;

      const node = document.createElement("span");
      node.className = "pt-inserted-translation";
      node.textContent = restoreProtectedTokens(translation, block.inlineTokens);
      block._insertedNode = node;
      block.element.insertAdjacentElement("afterend", node);

      if (displayMode === "translated") {
        block.element.setAttribute("data-pt-original-hidden", "");
      }
    }
  };

  function ensureController() {
    if (state.controller) {
      state.controller.removeAttribute("hidden");
      return;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "page-translator-controls";
    wrapper.setAttribute("data-page-translator-controls", "");

    const header = document.createElement("div");
    header.className = "page-translator-controls__header";

    const title = document.createElement("div");
    title.className = "page-translator-controls__title";
    title.textContent = "AI 翻译";

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "page-translator-controls__close";
    closeButton.textContent = "\u2715";
    closeButton.addEventListener("click", () => wrapper.setAttribute("hidden", ""));

    header.append(title, closeButton);

    const status = document.createElement("div");
    status.className = "page-translator-controls__status";

    const progress = document.createElement("div");
    progress.className = "page-translator-controls__progress";

    const actions = document.createElement("div");
    actions.className = "page-translator-controls__actions";

    [
      ["original", "原文"],
      ["bilingual", "双语"],
      ["translated", "译文"]
    ].forEach(([mode, label]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.mode = mode;
      button.textContent = label;
      button.addEventListener("click", () => {
        setDisplayMode(mode);
      });
      actions.appendChild(button);
    });

    wrapper.append(header, status, progress, actions);
    document.documentElement.appendChild(wrapper);

    state.controller = wrapper;
    state.statusNode = status;
    state.progressNode = progress;
  }

  function updateController() {
    if (!state.controller) return;
    state.progressNode.textContent = `${state.translatedCount}/${state.totalCount}`;
    state.controller.querySelectorAll("button[data-mode]").forEach((button) => {
      button.toggleAttribute("data-active", button.dataset.mode === state.displayMode);
    });
  }

  function showStatus(text) {
    ensureController();
    state.statusNode.textContent = text;
  }

  function clearPreviousTranslation() {
    state.blocks.forEach((block) => restoreBlock(block));
    state.blocks = [];
    state.blockMap = new Map();
    state.blockElements = new Set();
    state.translatedCount = 0;
    state.totalCount = 0;
  }
})();
