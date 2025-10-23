// HighlightHero - popup logic (MV3)

const SETTINGS_KEY = "hhSettings";

const DEFAULT_SETTINGS = {
  enabled: true,
  mode: "highlight", // 'highlight' | 'hide'
  keywords: [],
  matchCase: false,
  wholeWords: false,
  highlightColor: "#ffed75",
};

function getEl(id) {
  return /** @type {HTMLElement} */ (document.getElementById(id));
}

const $enabled = /** @type {HTMLInputElement} */ (getEl("enabled"));
const $modeHighlight = /** @type {HTMLButtonElement} */ (
  getEl("modeHighlight")
);
const $modeHide = /** @type {HTMLButtonElement} */ (getEl("modeHide"));
const $matchCase = /** @type {HTMLInputElement} */ (getEl("matchCase"));
const $wholeWords = /** @type {HTMLInputElement} */ (getEl("wholeWords"));
const $highlightColor = /** @type {HTMLInputElement} */ (
  getEl("highlightColor")
);
const $keywords = /** @type {HTMLTextAreaElement} */ (getEl("keywords"));
const $applyBtn = /** @type {HTMLButtonElement} */ (getEl("applyBtn"));
const $clearBtn = /** @type {HTMLButtonElement} */ (getEl("clearBtn"));
const $resetBtn = /** @type {HTMLButtonElement} */ (getEl("resetBtn"));

let current = { ...DEFAULT_SETTINGS };
let saveTimer = null;

function debounceSave(fn, delay = 200) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fn();
  }, delay);
}

function parseKeywords(text) {
  return (text || "")
    .split(/\r?\n|,/) // allow comma or newlines
    .map((k) => k.trim())
    .filter(Boolean);
}

function stringifyKeywords(arr) {
  return (arr || []).join("\n");
}

function loadSettings() {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get([SETTINGS_KEY], (res) => {
        const stored = res && res[SETTINGS_KEY] ? res[SETTINGS_KEY] : {};
        current = { ...DEFAULT_SETTINGS, ...stored };
        resolve(current);
      });
    } catch {
      current = { ...DEFAULT_SETTINGS };
      resolve(current);
    }
  });
}

function saveSettings(next) {
  current = { ...current, ...next };
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.set({ [SETTINGS_KEY]: current }, () =>
        resolve(current)
      );
    } catch {
      resolve(current);
    }
  });
}

async function sendToActiveTab(message) {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (tab && tab.id != null) {
      await chrome.tabs.sendMessage(tab.id, message);
    }
  } catch {}
}

function updateModeButtons(mode) {
  const isHighlight = mode === "highlight";
  $modeHighlight.classList.toggle("active", isHighlight);
  $modeHide.classList.toggle("active", !isHighlight);
  $modeHighlight.setAttribute("aria-pressed", String(isHighlight));
  $modeHide.setAttribute("aria-pressed", String(!isHighlight));
}

function bindEvents() {
  $enabled.addEventListener("change", () => {
    debounceSave(async () => {
      await saveSettings({ enabled: $enabled.checked });
      if ($enabled.checked) {
        await sendToActiveTab({ type: "HH_APPLY_NOW" });
      } else {
        await sendToActiveTab({ type: "HH_CLEAR_NOW" });
      }
    });
  });

  $modeHighlight.addEventListener("click", () => {
    updateModeButtons("highlight");
    debounceSave(async () => {
      await saveSettings({ mode: "highlight" });
      await sendToActiveTab({ type: "HH_APPLY_NOW" });
    });
  });

  $modeHide.addEventListener("click", () => {
    updateModeButtons("hide");
    debounceSave(async () => {
      await saveSettings({ mode: "hide" });
      await sendToActiveTab({ type: "HH_APPLY_NOW" });
    });
  });

  $matchCase.addEventListener("change", () => {
    debounceSave(async () => {
      await saveSettings({ matchCase: $matchCase.checked });
      await sendToActiveTab({ type: "HH_APPLY_NOW" });
    });
  });

  $wholeWords.addEventListener("change", () => {
    debounceSave(async () => {
      await saveSettings({ wholeWords: $wholeWords.checked });
      await sendToActiveTab({ type: "HH_APPLY_NOW" });
    });
  });

  $highlightColor.addEventListener("input", () => {
    debounceSave(async () => {
      await saveSettings({
        highlightColor: $highlightColor.value || "#ffed75",
      });
      await sendToActiveTab({ type: "HH_APPLY_NOW" });
    });
  });

  $keywords.addEventListener("input", () => {
    debounceSave(async () => {
      await saveSettings({ keywords: parseKeywords($keywords.value) });
      await sendToActiveTab({ type: "HH_APPLY_NOW" });
    });
  });

  $applyBtn.addEventListener("click", async () => {
    await sendToActiveTab({ type: "HH_APPLY_NOW" });
  });

  $clearBtn.addEventListener("click", async () => {
    await sendToActiveTab({ type: "HH_CLEAR_NOW" });
  });

  $resetBtn.addEventListener("click", async () => {
    await saveSettings({ ...DEFAULT_SETTINGS });
    await hydrateUI();
    await sendToActiveTab({ type: "HH_APPLY_NOW" });
  });
}

async function hydrateUI() {
  const s = await loadSettings();
  $enabled.checked = !!s.enabled;
  updateModeButtons(s.mode === "hide" ? "hide" : "highlight");
  $matchCase.checked = !!s.matchCase;
  $wholeWords.checked = !!s.wholeWords;
  $highlightColor.value = s.highlightColor || "#ffed75";
  $keywords.value = stringifyKeywords(s.keywords);
}

document.addEventListener("DOMContentLoaded", async () => {
  await hydrateUI();
  bindEvents();
});
