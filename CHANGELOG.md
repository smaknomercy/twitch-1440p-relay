# Changelog

## 3.1.0 — 2026-11-19

- Relay forwards the viewer's Twitch session token, so Twitch issues a 1440p (`QUAD_HD`) token. Without it Twitch answers `AUTHZ_NOT_LOGGED_IN`.

## 3.0.0 — 2026-11-19

- The extension wraps `window.Worker` and patches `fetch` inside the player's Web Worker, where Twitch now requests the usher playlist.
- The relay fetches a fresh `PlaybackAccessToken` itself and swaps it into the usher URL.
- `wrangler.toml` pins the relay near `aws:us-east-1`, so Twitch sees a US IP.
- Extension and relay moved into `extension/` and `relay/`.

## 2.0.1-security — 2026-11-19

- Relay requires an access key (`RELAY_KEY` secret, `?key=` in the URL).
- Usher URLs are validated by parsed hostname. Before, a substring check let the relay fetch arbitrary URLs.

## 2.0.1 and earlier

Original extension by [ddaccu](https://github.com/ddaccu/twitch-2k-unlocker).
