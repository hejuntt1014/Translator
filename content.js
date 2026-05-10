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
    isTranslating: false,
    lastUrl: location.href,
    observer: null,
    observerTimer: null
  };

  function checkAndTriggerAutoTranslate() {
    chrome.storage.local.get(PageTranslatorCore.DEFAULT_SETTINGS).then(settings => {
      if (settings.autoTranslate) {
        setTimeout(() => translateCurrentPage({}, { persistOverrides: false }).catch(console.error), 200);
      }
    });
  }

  setupMutationObserver();
  setupHoverObserver();
  checkAndTriggerAutoTranslate();

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

      await processBatchesConcurrently(batches, settings);

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
    if (!settings.cacheEnabled) {
      return blocks.map((block) => ({ id: block.id, text: block.text }));
    }

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
    if (!settings.cacheEnabled) return;

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

    if (block.isTitle) {
      if (state.displayMode === "original") {
        document.title = block.text;
      } else if (state.displayMode === "translated") {
        document.title = block.translationText;
      } else {
        document.title = `${block.translationText} - ${block.text}`;
      }
      return;
    }

    if (block.isAttribute) {
      if (state.displayMode === "original") {
        block.element.setAttribute(block.attributeName, block.text);
      } else if (state.displayMode === "translated") {
        block.element.setAttribute(block.attributeName, block.translationText);
      } else {
        block.element.setAttribute(block.attributeName, `${block.translationText} (${block.text})`);
      }
      return;
    }

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
    if (block.isTitle) {
      document.title = block.text;
      return;
    }
    if (block.isAttribute) {
      block.element.setAttribute(block.attributeName, block.text);
      return;
    }

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
      if (state.hideTimer) clearTimeout(state.hideTimer);
      return;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "page-translator-controls";
    wrapper.setAttribute("data-page-translator-controls", "");

    const status = document.createElement("div");
    status.className = "page-translator-controls__status";

    wrapper.append(status);
    document.documentElement.appendChild(wrapper);

    state.controller = wrapper;
    state.statusNode = status;
  }

  function updateController() {
    // No-op for Toast UI
  }

  function showStatus(text) {
    ensureController();
    state.statusNode.textContent = text;

    if (state.hideTimer) clearTimeout(state.hideTimer);
    if (text.includes("完成") || text.includes("失败")) {
      state.hideTimer = setTimeout(() => {
        if (state.controller) state.controller.setAttribute("hidden", "");
      }, 3000);
    }
  }

  function clearPreviousTranslation() {
    state.blocks.forEach((block) => restoreBlock(block));
    state.blocks = [];
    state.blockMap = new Map();
    state.blockElements = new Set();
    state.translatedCount = 0;
    state.totalCount = 0;
  }

  async function processBatchesConcurrently(batches, settings) {
    const concurrency = settings.maxConcurrentRequests || 3;
    let completed = 0;
    const executing = new Set();

    for (let index = 0; index < batches.length; index += 1) {
      if (document.hidden) {
        await new Promise(resolve => {
          const onVisible = () => {
            if (!document.hidden) {
              document.removeEventListener("visibilitychange", onVisible);
              resolve();
            }
          };
          document.addEventListener("visibilitychange", onVisible);
          showStatus("已暂停 (后台)");
        });
      }

      const batch = batches[index];
      const p = Promise.resolve().then(async () => {
        showStatus(`正在翻译... (${completed}/${batches.length})`);
        await sendForTranslation(batch, settings);
        if (settings.requestDelayMs > 0) {
          await sleep(settings.requestDelayMs);
        }
        completed += 1;
        showStatus(`正在翻译... (${completed}/${batches.length})`);
      });
      executing.add(p);
      const clean = () => executing.delete(p);
      p.then(clean).catch(clean);

      if (executing.size >= concurrency) {
        await Promise.race(executing);
      }
    }
    await Promise.all(executing);
  }

  function setupMutationObserver() {
    if (state.observer) return;

    state.observer = new MutationObserver(() => {
      if (state.lastUrl !== location.href) {
        state.lastUrl = location.href;
        clearPreviousTranslation();
        if (state.controller) state.controller.setAttribute("hidden", "");
        checkAndTriggerAutoTranslate();
        return;
      }

      if (!state.isTranslating && state.blocks.length > 0 && state.displayMode !== "original") {
        if (state.observerTimer) clearTimeout(state.observerTimer);
        state.observerTimer = setTimeout(() => {
          handleDynamicContent();
        }, 800);
      }
    });

    state.observer.observe(document.body, { 
      childList: true, 
      subtree: true, 
      characterData: true,
      attributes: true,
      attributeFilter: ["style", "class"]
    });

    window.addEventListener("popstate", () => {
      if (state.lastUrl !== location.href) {
        state.lastUrl = location.href;
        clearPreviousTranslation();
        if (state.controller) state.controller.setAttribute("hidden", "");
        checkAndTriggerAutoTranslate();
      }
    });
  }

  function setupHoverObserver() {
    document.addEventListener("mouseover", () => {
      if (!state.isTranslating && state.blocks.length > 0 && state.displayMode !== "original") {
        if (state.observerTimer) clearTimeout(state.observerTimer);
        state.observerTimer = setTimeout(() => {
          handleDynamicContent();
        }, 400);
      }
    }, { passive: true });
  }

  function handleDynamicContent() {
    if (state.isTranslating) return;
    
    const newBlocks = PageTranslatorDOMParser.collectTranslatableBlocks(document.body)
      .filter(b => !state.blockElements.has(b.element));
      
    if (!newBlocks.length) return;

    newBlocks.forEach(block => {
      block.originalHTML = block.element.innerHTML;
      block.translationText = "";
      block.cacheKey = "";
      block._replaced = false;
      block._insertedNode = null;
      block._textNodeSnapshot = null;
      block._appendedTranslationNode = null;
      block._hiddenElements = null;
      
      state.blocks.push(block);
      state.blockMap.set(block.id, block);
      state.blockElements.add(block.element);
    });

    state.totalCount = state.blocks.length;
    updateController();

    chrome.storage.local.get(PageTranslatorCore.DEFAULT_SETTINGS).then(stored => {
      const settings = PageTranslatorCore.mergeSettings(stored);
      if (!settings.apiKey) return;
      
      state.isTranslating = true;
      updateController();
      
      hydrateFromCache(newBlocks, settings).then(async uncached => {
        if (!uncached.length) {
          state.isTranslating = false;
          showStatus(`完成 ${state.translatedCount}/${state.totalCount}`);
          updateController();
          return;
        }

        const batches = PageTranslatorCore.buildSegmentBatches(
          uncached,
          settings.segmentCharLimit,
          settings.maxSegmentsPerRequest
        );

        try {
          await processBatchesConcurrently(batches, settings);
        } catch (err) {
          console.error(err);
          showStatus(`失败：${err.message}`);
        } finally {
          state.isTranslating = false;
          showStatus(`完成 ${state.translatedCount}/${state.totalCount}`);
          updateController();
        }
      }).catch(err => {
        console.error(err);
        state.isTranslating = false;
        updateController();
      });
    });
  }
})();
