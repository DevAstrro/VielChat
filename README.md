# VeilChat — black glass, ephemeral text + file sharing

This is a development starter, not an audited secure messenger. It provides temporary two-person sessions, text chat, image/document transfer, and a black glassmorphic interface inspired by the supplied `Glassmorphic Choreographed Password Page.html` reference.

## Run locally

Requires Node.js 20+.

```bash
npm install
cp .env.example .env
npm start
```

Open `http://localhost:3000` in two separate browser profiles. Create a session in one and enter the 25-character code in the other.

## Included protections

- 25-character invitation generated with Node's cryptographic random source (125 bits of entropy over a 32-character alphabet), one recipient, single use.
- Invitation expiry after 10 minutes; active session expiry after one hour.
- Session and invitation state kept in process memory only; no database or application-level chat/file storage.
- WebSocket Origin validation against `PUBLIC_ORIGIN`; WebSocket payload limit; allowlisted signaling message types and bounded SDP/ICE payloads.
- Connection count limit per observed IP, per-IP session creation throttling, a global in-memory room cap, and WebSocket heartbeat checks (single process only; not a complete DoS defense).
- Production startup rejects a non-HTTPS `PUBLIC_ORIGIN`; WebSocket CSP is limited to the configured public origin.
- Security headers: restrictive Content Security Policy, no-referrer, nosniff, no-store, COOP/CORP; HSTS when `NODE_ENV=production`.
- No Google scripts, fonts, analytics, or default Google STUN service.
- Text and file content transferred over WebRTC DataChannel; WebRTC encrypts the transport.
- File size limit, chunk bounds, two concurrent inbound transfers, safe DOM text insertion, object URL tracking.
- End & destroy: sends a server-side room destruction request, closes peer connections, clears the visible message list, pending file chunks and local object URLs.
- Best-effort privacy veil when the page becomes hidden. This is not screenshot prevention.

## Security limits — do not skip

1. **Not perfect E2EE authentication:** the signaling server exchanges WebRTC SDP/ICE and can attempt a man-in-the-middle. The displayed verification code is a manually compared short authentication string derived from DTLS fingerprints. It is not a formally reviewed protocol. Compare it over a separate trusted channel, and do not rely on this implementation for high-risk use.
2. **Frontend delivery is trusted:** a host that can replace `app.js` can capture text/files before they are encrypted. A malicious browser extension or compromised device can do the same. Static web E2EE cannot remove this trust without stronger distribution and verification practices.
3. **No screenshot guarantee:** browsers cannot reliably block OS screenshots, recordings, external cameras, or copied/downloaded files. The visibility veil only obscures the page after a visibility event.
4. **No immediate physical memory wipe:** JavaScript can drop references and revoke blob URLs, but cannot guarantee memory pages are overwritten or erase OS/browser crash dumps.
5. **Provider logs:** reverse proxies, hosting providers, DNS providers, and network operators may keep connection metadata. Configure provider logging and retention separately. Application code cannot control all provider-level logs.
6. **Network reachability:** no external STUN server is configured to avoid contacting Google by default. Some networks will fail to establish WebRTC connections. For better reachability, self-host STUN/TURN and understand the metadata that service can observe.
7. **File scanning:** type/extension checks are convenience filters, not malware protection. Treat received files as untrusted.
8. **No independent review:** this project has not undergone penetration testing, protocol review, dependency audit, or formal verification. Do not advertise it as “100% private” or “impossible to trace.”

## Production readiness checklist

### Transport and deployment
- [ ] Serve only over HTTPS/WSS; configure TLS and renew certificates.
- [ ] Set `PUBLIC_ORIGIN` to the exact origin; verify proxy and WebSocket upgrade behavior.
- [ ] Keep dependencies patched; run `npm audit` and review transitive dependencies.
- [ ] Use platform-level rate limiting, connection limits, DDoS protection, and resource quotas.
- [ ] Configure provider access logs, retention, error reporting, and backups intentionally; do not log invitation codes, SDP, ICE candidates, or message/file payloads.
- [ ] Avoid third-party scripts, analytics, external fonts/CDNs, trackers, and service workers unless reviewed.
- [ ] Publish reproducible builds and consider independent source/build verification.

### Protocol and identity
- [ ] Have an independent security expert review the design and implementation.
- [ ] Replace the prototype manual verification with a reviewed authenticated key exchange or use a vetted E2EE protocol implementation.
- [ ] Add clear identity/fingerprint verification UX, downgrade protection, and tests for malicious signaling.
- [ ] Test concurrent invitation claims, expiry races, disconnect cleanup, session replays, and malformed signaling.
- [ ] Add reconnect/ICE restart logic only with a reviewed state machine.

### Client and data lifecycle
- [ ] Test clear-on-end on all supported browsers and devices.
- [ ] Add tests for blob URL revocation, pending transfers, large payloads, malformed chunks, duplicate chunks, and memory exhaustion.
- [ ] Implement transfer cancellation, robust backpressure, integrity hashes, and user confirmation before downloading/opening files.
- [ ] Document that recipients can keep copies and screenshots cannot be reliably blocked.
- [ ] Do not store message content in localStorage, IndexedDB, cookies, service workers, analytics, or crash reports.

### Threat model
- [ ] Decide whether peer IP exposure is acceptable; direct WebRTC may reveal it. A TURN-only policy changes this but adds a relay provider that sees connection metadata.
- [ ] Decide how to handle abuse, malicious file sharing, invitation leakage, and compromised devices.
- [ ] Perform a threat model with the actual deployment provider and domain/DNS setup.

## Theme and interaction
- Pure-black canvas, ambient blurred orbs, frosted glass panels, subtle emerald glow, responsive chat composer, reduced-motion support.
- Code-entry choreography inspired by the supplied HTML: four tiles form a square, a glowing outline traces the loop, then the lock panel appears.
- Animated connection success, message entry, file-transfer progress, and session-destruction screen.


## Security hardening branch (October 2026)

This branch adds resource-abuse limits and an explicit manual identity-verification gate while preserving the current text, file-sharing, UI, and session lifecycle code. Production requires `NODE_ENV=production` with an exact HTTPS `PUBLIC_ORIGIN`. The server still cannot guarantee authenticated peer identity against a malicious signaling server: the manual verification code must be compared over a separate trusted channel. Reverse-proxy IP handling, external DDoS protection, dependency auditing, integration tests, and an independent protocol review remain release requirements. This change has not been merged or deployed.
