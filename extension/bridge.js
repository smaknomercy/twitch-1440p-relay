// ============================================================
// Twitch 2K Unlocker — bridge (isolated world, document_start)
// ============================================================
// Reads settings from chrome.storage and exposes the relay URL
// to hook.js (which runs in the page's MAIN world and has no
// access to chrome.* APIs) via a data attribute on <html>.
// ============================================================

chrome.storage.local.get(["enabled", "proxyUrl"]).then(({ enabled, proxyUrl }) => {
    if (enabled && proxyUrl) {
        document.documentElement.dataset.tw2kProxy = proxyUrl.trim();
    } else {
        delete document.documentElement.dataset.tw2kProxy;
    }
});
