# MeetStream Pro

Install dependencies with `npm install` and run `npm start`. Open `http://localhost:3000` for local development. Serve public deployments over HTTPS so browsers can grant device access, and forward same-host WebSocket upgrades to the meeting server for signaling.

## TURN relay

WebRTC connects directly when the network permits it. MeetStream uses the shared [Open Relay static-auth service](https://www.metered.ca/tools/openrelay/#-static-auth) when no TURN settings are provided. Configure a dedicated relay for production calls on networks that block direct connections, such as some corporate networks, VPNs, and mobile carriers.

- Set `TURN_URLS` to comma-separated relay URLs. For example, use `turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:443?transport=tcp` if your relay listens on those ports.
- For coturn with `use-auth-secret` enabled, set `TURN_SECRET` to the relay's `static-auth-secret`. MeetStream creates temporary credentials valid for six hours and sends them to each participant when they join.
- For a managed relay, set `TURN_USERNAME` and `TURN_CREDENTIAL` to its client ICE credentials. If you also set `TURN_SECRET`, MeetStream uses temporary credentials instead.

Set these values as environment variables on the meeting server. Keep the TURN shared secret on the server. Browsers receive only the TURN URLs and client credentials they need to connect.
