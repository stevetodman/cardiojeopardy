# Pediatric Cardiology Quiz Board

A local multiplayer pediatric cardiology quiz-board program for personal educational use. The host laptop creates a room, projects the board, and shows a QR/link for iPhone players to join by room code and display name.

The Node server is authoritative for game state, timers, buzz order, scoring, reconnection, and room lifecycle. Browser clients send intents only.

## Run

```bash
npm install
npm run dev
```

Open the printed LAN URL on the host laptop. The root route (`/`) is the projection/host screen. Players join from `/player?room=CODE` or by scanning the QR code shown after room creation.

## Verify

```bash
npm run typecheck
npm test
npm run lint
```

## Free Web Hosting

This app needs a persistent Node process because Socket.IO and the authoritative
room state live on the server. Static-only hosts are not enough for multiplayer
rooms.

The lowest-friction free option for the current architecture is Render Free:

1. Push this repo to GitHub.
2. In Render, create a new Blueprint or Web Service from the repo.
3. Use `render.yaml`, or set:
   - Build command: `npm install && npm run build`
   - Start command: `npm run start`
   - Node version: `22`
4. After Render deploys, open the Render URL and create a room.
5. In Cloudflare DNS for `stevetodman.com`, add a CNAME such as:
   - Name: `cardio`
   - Target: the Render hostname
   - Proxy: DNS only until Render verifies the custom domain
6. Add `cardio.stevetodman.com` as a custom domain in Render, then switch the
   Cloudflare proxy back on if desired.

Render Free can spin down when idle, so the first load before a session may take
about a minute. Keep the host page open during play so the WebSocket traffic
keeps the service awake.

## Structure

- `server`: Socket.IO/Vite development server and room lifecycle.
- `src/shared`: shared TypeScript contracts, FSM states, and socket protocol.
- `src/engine`: pure quiz engine, scoring, timers, answer matching, and content normalization.
- `src/client`: host projection UI, iPhone player UI, socket clients, and wake-lock helper.
- `src/content/clues.json`: 50 board clues plus one Final Round clue.
- `VERIFICATION.md`: source and verification trail for each clue.

## Medical And Asset Caveats

This is an educational prototype, not clinical decision support. The clue set includes citations and verification notes, but all content requires physician review before classroom or clinical teaching use.

The app uses original game-show-style visuals and does not bundle official Jeopardy logos, music, fonts, clips, or copied art.
