// HighlightHero - content script

(() => {
  if (window.__HH_CONTENT_ACTIVE__) {
    return; // prevent duplicate init
  }
  window.__HH_CONTENT_ACTIVE__ = true;

  const HIGHLIGHT_CLASS = "hh-highlight";
  const HIDDEN_BLOCK_CLASS = "hh-hidden-block";
  const TOOLBAR_CLASS = "hh-toolbar";
  const FOCUS_CLASS = "hh-focus";
  const SENTENCE_CLASS = "hh-sentence";
  const SENTENCE_BTN_CLASS = "hh-sentence-btn";
  const DATA_HH_HIDDEN = "hhHidden";
  const DATA_HH_PREV_DISPLAY = "hhPrevDisplay";
  const SETTINGS_KEY = "hhSettings";
  const UI_KEY = "hhUi";

  const DEFAULT_SETTINGS = {
    enabled: true,
    mode: "highlight", // 'highlight' | 'hide'
    keywords: [],
    matchCase: false,
    wholeWords: false,
    highlightColor: "#ffed75", // light yellow
  };

  /** @type {typeof DEFAULT_SETTINGS} */
  let currentSettings = { ...DEFAULT_SETTINGS };

  let reapplyTimer = null;
  let toolbar = null;
  let matches = [];
  let currentIndex = -1;
  let nextMatchId = 0;
  let suppressReapplyUntil = 0;
  let lastNavDir = 0; // 1: next, -1: prev, 0: none
  let skipContentEditable = true; // allow inside editors when false
  let isEditorContext = false;
  let searchRoots = null;
  let navFocusPending = false; // only focus/scroll when true
  let uiState = { toolbar: { x: null, y: null } };

  function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function buildRegexFromKeywords(keywords, matchCase, wholeWords) {
    const cleaned = (keywords || [])
      .map((k) => (k || "").trim())
      .filter(Boolean);
    if (cleaned.length === 0) return null;
    const escaped = cleaned.map(escapeRegex);
    const boundary = wholeWords ? "\\b" : "";
    const pattern = `${boundary}(?:${escaped.join("|")})${boundary}`;
    const flags = matchCase ? "g" : "gi";
    try {
      return new RegExp(pattern, flags);
    } catch (e) {
      return null;
    }
  }

  function isSkippableNode(node) {
    if (!node) return true;
    if (node.nodeType !== Node.TEXT_NODE) return false;
    const parent = node.parentNode;
    if (!parent || parent.nodeType !== Node.ELEMENT_NODE) return true;
    const tag = parent.nodeName.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "noscript") return true;
    const ce = skipContentEditable ? ',[contenteditable="true"]' : "";
    if (
      parent.closest(
        "script,style,noscript,textarea,code,pre,." + HIGHLIGHT_CLASS + ce
      )
    )
      return true;
    if (
      parent.classList &&
      (parent.classList.contains(HIGHLIGHT_CLASS) ||
        parent.classList.contains(HIDDEN_BLOCK_CLASS))
    )
      return true;
    return false;
  }

  function wrapMatchesInTextNode(textNode, regex, backgroundColor) {
    if (!textNode || !textNode.nodeValue) return;
    const parent = textNode.parentNode;
    if (!parent) return;
    const text = textNode.nodeValue;
    regex.lastIndex = 0;
    let match;
    let lastIndex = 0;
    const fragment = document.createDocumentFragment();

    while ((match = regex.exec(text)) !== null) {
      const preceding = text.slice(lastIndex, match.index);
      if (preceding) fragment.appendChild(document.createTextNode(preceding));
      const span = document.createElement("span");
      span.className = HIGHLIGHT_CLASS;
      span.textContent = match[0];
      span.style.backgroundColor =
        backgroundColor || DEFAULT_SETTINGS.highlightColor;
      span.style.padding = "0 1px";
      try {
        span.dataset.hhId = String(nextMatchId++);
      } catch {}
      fragment.appendChild(span);
      lastIndex = regex.lastIndex;
      if (match.index === regex.lastIndex) regex.lastIndex++; // avoid zero-length loops
    }

    const tail = text.slice(lastIndex);
    if (tail) fragment.appendChild(document.createTextNode(tail));

    if (fragment.childNodes.length) {
      parent.replaceChild(fragment, textNode);
    }
  }

  function highlightInDocument(regex, roots) {
    nextMatchId = 0;
    const containers = roots && roots.length ? roots : [document.body];
    const toProcess = [];
    for (const root of containers) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
          if (isSkippableNode(node)) return NodeFilter.FILTER_REJECT;
          // Reset lastIndex because regex has global flag
          regex.lastIndex = 0;
          if (!node.nodeValue || !regex.test(node.nodeValue))
            return NodeFilter.FILTER_SKIP;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      let node;
      while ((node = walker.nextNode())) {
        toProcess.push(node);
      }
    }
    for (const textNode of toProcess) {
      wrapMatchesInTextNode(textNode, regex, currentSettings.highlightColor);
    }

    // collect match nodes after wrapping; do not reset currentIndex here
    matches = Array.from(document.querySelectorAll("." + HIGHLIGHT_CLASS));
  }

  // ===== CSS Custom Highlight (non-mutating) for editors =====
  function clearCustomHighlights() {
    try {
      if (window.CSS && CSS.highlights) {
        CSS.highlights.delete("hhMark");
        CSS.highlights.delete("hhFocus");
      }
    } catch {}
  }

  function highlightWithCSSHighlights(regex, roots) {
    clearCustomHighlights();
    const containers = roots && roots.length ? roots : [document.body];
    /** @type {Range[]} */
    const ranges = [];
    for (const root of containers) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
          if (!node) return NodeFilter.FILTER_REJECT;
          // In editor context, we intentionally allow contenteditable text nodes
          const parent = node.parentNode;
          if (!parent || parent.nodeType !== Node.ELEMENT_NODE)
            return NodeFilter.FILTER_REJECT;
          if (parent.closest("script,style,noscript,." + TOOLBAR_CLASS))
            return NodeFilter.FILTER_REJECT;
          if (!node.nodeValue) return NodeFilter.FILTER_SKIP;
          // quick check to avoid heavy processing
          regex.lastIndex = 0;
          if (!regex.test(node.nodeValue)) return NodeFilter.FILTER_SKIP;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      let node;
      while ((node = walker.nextNode())) {
        const text = node.nodeValue;
        if (!text) continue;
        regex.lastIndex = 0;
        let m;
        while ((m = regex.exec(text)) !== null) {
          const r = document.createRange();
          r.setStart(node, m.index);
          r.setEnd(node, m.index + m[0].length);
          ranges.push(r);
          if (m.index === regex.lastIndex) regex.lastIndex++; // guard
        }
      }
    }
    try {
      if (window.CSS && CSS.highlights) {
        const mark = new Highlight(...ranges);
        CSS.highlights.set("hhMark", mark);
      }
    } catch {}
    matches = ranges; // store ranges as matches in editor
    currentIndex = matches.length ? 0 : -1;
  }

  function clearHighlights() {
    clearCustomHighlights();
    const highlighted = document.querySelectorAll(
      "." + HIGHLIGHT_CLASS + ", ." + FOCUS_CLASS
    );
    for (const el of highlighted) {
      // Replace the wrapper span with a plain text node to restore original text
      if (el.classList.contains(HIGHLIGHT_CLASS)) {
        el.replaceWith(document.createTextNode(el.textContent || ""));
      } else {
        el.classList.remove(FOCUS_CLASS);
      }
    }
    matches = [];
    currentIndex = -1;
  }

  function clearSentenceWrappers() {
    const wrappers = document.querySelectorAll("." + SENTENCE_CLASS);
    for (const w of wrappers) {
      try {
        const frag = document.createDocumentFragment();
        const children = Array.from(w.childNodes);
        for (const child of children) {
          if (
            child.nodeType === Node.ELEMENT_NODE &&
            /** @type {HTMLElement} */ (child).classList.contains(
              SENTENCE_BTN_CLASS
            )
          ) {
            continue; // drop the button
          }
          frag.appendChild(child);
        }
        w.replaceWith(frag);
      } catch {
        // if unwrap fails, remove to avoid leaving UI artifacts
        try {
          w.remove();
        } catch {}
      }
    }
  }

  function isBlockElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = el.nodeName.toLowerCase();
    return (
      tag === "p" ||
      tag === "li" ||
      tag === "blockquote" ||
      tag === "dd" ||
      tag === "dt" ||
      tag === "h1" ||
      tag === "h2" ||
      tag === "h3" ||
      tag === "h4" ||
      tag === "h5" ||
      tag === "h6"
    );
  }

  function getBlockContainer(node) {
    let el = node && (node.nodeType === 1 ? node : node.parentElement);
    while (el && !isBlockElement(el)) {
      if (!el.parentElement) break;
      el = el.parentElement;
    }
    return el || null;
  }

  function collectTextNodes(container) {
    /** @type {Text[]} */
    const out = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        if (!node) return NodeFilter.FILTER_REJECT;
        const parent = node.parentNode;
        if (!parent || parent.nodeType !== Node.ELEMENT_NODE)
          return NodeFilter.FILTER_REJECT;
        if (
          /** @type {HTMLElement} */ (parent).closest(
            "." + TOOLBAR_CLASS + ", ." + SENTENCE_CLASS
          )
        )
          return NodeFilter.FILTER_REJECT;
        if (!node.nodeValue) return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) out.push(/** @type {Text} */ (n));
    return out;
  }

  function buildIndexMap(textNodes) {
    const map = [];
    let pos = 0;
    for (const tn of textNodes) {
      const text = tn.nodeValue || "";
      const start = pos;
      const end = start + text.length;
      map.push({ node: tn, start, end, text });
      pos = end;
    }
    return { map, length: pos };
  }

  function offsetsToDomPositions(index, startOffset, endOffset) {
    /** @type {{node: Text, offset: number}|null} */
    let startPos = null;
    /** @type {{node: Text, offset: number}|null} */
    let endPos = null;
    for (const item of index.map) {
      if (!startPos && startOffset >= item.start && startOffset <= item.end) {
        startPos = { node: item.node, offset: startOffset - item.start };
      }
      if (!endPos && endOffset >= item.start && endOffset <= item.end) {
        endPos = { node: item.node, offset: endOffset - item.start };
      }
      if (startPos && endPos) break;
    }
    return { startPos, endPos };
  }

  function findSentenceBounds(fullText, pos) {
    const len = fullText.length;
    // Sentence enders and line breaks define boundaries
    const enderRe = /[\.\!\?]|\n/g;
    let start = 0;
    let end = len;
    // scan backwards
    for (let i = pos - 1; i >= 0; i--) {
      const ch = fullText[i];
      if (ch === "\n" || ch === "." || ch === "!" || ch === "?") {
        start = i + 1;
        break;
      }
    }
    // trim leading spaces/quotes
    while (start < len && /[\s"'’”›»\)\]]/.test(fullText[start])) start++;
    // scan forwards
    for (let j = pos; j < len; j++) {
      const ch = fullText[j];
      if (ch === "\n" || ch === "." || ch === "!" || ch === "?") {
        end = j + 1;
        break;
      }
    }
    // include trailing quotes/brackets
    while (end < len && /["'’”›»\)\]]/.test(fullText[end])) end++;
    return { start, end };
  }

  function wrapSentenceRange(block, index, startOffset, endOffset) {
    const { startPos, endPos } = offsetsToDomPositions(
      index,
      startOffset,
      endOffset
    );
    if (!startPos || !endPos) return null;
    const r = document.createRange();
    r.setStart(startPos.node, Math.max(0, startPos.offset));
    r.setEnd(endPos.node, Math.max(0, endPos.offset));
    // avoid wrapping if already inside a sentence wrapper
    const common = r.commonAncestorContainer;
    if (
      common &&
      common.nodeType === 1 &&
      /** @type {HTMLElement} */ (common).closest("." + SENTENCE_CLASS)
    )
      return null;
    const wrap = document.createElement("span");
    wrap.className = SENTENCE_CLASS;
    const content = r.extractContents();
    wrap.appendChild(content);
    const btn = document.createElement("button");
    btn.className = SENTENCE_BTN_CLASS;
    btn.type = "button";
    btn.textContent = "Sil";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        wrap.remove();
      } catch {}
      // trigger a reapply after deletion settles
      scheduleReapply(200);
    });
    wrap.appendChild(btn);
    r.insertNode(wrap);
    return wrap;
  }

  function applySentenceWrappersFromSpans() {
    const spans = document.querySelectorAll("." + HIGHLIGHT_CLASS);
    for (const span of spans) {
      if (/** @type {HTMLElement} */ (span).closest("." + SENTENCE_CLASS))
        continue;
      const block = getBlockContainer(span);
      if (!block) continue;
      const textNodes = collectTextNodes(block);
      if (!textNodes.length) continue;
      const index = buildIndexMap(textNodes);
      // find the text node within this span
      const innerText = span.textContent || "";
      let matchTextNode = null;
      for (const tn of textNodes) {
        if (tn.parentElement === span) {
          matchTextNode = tn;
          break;
        }
      }
      if (!matchTextNode) continue;
      const item = index.map.find((m) => m.node === matchTextNode);
      if (!item) continue;
      const pos = item.start; // start of match within flattened block
      const bounds = findSentenceBounds(
        index.map.map((m) => m.text).join(""),
        pos
      );
      wrapSentenceRange(block, index, bounds.start, bounds.end);
    }
  }

  function applySentenceWrappersFromRanges() {
    // matches are Ranges in editor context
    /** @type {any[]} */
    const rgs = Array.isArray(matches) ? matches : [];
    for (const rg of rgs) {
      try {
        if (!rg || typeof rg.cloneRange !== "function") continue;
        const startNode = rg.startContainer;
        const block = getBlockContainer(startNode);
        if (!block) continue;
        if (/** @type {HTMLElement} */ (block).closest("." + SENTENCE_CLASS))
          continue;
        const textNodes = collectTextNodes(block);
        if (!textNodes.length) continue;
        const index = buildIndexMap(textNodes);
        // compute flattened offset of the start
        const mItem = index.map.find((m) => m.node === rg.startContainer);
        if (!mItem) continue;
        const pos = mItem.start + rg.startOffset;
        const bounds = findSentenceBounds(
          index.map.map((m) => m.text).join(""),
          pos
        );
        wrapSentenceRange(block, index, bounds.start, bounds.end);
      } catch {}
    }
  }

  function elementContainsMatch(el, regex) {
    if (!el) return false;
    // Try to minimize expensive regex calls by slicing reasonable text length
    const text = el.innerText || el.textContent || "";
    if (!text) return false;
    return regex.test(text);
  }

  function hideBlocksInDocument(regex) {
    // legacy (kept for backward compatibility, not used in editor)
    const blocks = document.querySelectorAll(
      "p, li, blockquote, dd, dt, h1, h2, h3, h4, h5, h6"
    );
    for (const el of blocks) {
      if (el.classList.contains(HIDDEN_BLOCK_CLASS)) continue;
      if (elementContainsMatch(el, regex)) {
        const previous = el.style.display || "";
        el.dataset[DATA_HH_PREV_DISPLAY] = previous;
        el.dataset[DATA_HH_HIDDEN] = "1";
        el.classList.add(HIDDEN_BLOCK_CLASS);
        el.style.display = "none";
      }
    }
  }

  function hideBlocksInRoots(roots, regex) {
    const containers = roots && roots.length ? roots : [document.body];
    for (const root of containers) {
      const blocks = root.querySelectorAll(
        "p, li, blockquote, dd, dt, h1, h2, h3, h4, h5, h6"
      );
      for (const el of blocks) {
        if (el.classList.contains(HIDDEN_BLOCK_CLASS)) continue;
        if (elementContainsMatch(el, regex)) {
          const previous = el.style.display || "";
          el.dataset[DATA_HH_PREV_DISPLAY] = previous;
          el.dataset[DATA_HH_HIDDEN] = "1";
          el.classList.add(HIDDEN_BLOCK_CLASS);
          el.style.display = "none";
        }
      }
    }
  }

  function clearHiddenBlocks() {
    const hidden = document.querySelectorAll(
      "." + HIDDEN_BLOCK_CLASS + ", [data-" + DATA_HH_HIDDEN + '="1"]'
    );
    for (const el of hidden) {
      if (el.dataset && el.dataset[DATA_HH_HIDDEN]) {
        const prev = el.dataset[DATA_HH_PREV_DISPLAY] || "";
        if (prev) {
          el.style.display = prev;
        } else {
          el.style.removeProperty("display");
        }
        delete el.dataset[DATA_HH_HIDDEN];
        delete el.dataset[DATA_HH_PREV_DISPLAY];
      }
      el.classList.remove(HIDDEN_BLOCK_CLASS);
    }
  }

  function getFocusedTop() {
    const el =
      document.querySelector("." + FOCUS_CLASS) ||
      (currentIndex >= 0 && matches[currentIndex]);
    if (!el) return null;
    try {
      if (typeof el.getBoundingClientRect === "function") {
        const r = el.getBoundingClientRect();
        return r.top + window.scrollY;
      }
      if (
        el &&
        typeof el.getBoundingClientRect !== "function" &&
        typeof el.getClientRects === "function"
      ) {
        const rect = el.getBoundingClientRect
          ? el.getBoundingClientRect()
          : el.getClientRects()[0] || null;
        if (rect) return rect.top + window.scrollY;
      }
    } catch {}
    try {
      // Range case
      const r = el.getBoundingClientRect();
      return r.top + window.scrollY;
    } catch {}
    return null;
  }

  function getFocusedId() {
    const el =
      document.querySelector("." + FOCUS_CLASS) ||
      (currentIndex >= 0 && matches[currentIndex]);
    if (!el || !el.dataset) return null;
    return el.dataset.hhId || null;
  }

  function findClosestIndexByTop(targetTop) {
    if (!matches.length) return -1;
    let best = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < matches.length; i++) {
      const r = matches[i].getBoundingClientRect();
      const top = r.top + window.scrollY;
      const d = Math.abs(top - targetTop);
      if (d < bestDiff) {
        bestDiff = d;
        best = i;
      }
    }
    return best;
  }

  function findClosestIndexByTopWithBias(targetTop, prevIdx, dir) {
    if (!matches.length) return -1;
    const EPS = 1; // px tolerance for same line
    let candidates = [];
    let bestDiff = Infinity;
    for (let i = 0; i < matches.length; i++) {
      const r = matches[i].getBoundingClientRect();
      const top = r.top + window.scrollY;
      const d = Math.abs(top - targetTop);
      if (d < bestDiff - 0.001) {
        bestDiff = d;
        candidates = [i];
      } else if (Math.abs(d - bestDiff) <= EPS) {
        candidates.push(i);
      }
    }
    if (!candidates.length) return findClosestIndexByTop(targetTop);
    if (prevIdx == null || prevIdx < 0 || dir === 0) return candidates[0];
    if (dir > 0) {
      // prefer the first candidate at or after previous index
      for (const i of candidates) {
        if (i >= prevIdx) return i;
      }
      return candidates[candidates.length - 1];
    } else {
      // prefer the last candidate at or before previous index
      for (let k = candidates.length - 1; k >= 0; k--) {
        const i = candidates[k];
        if (i <= prevIdx) return i;
      }
      return candidates[0];
    }
  }

  // Detect WordPress editor content roots (Gutenberg + Classic)
  function detectEditorRoots() {
    const roots = [];
    try {
      // Gutenberg content area
      const gutenRoot = document.querySelector(
        ".block-editor-block-list__layout.is-root-container"
      );
      if (gutenRoot) roots.push(gutenRoot);

      // Post title input
      const postTitle = document.querySelector(
        ".editor-post-title__input, .editor-post-title .editor-post-title__input, h1.editor-post-title__input"
      );
      if (postTitle) roots.push(postTitle);

      // Classic freeform block content
      const classics = document.querySelectorAll(
        ".wp-block-freeform .mce-content-body, .block-library-rich-text__tinymce.mce-content-body"
      );
      classics.forEach((el) => roots.push(el));

      // TinyMCE iframe body (if present)
      const iframes = document.querySelectorAll("iframe");
      for (const ifr of iframes) {
        const doc =
          ifr.contentDocument ||
          (ifr.contentWindow && ifr.contentWindow.document);
        if (!doc) continue;
        const body = doc.body;
        if (!body) continue;
        if (
          body.classList &&
          (body.classList.contains("mce-content-body") ||
            body.querySelector(".mce-content-body"))
        ) {
          roots.push(body);
        }
      }
    } catch {}
    return roots.filter(Boolean);
  }

  function applySettings() {
    // Compute roots and context
    const editorRoots = detectEditorRoots();
    isEditorContext = editorRoots.length > 0;
    searchRoots = isEditorContext ? editorRoots : [document.body];
    skipContentEditable = !isEditorContext;

    const prevTop = getFocusedTop();
    const prevId = getFocusedId();
    const prevIdx = currentIndex;
    const regex = buildRegexFromKeywords(
      currentSettings.keywords,
      currentSettings.matchCase,
      currentSettings.wholeWords
    );

    // Always clear previous state to avoid duplicates
    clearHighlights();
    clearHiddenBlocks();
    clearCustomHighlights();
    clearSentenceWrappers();

    if (!currentSettings.enabled || !regex) {
      updateToolbar();
      return;
    }

    if (currentSettings.mode === "hide" && !isEditorContext) {
      // Only allow hide on regular pages, not in editors
      hideBlocksInRoots(searchRoots, regex);
    } else {
      if (isEditorContext && window.CSS && CSS.highlights) {
        highlightWithCSSHighlights(regex, searchRoots);
      } else {
        highlightInDocument(regex, searchRoots);
      }
    }

    // Sentence-level wrappers with delete button
    try {
      if (isEditorContext && window.CSS && CSS.highlights) {
        applySentenceWrappersFromRanges();
      } else {
        applySentenceWrappersFromSpans();
      }
    } catch {}

    // Recalculate currentIndex to preserve position if possible
    if (currentSettings.mode !== "hide") {
      if (matches.length === 0) {
        currentIndex = -1;
      } else if (prevIdx >= 0) {
        currentIndex = Math.min(prevIdx, matches.length - 1);
      } else if (prevTop != null) {
        currentIndex = findClosestIndexByTopWithBias(
          prevTop,
          prevIdx,
          lastNavDir
        );
      } else if (currentIndex < 0) {
        currentIndex = 0;
      } else if (currentIndex >= matches.length) {
        currentIndex = matches.length - 1;
      }
    } else {
      currentIndex = -1;
    }

    updateToolbar();
  }

  function scheduleReapply(delay = 250) {
    if (reapplyTimer) {
      clearTimeout(reapplyTimer);
    }
    reapplyTimer = setTimeout(() => {
      reapplyTimer = null;
      applySettings();
    }, delay);
  }

  function loadSettingsAndApply() {
    try {
      chrome.storage.sync.get([SETTINGS_KEY], (res) => {
        const stored = res && res[SETTINGS_KEY] ? res[SETTINGS_KEY] : {};
        currentSettings = { ...DEFAULT_SETTINGS, ...stored };
        scheduleReapply(0);
      });
    } catch (e) {
      // In case storage isn't available, fall back to defaults
      currentSettings = { ...DEFAULT_SETTINGS };
      scheduleReapply(0);
    }
  }

  // Listen for storage changes
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "sync" && changes[SETTINGS_KEY]) {
        const { newValue } = changes[SETTINGS_KEY];
        currentSettings = { ...DEFAULT_SETTINGS, ...(newValue || {}) };
        scheduleReapply(0);
      }
    });
  } catch {}

  // Listen for direct messages from popup
  try {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || !message.type) return;
      if (message.type === "HH_APPLY_NOW") {
        loadSettingsAndApply();
        sendResponse({ ok: true });
      } else if (message.type === "HH_CLEAR_NOW") {
        clearHighlights();
        clearHiddenBlocks();
        clearSentenceWrappers();
        sendResponse({ ok: true });
      }
    });
  } catch {}

  // Re-apply on DOM mutations when enabled to cover dynamic content
  const observer = new MutationObserver((mutations) => {
    if (!currentSettings.enabled) return;
    if (Date.now() < suppressReapplyUntil) return; // temporarily suppress re-apply after navigation
    for (const m of mutations) {
      // Ignore mutations that originate from the toolbar itself
      if (
        toolbar &&
        (m.target === toolbar ||
          (toolbar.contains && toolbar.contains(m.target)))
      ) {
        continue;
      }
      if (m.type === "childList" || m.type === "characterData") {
        scheduleReapply(300);
        break;
      }
    }
  });

  try {
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  } catch {}

  // Initial load
  loadSettingsAndApply();

  // ===== UI position persistence and dragging =====
  function loadUiState(cb) {
    try {
      chrome.storage.local.get([UI_KEY], (res) => {
        const stored = res && res[UI_KEY] ? res[UI_KEY] : {};
        uiState = { toolbar: { x: null, y: null }, ...stored };
        if (!uiState.toolbar) uiState.toolbar = { x: null, y: null };
        if (cb) cb();
      });
    } catch {
      uiState = { toolbar: { x: null, y: null } };
      if (cb) cb();
    }
  }

  function saveUiState() {
    try {
      chrome.storage.local.set({ [UI_KEY]: uiState });
    } catch {}
  }

  function applyToolbarPosition() {
    if (!toolbar) return;
    const pos = uiState && uiState.toolbar ? uiState.toolbar : null;
    if (pos && typeof pos.x === "number" && typeof pos.y === "number") {
      toolbar.style.left = Math.max(4, pos.x) + "px";
      toolbar.style.top = Math.max(4, pos.y) + "px";
      toolbar.style.right = "auto";
      toolbar.style.bottom = "auto";
    }
  }

  function setupToolbarDrag() {
    if (!toolbar) return;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let origX = 0;
    let origY = 0;

    const onPointerDown = (e) => {
      const target = /** @type {HTMLElement} */ (e.target);
      if (target && target.closest && target.closest("button")) return;
      dragging = true;
      toolbar.classList.add("dragging");
      try {
        toolbar.setPointerCapture(e.pointerId);
      } catch {}
      const rect = toolbar.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      origX = rect.left;
      origY = rect.top;
      e.preventDefault();
    };

    const onPointerMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      let x = origX + dx;
      let y = origY + dy;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const tbRect = toolbar.getBoundingClientRect();
      const maxX = vw - tbRect.width - 4;
      const maxY = vh - tbRect.height - 4;
      x = Math.max(4, Math.min(maxX, x));
      y = Math.max(4, Math.min(maxY, y));
      toolbar.style.left = x + "px";
      toolbar.style.top = y + "px";
      toolbar.style.right = "auto";
      toolbar.style.bottom = "auto";
      e.preventDefault();
    };

    const onPointerUp = (e) => {
      if (!dragging) return;
      dragging = false;
      toolbar.classList.remove("dragging");
      try {
        toolbar.releasePointerCapture(e.pointerId);
      } catch {}
      const rect = toolbar.getBoundingClientRect();
      uiState.toolbar.x = Math.round(rect.left);
      uiState.toolbar.y = Math.round(rect.top);
      saveUiState();
    };

    toolbar.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerUp);
  }

  // ===== Floating toolbar =====
  function ensureToolbar() {
    if (toolbar && document.contains(toolbar)) return toolbar;
    toolbar = document.createElement("div");
    toolbar.className = TOOLBAR_CLASS;
    toolbar.innerHTML = `
      <button class=\"hh-btn\" id=\"hh-prev\" title=\"Önceki\">⟨</button>
      <div class=\"hh-counter\" id=\"hh-counter\">0/0</div>
      <span class=\"hh-state\" id=\"hh-state\">Açık</span>
      <button class=\"hh-btn\" id=\"hh-next\" title=\"Sonraki\">⟩</button>
      <button class=\"hh-btn\" id=\"hh-toggle\" title=\"Aç/Kapat\">⏻</button>
    `;
    document.documentElement.appendChild(toolbar);

    const prevBtn = toolbar.querySelector("#hh-prev");
    const nextBtn = toolbar.querySelector("#hh-next");
    const toggleBtn = toolbar.querySelector("#hh-toggle");

    prevBtn.addEventListener("click", () => gotoPrev());
    nextBtn.addEventListener("click", () => gotoNext());
    toggleBtn.addEventListener("click", () => toggleEnabled());

    // Load saved UI position and setup drag
    loadUiState(() => {
      applyToolbarPosition();
      setupToolbarDrag();
    });

    return toolbar;
  }

  function toggleEnabled() {
    const next = { ...currentSettings, enabled: !currentSettings.enabled };
    try {
      chrome.storage.sync.set({ [SETTINGS_KEY]: next });
    } catch {}
    currentSettings = next;
    updateToolbar();
  }

  function updateToolbar() {
    const tb = ensureToolbar();
    const counter = tb.querySelector("#hh-counter");
    const prevBtn = tb.querySelector("#hh-prev");
    const nextBtn = tb.querySelector("#hh-next");
    const stateEl = tb.querySelector("#hh-state");
    const toggleBtn = tb.querySelector("#hh-toggle");
    const total = matches.length;
    const idx = currentIndex >= 0 ? currentIndex + 1 : 0;
    counter.textContent = `${idx}/${total}`;
    const disabled =
      !currentSettings.enabled ||
      (currentSettings.mode === "hide" && !isEditorContext) ||
      total === 0;
    prevBtn.disabled = disabled;
    nextBtn.disabled = disabled;
    stateEl.textContent = currentSettings.enabled ? "Açık" : "Kapalı";
    toggleBtn.title = currentSettings.enabled ? "Kapat" : "Aç";
    tb.classList.toggle("hh-off", !currentSettings.enabled);
    if (
      navFocusPending &&
      !disabled &&
      currentIndex >= 0 &&
      matches[currentIndex]
    ) {
      focusMatch(matches[currentIndex]);
      navFocusPending = false;
    }
  }

  function focusMatch(target) {
    // Range (editor) path
    try {
      if (window.Range && target && typeof target.cloneRange === "function") {
        const doc =
          (target.startContainer && target.startContainer.ownerDocument) ||
          document;
        const win = doc.defaultView || window;
        // update focus highlight within the correct document
        try {
          const H = (win && win.Highlight) || Highlight;
          const map = win && win.CSS && win.CSS.highlights;
          if (map && H) {
            map.delete("hhFocus");
            map.set("hhFocus", new H(target));
          }
        } catch {}
        // scroll the start element into view (works with scrollable editor containers)
        let anchor = target.startContainer;
        if (anchor && anchor.nodeType === 3) anchor = anchor.parentElement;
        if (anchor && typeof anchor.scrollIntoView === "function") {
          anchor.scrollIntoView({
            behavior: "smooth",
            block: "center",
            inline: "nearest",
          });
          return;
        }
        // fallback to geometry scroll on the owning window
        const rect = target.getBoundingClientRect();
        if (rect && (rect.height || rect.width)) {
          const y = Math.max(0, rect.top + win.scrollY - 120);
          win.scrollTo({ top: y, behavior: "smooth" });
          return;
        }
      }
    } catch {}

    // Element path (non-editor)
    const prev = document.querySelector("." + FOCUS_CLASS);
    if (prev) prev.classList.remove(FOCUS_CLASS);
    if (target && target.classList) target.classList.add(FOCUS_CLASS);
    try {
      if (target && typeof target.scrollIntoView === "function") {
        target.scrollIntoView({
          behavior: "smooth",
          block: "center",
          inline: "nearest",
        });
      }
    } catch {}
  }

  function gotoNext() {
    if (!matches.length) return;
    currentIndex = (currentIndex + 1) % matches.length;
    lastNavDir = 1;
    navFocusPending = true;
    suppressReapplyUntil = Date.now() + 700;
    if (reapplyTimer) {
      try {
        clearTimeout(reapplyTimer);
      } catch {}
      reapplyTimer = null;
    }
    updateToolbar();
  }

  function gotoPrev() {
    if (!matches.length) return;
    currentIndex = (currentIndex - 1 + matches.length) % matches.length;
    lastNavDir = -1;
    navFocusPending = true;
    suppressReapplyUntil = Date.now() + 700;
    if (reapplyTimer) {
      try {
        clearTimeout(reapplyTimer);
      } catch {}
      reapplyTimer = null;
    }
    updateToolbar();
  }

  // keyboard shortcuts when toolbar is present
  document.addEventListener(
    "keydown",
    (e) => {
      const activeTag = (
        (document.activeElement && document.activeElement.tagName) ||
        ""
      ).toLowerCase();
      if (
        activeTag === "input" ||
        activeTag === "textarea" ||
        activeTag === "select" ||
        (document.activeElement && document.activeElement.isContentEditable)
      )
        return;
      if (!toolbar || !document.contains(toolbar)) return;
      if (e.key === "F3" || (e.ctrlKey && e.key === "g")) {
        // next
        gotoNext();
        e.preventDefault();
      } else if (
        (e.shiftKey && e.key === "F3") ||
        (e.ctrlKey && e.shiftKey && e.key === "g")
      ) {
        // prev
        gotoPrev();
        e.preventDefault();
      }
    },
    true
  );
})();
