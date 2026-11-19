// ============================================================
// Twitch 1440p Relay — popup
// ============================================================

const toggle = document.getElementById("toggle");
const urlInput = document.getElementById("relay-url");
const keyInput = document.getElementById("relay-key");
const keyReveal = document.getElementById("key-reveal");
const statusEl = document.getElementById("status");
const setupLink = document.getElementById("setup-link");

function flash(input) {
    input.focus();
    input.classList.add("invalid");
    setTimeout(() => input.classList.remove("invalid"), 1500);
}

function updateStatusText(enabled) {
    statusEl.classList.remove("active", "inactive");
    if (enabled) {
        statusEl.textContent = "On — refresh the stream to apply";
        statusEl.classList.add("active");
    } else {
        statusEl.textContent = "Disabled";
        statusEl.classList.add("inactive");
    }
}

// ---- Load ----

TW2K.load().then(({ enabled, relayUrl, relayKey }) => {
    toggle.checked = enabled;
    urlInput.value = relayUrl;
    keyInput.value = relayKey;
    updateStatusText(enabled);
});

// ---- Save fields ----

// If someone pastes a URL with ?key=..., split it into both fields.
urlInput.addEventListener("change", () => {
    const { url, key } = TW2K.splitUrl(urlInput.value);
    urlInput.value = url;
    if (key) keyInput.value = key;
    chrome.storage.local.set({ relayUrl: url, relayKey: keyInput.value.trim() });
});

keyInput.addEventListener("change", () => {
    chrome.storage.local.set({ relayKey: keyInput.value.trim() });
});

keyReveal.addEventListener("click", () => {
    const hidden = keyInput.type === "password";
    keyInput.type = hidden ? "text" : "password";
    keyReveal.textContent = hidden ? "Hide" : "Show";
});

// ---- Toggle ----

toggle.addEventListener("change", () => {
    const enabled = toggle.checked;
    if (enabled) {
        if (!urlInput.value.trim()) {
            toggle.checked = false;
            return flash(urlInput);
        }
        if (!keyInput.value.trim()) {
            toggle.checked = false;
            return flash(keyInput);
        }
    }
    chrome.storage.local.set({
        enabled,
        relayUrl: urlInput.value.trim(),
        relayKey: keyInput.value.trim(),
    });
    updateStatusText(enabled);
});

// ---- Setup link ----

setupLink.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: "https://github.com/smaknomercy/twitch-1440p-relay#setup" });
});
