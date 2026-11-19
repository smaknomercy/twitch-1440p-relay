// ============================================================
// Twitch 1440p Relay — background service worker
// ============================================================
// Keeps the toolbar badge in sync with the on/off setting.
// ============================================================

importScripts("config.js");

async function refreshBadge() {
    const { enabled } = await TW2K.load();
    chrome.action.setBadgeText({ text: enabled ? "ON" : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#9147FF" });
}

chrome.runtime.onInstalled.addListener(refreshBadge);
chrome.runtime.onStartup.addListener(refreshBadge);

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && "enabled" in changes) refreshBadge();
});
