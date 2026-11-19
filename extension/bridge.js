// ============================================================
// Twitch 1440p Relay — bridge (isolated world, document_start)
// ============================================================
// Reads settings from chrome.storage and exposes the full relay
// URL to hook.js (MAIN world, no chrome.* access) via a data
// attribute on <html>.
// ============================================================

TW2K.load().then(({ enabled, relayUrl, relayKey }) => {
    const root = document.documentElement;
    if (enabled && relayUrl && relayKey) {
        try {
            root.dataset.tw2kProxy = TW2K.buildUrl(relayUrl, relayKey);
            return;
        } catch {
            // invalid URL in settings — treat as disabled
        }
    }
    delete root.dataset.tw2kProxy;
});
