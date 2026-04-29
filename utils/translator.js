(function attachTranslatorCore(globalScope) {
  const LANGUAGE_LABELS = {
    "zh-CN": "简体中文",
    "zh-TW": "繁体中文",
    en: "English",
    ja: "日本語",
    ko: "한국어",
    fr: "Français",
    de: "Deutsch",
    es: "Español",
    ru: "Русский"
  };

  const DEFAULT_SETTINGS = {
    apiKey: "",
    apiBaseUrl: "https://api.cerebras.ai/v1",
    model: "qwen-3-235b-a22b-instruct-2507",
    targetLanguage: "zh-CN",
    displayMode: "bilingual",
    renderMode: "css-pseudo",
    segmentCharLimit: 5000,
    maxSegmentsPerRequest: 24,
    requestDelayMs: 100,
    /** omit | enabled | disabled — DeepSeek v4 等非思考模式用 disabled */
    thinkingMode: "omit"
  };

  function cloneDefaults() {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }

  function mergeSettings(source) {
    return Object.assign(cloneDefaults(), source || {});
  }

  function getLanguageLabel(code) {
    return LANGUAGE_LABELS[code] || code || "目标语言";
  }

  function normalizeBaseUrl(value) {
    const raw = String(value || DEFAULT_SETTINGS.apiBaseUrl).trim();
    return raw.replace(/\/+$/, "");
  }

  function hashString(input) {
    const text = String(input || "");
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(16);
  }

  function createCacheKey(url, targetLanguage, model, text) {
    return [
      "page-translator",
      hashString(url || ""),
      targetLanguage || DEFAULT_SETTINGS.targetLanguage,
      model || DEFAULT_SETTINGS.model,
      hashString(text || "")
    ].join(":");
  }

  function buildSegmentBatches(segments, segmentCharLimit, maxSegmentsPerRequest) {
    const items = Array.isArray(segments) ? segments.slice() : [];
    const charLimit = Math.max(500, Number(segmentCharLimit) || DEFAULT_SETTINGS.segmentCharLimit);
    const batchLimit = Math.max(1, Number(maxSegmentsPerRequest) || DEFAULT_SETTINGS.maxSegmentsPerRequest);
    const batches = [];
    let currentBatch = [];
    let currentChars = 0;

    items.forEach((segment) => {
      const text = String(segment.text || "");
      const charCount = text.length;
      const shouldSplit = currentBatch.length > 0 && (
        currentBatch.length >= batchLimit ||
        currentChars + charCount > charLimit
      );

      if (shouldSplit) {
        batches.push(currentBatch);
        currentBatch = [];
        currentChars = 0;
      }

      currentBatch.push(segment);
      currentChars += charCount;
    });

    if (currentBatch.length) {
      batches.push(currentBatch);
    }

    return batches;
  }

  function buildPrompt(payload) {
    const segments = Array.isArray(payload.segments) ? payload.segments : [];
    const targetLanguage = getLanguageLabel(payload.targetLanguage);
    const blocks = segments
      .map((seg) => `[${seg.id}]\n${seg.text}\n[/${seg.id}]`)
      .join("\n\n");

    return [
      `将下面网页内容翻译为${targetLanguage}。`,
      "规则：",
      "1. 只输出译文，不要解释。",
      "2. 保持每个块的顺序，用相同标签包裹输出。",
      "3. 专有名词、代码、URL 保持原样。",
      "4. 不要遗漏或合并块。",
      "5. 保留形如 {{CODE_1}}、{{CODE_2}} 的占位符，不要翻译、不要删除、不要改写。",
      "",
      blocks
    ].join("\n");
  }

  function stripCodeFences(text) {
    return String(text || "")
      .replace(/^```[\w-]*\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  }

  function parseTaggedTranslations(text) {
    const cleaned = stripCodeFences(text);
    const results = [];
    const pattern = /\[([A-Za-z0-9_-]+)\]\s*([\s\S]*?)\s*\[\/\1\]/g;
    let match;
    while ((match = pattern.exec(cleaned))) {
      results.push({ id: match[1], translation: match[2].trim() });
    }
    return results;
  }

  function parseClosedTranslationsDelta(text, emittedIds) {
    return parseTaggedTranslations(text).filter((e) => !emittedIds.has(e.id));
  }

  function summarizeSourceText(text) {
    return String(text || "").replace(/\s+/g, " ").trim().slice(0, 160);
  }

  globalScope.PageTranslatorCore = {
    DEFAULT_SETTINGS,
    mergeSettings,
    getLanguageLabel,
    normalizeBaseUrl,
    hashString,
    createCacheKey,
    buildSegmentBatches,
    buildPrompt,
    parseTaggedTranslations,
    parseClosedTranslationsDelta,
    summarizeSourceText
  };
})(typeof self !== "undefined" ? self : window);
