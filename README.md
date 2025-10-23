## HighlightHero

A simple and fast Chrome/Edge extension (Manifest V3) that highlights keywords on any page or hides paragraphs/blocks containing them. Edit the keyword list from the popup, switch modes with one click, and navigate matches with a small in-page toolbar.

Version: 0.1.0

### Features

- **Highlight mode**: Keywords are highlighted on the page.
- **Hide mode**: Block elements containing a match (p, li, blockquote, headings, etc.) are hidden.
- **Instant tweaking**: Keyword list, color, Match case, and Whole words options apply immediately.
- **In-page toolbar**: Total/current match counter, previous/next buttons, and On/Off state.
- **Keyboard shortcuts**: F3 or Ctrl+G for next; Shift+F3 or Ctrl+Shift+G for previous.
- **Dynamic content support**: Automatically reapplies highlights/hides as the page updates.

### Installation (Developer Mode)

Unpacked install for Chrome or Edge:

1. Download this repo or copy the folder to your computer.
2. Open `chrome://extensions` in Chrome/Edge.
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select this folder (`HighlightHero`).
5. Pin the extension and start using the popup.

> Note: After you change the code, click **Reload** on the extensions page to reload the service worker and content scripts.

### Usage

1. Click the extension icon in the browser toolbar.
2. Use the **Enabled** switch to turn the feature on/off.
3. Choose between **Highlight/Hide** modes.
4. Optionally toggle **Match case** and **Whole words**.
5. Pick the highlight **Color**.
6. Enter **Keywords**, one per line (commas also work). Changes are saved automatically.
7. Use **Apply on this tab** to apply immediately; **Clear** to remove highlights; **Reset** to restore defaults.

When the in-page toolbar is visible:

- Use **⟨ / ⟩** to go to the previous/next match.
- **F3 or Ctrl+G** goes to next; **Shift+F3 or Ctrl+Shift+G** goes to previous.

### Permissions and Scope

- `storage`: To store settings in sync storage.
- `tabs`: To send messages to the active tab.
- The content script runs on all sites (`<all_urls>`) and loads at `document_idle`.

### Privacy

- Data is stored only in the browser's sync storage (`chrome.storage.sync`).
- No data is sent to any external server; no network requests are made.

### Directory Structure

```
background.js   # Service worker; ensures default settings
content.js      # Highlight/hide logic + in-page toolbar
content.css     # Styles for highlights and toolbar
manifest.json   # MV3 manifest
popup.html      # Popup UI
popup.js        # Popup logic and settings sync
```

### Development

- After making changes, **Reload** the extension from `chrome://extensions` and refresh the page.
- To bump the release, increase the `version` field in `manifest.json`.
- The UI text is currently **Turkish** (popup and toolbar). To add other languages, extract and localize strings in `popup.html/popup.js` and `content.js`.

### Known Limitations

- Code, style, `textarea`, `contenteditable`, and existing highlights are skipped.
- With **Whole words**, `\b` boundaries may behave differently across languages/alphabets.

### Troubleshooting

- If matches don't appear: verify keywords, **Match case**, and **Whole words** settings.
- On some sites, overlays can cover the toolbar; try scrolling or adjusting zoom.
- There may be conflicts with content blockers/other extensions; temporarily disable them and try again.

### License

No license specified yet.
