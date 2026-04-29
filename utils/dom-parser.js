(function attachDomParser(globalScope) {
  const SKIP_TAGS = new Set([
    "CODE",
    "PRE",
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "SVG",
    "MATH",
    "TEXTAREA",
    "INPUT",
    "SELECT",
    "OPTION"
  ]);

  const BLOCK_TAGS = new Set([
    "P",
    "LI",
    "BLOCKQUOTE",
    "FIGCAPTION",
    "TD",
    "TH",
    "CAPTION",
    "SUMMARY",
    "BUTTON",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "ARTICLE",
    "SECTION",
    "MAIN",
    "ASIDE",
    "HEADER",
    "FOOTER",
    "NAV",
    "DIV",
    "DT",
    "DD"
  ]);

  function isElementVisible(element) {
    if (!element || !(element instanceof Element)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }

    return element.getClientRects().length > 0;
  }

  function isSkippableElement(element) {
    if (!element || !(element instanceof Element)) {
      return true;
    }

    if (SKIP_TAGS.has(element.tagName)) {
      return true;
    }

    if (element.closest("[data-page-translator-target], [data-page-translator-controls]")) {
      return true;
    }

    if (element.closest("[contenteditable=''], [contenteditable='true']")) {
      return true;
    }

    const ariaHidden = element.getAttribute("aria-hidden");
    return ariaHidden === "true";
  }

  function getNearestCandidateContainer(startNode, root) {
    let element = startNode instanceof Element ? startNode : startNode.parentElement;

    while (element && element !== root) {
      if (isSkippableElement(element)) {
        return null;
      }

      const style = window.getComputedStyle(element);
      const isBlock = style.display === "block" ||
        style.display === "list-item" ||
        style.display === "table-cell" ||
        style.display === "table-caption" ||
        style.display === "flex" ||
        style.display === "grid";

      if (BLOCK_TAGS.has(element.tagName) || isBlock) {
        return element;
      }

      element = element.parentElement;
    }

    return null;
  }

  function collectTextFromContainer(container) {
    let codeIndex = 0;
    const inlineTokens = [];
    const chunks = [];

    function pushText(value) {
      const text = String(value || "").replace(/\s+/g, " ").trim();
      if (text) {
        chunks.push(text);
      }
    }

    function walk(node) {
      if (!node) {
        return;
      }

      if (node.nodeType === Node.TEXT_NODE) {
        const parent = node.parentElement;
        if (!parent || isSkippableElement(parent)) {
          return;
        }

        const nestedContainer = getNearestCandidateContainer(parent, container);
        if (nestedContainer && nestedContainer !== container) {
          return;
        }

        pushText(node.nodeValue || "");
        return;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) {
        return;
      }

      const element = node;
      if (element !== container) {
        const nestedContainer = getNearestCandidateContainer(element, container);
        if (nestedContainer && nestedContainer !== container) {
          return;
        }
      }

      if (element.tagName === "CODE" && !element.closest("pre")) {
        const codeText = (element.textContent || "").trim();
        if (codeText) {
          codeIndex += 1;
          const token = `{{CODE_${codeIndex}}}`;
          inlineTokens.push({ token, text: codeText });
          chunks.push(token);
        }
        return;
      }

      if (SKIP_TAGS.has(element.tagName) || element.closest("[contenteditable=''], [contenteditable='true']")) {
        return;
      }

      Array.from(element.childNodes).forEach(walk);
    }

    Array.from(container.childNodes).forEach(walk);

    return {
      text: chunks.join(" ").trim(),
      inlineTokens
    };
  }

  function looksLikeCodeHeavy(container, text) {
    const compact = String(text || "");
    const punctuationCount = (compact.match(/[{}()[\];=<>/\\`]/g) || []).length;
    return compact.length > 0 && punctuationCount / compact.length > 0.2;
  }

  function createId(index) {
    return `seg_${index + 1}`;
  }

  function collectTranslatableBlocks(root) {
    const scope = root || document.body;
    const seen = new Set();
    const collected = [];
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = (node.nodeValue || "").replace(/\s+/g, " ").trim();
        if (!text) {
          return NodeFilter.FILTER_REJECT;
        }

        const parent = node.parentElement;
        if (!parent || isSkippableElement(parent)) {
          return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let textNode;
    while ((textNode = walker.nextNode())) {
      const container = getNearestCandidateContainer(textNode.parentElement, scope);
      if (!container || seen.has(container) || !isElementVisible(container)) {
        continue;
      }

      const contentData = collectTextFromContainer(container);
      const text = contentData.text;
      if (!text || text.length < 2 || looksLikeCodeHeavy(container, text)) {
        continue;
      }

      seen.add(container);
      collected.push({
        id: createId(collected.length),
        element: container,
        text,
        tagName: container.tagName.toLowerCase(),
        inlineTokens: contentData.inlineTokens
      });
    }

    return collected;
  }

  globalScope.PageTranslatorDOMParser = {
    collectTranslatableBlocks
  };
})(typeof self !== "undefined" ? self : window);
