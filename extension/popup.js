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

// ---- Relay test ----

const testBtn = document.getElementById("test-btn");
const testResult = document.getElementById("test-result");

const RES_NAMES = { ULTRA_HD: "2160p", QUAD_HD: "1440p", FULL_HD: "1080p" };

function addRow(label, value, cls) {
    const li = document.createElement("li");
    const l = document.createElement("span");
    l.className = "label";
    l.textContent = label;
    const v = document.createElement("span");
    v.className = cls;
    v.textContent = value;
    li.append(l, v);
    testResult.append(li);
}

async function getTwitchAuth() {
    try {
        const c = await chrome.cookies.get({ url: "https://www.twitch.tv", name: "auth-token" });
        return c ? "OAuth " + decodeURIComponent(c.value) : "";
    } catch {
        return "";
    }
}

async function getActiveChannel() {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const m = tab?.url?.match(/^https:\/\/www\.twitch\.tv\/([a-z0-9_]{1,25})(?:[/?#]|$)/i);
        return m ? m[1] : "";
    } catch {
        return "";
    }
}

testBtn.addEventListener("click", async () => {
    const relayUrl = urlInput.value.trim();
    const relayKey = keyInput.value.trim();
    if (!relayUrl) return flash(urlInput);
    if (!relayKey) return flash(keyInput);

    testBtn.disabled = true;
    testBtn.textContent = "Testing…";
    testResult.replaceChildren();
    testResult.hidden = false;

    try {
        const [auth, channel] = await Promise.all([getTwitchAuth(), getActiveChannel()]);
        const r = await fetch(TW2K.buildUrl(relayUrl, relayKey), {
            method: "POST",
            body: JSON.stringify({ type: "check", channel, auth }),
        });

        if (r.status === 403) {
            addRow("Relay", "wrong key", "bad");
            return;
        }
        if (r.status === 503) {
            addRow("Relay", "RELAY_KEY not set on the relay", "bad");
            return;
        }
        if (!r.ok) {
            addRow("Relay", `error ${r.status}`, "bad");
            return;
        }

        const j = await r.json();
        addRow("Relay", `running v${j.version}`, "ok");

        const country = j.egress?.country || "?";
        const where = [country, j.egress?.city].filter(Boolean).join(", ");
        addRow("Twitch sees", where, country === "US" ? "ok" : "warn");

        const t = j.token_check || {};
        if (t.error) {
            addRow("Token", "Twitch rejected the request", "bad");
            return;
        }
        addRow("Logged in", t.logged_in ? "yes" : "no", t.logged_in ? "ok" : "bad");

        const res = RES_NAMES[t.maximum_resolution] || t.maximum_resolution || "?";
        const reasons = Object.values(t.maximum_resolution_reasons || {}).flat();
        const unlocked = ["QUAD_HD", "ULTRA_HD"].includes(t.maximum_resolution);
        addRow("Max quality", unlocked ? res : `${res} (${[...new Set(reasons)].join(", ") || "limited"})`, unlocked ? "ok" : "bad");
    } catch (e) {
        addRow("Relay", "can't reach it — check the URL", "bad");
    } finally {
        testBtn.disabled = false;
        testBtn.textContent = "Test relay";
    }
});

// ---- Setup link ----

setupLink.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: "https://github.com/smaknomercy/twitch-1440p-relay#setup" });
});
