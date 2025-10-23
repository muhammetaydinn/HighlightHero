// HighlightHero - background (service worker)

const SETTINGS_KEY = "hhSettings";
const DEFAULT_SETTINGS = {
  enabled: true,
  mode: "highlight",
  keywords: [],
  matchCase: false,
  wholeWords: false,
  highlightColor: "#ffed75",
};

function ensureDefaults() {
  try {
    chrome.storage.sync.get([SETTINGS_KEY], (res) => {
      const exists = res && res[SETTINGS_KEY];
      if (!exists) {
        chrome.storage.sync.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
      }
    });
  } catch {}
}

chrome.runtime.onInstalled.addListener((_details) => {
  ensureDefaults();
});

chrome.runtime.onStartup.addListener(() => {
  ensureDefaults();
});
