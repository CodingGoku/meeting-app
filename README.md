# MeetStream Pro

Use a supported Node.js LTS release, version 22 or newer. Run `npm ci`, then `npm test` and `npm start`. Open `http://localhost:3000` for local development.

## Deployment and verification

- Serve the app over HTTPS and forward WebSocket upgrades on both `/` and `/media`.
- Use `/health` for readiness checks. The server returns HTTP 503 while draining. `/stats` reports aggregate activity with room codes and participant details omitted.
- Run one signaling instance per deployment. Room membership and reconnect state live in memory. Multiple instances need shared room routing, and larger meetings benefit from a dedicated media server.
- Before releasing, join the deployed app from two separate networks. Check microphone, camera and screen sharing, then briefly interrupt a connection and confirm the call recovers. Use **Meeting settings → Connection diagnostics** to inspect the active transport and copy a report with participant names and room codes omitted.

## TURN relay

WebRTC connects directly when the network permits it. MeetStream uses the shared [Open Relay static-auth service](https://www.metered.ca/tools/openrelay/#-static-auth) when no TURN settings are provided. Configure a dedicated relay for production calls on networks that block direct connections, such as some corporate networks, VPNs, and mobile carriers.

- Set `TURN_URLS` to comma-separated relay URLs. For example, use `turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:443?transport=tcp` if your relay listens on those ports.
- For coturn with `use-auth-secret` enabled, set `TURN_SECRET` to the relay's `static-auth-secret`. MeetStream creates temporary credentials valid for six hours and sends them to each participant when they join.
- For a managed relay, set `TURN_USERNAME` and `TURN_CREDENTIAL` to its client ICE credentials. If you also set `TURN_SECRET`, MeetStream uses temporary credentials instead.

Set these values as environment variables on the meeting server. Keep the TURN shared secret on the server. Browsers receive only the TURN URLs and client credentials they need to connect.

## Server media fallback

If a supported pair can't establish WebRTC or expected video stalls, MeetStream switches to **Server relay** while continuing to try WebRTC in the background. It returns to WebRTC once incoming media is ready. The server forwards relay media without saving it.

When both browsers support VP8 through WebCodecs, relay video uses low-latency encoding with adaptive bitrate and resolution. Screen sharing can reach 1920×1080 on this path. Other browsers use the JPEG relay path, with screen sharing up to 1440 pixels on its longest side.

Public deployments should use HTTPS and forward WebSocket upgrades on both `/` and `/media`. MeetStream prefers the separate `/media` connection for relay video and can use the signaling socket when that route is unavailable. Signaling reconnects within 15 seconds preserve the participant's membership and existing media connections.
