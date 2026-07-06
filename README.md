---
title: Pediatric Cardiology Quiz Board
emoji: 🫀
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
short_description: Pediatric cardiology quiz board with Socket.IO multiplayer
tags:
  - education
  - cardiology
  - quiz
  - multiplayer
---

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

The simplest free option for the current architecture is Render Free:

1. Push this repo to GitHub.
2. In Render, create a new Blueprint or Web Service from the repo.
3. Use `render.yaml`, or set:
   - Build command: `npm ci && npm run build`
   - Start command: `npm start`
4. After Render deploys, open the Render URL and create a room.
5. In Cloudflare DNS for `stevetodman.com`, add a CNAME such as:
   - Name: `cardiojeopardy`
   - Target: the Render hostname
   - Proxy: DNS only until Render verifies the custom domain
6. Add `cardiojeopardy.stevetodman.com` as a custom domain in Render, then switch the
   Cloudflare proxy back on if desired.

Render Free can spin down when idle, so the first load before a session may take
about a minute. Keep the host page open during play so the WebSocket traffic
keeps the service awake.

Hugging Face Spaces is another free host that fits this app because it supports
Docker Spaces and custom domains:

1. Create a new Space and choose `Docker`.
2. Push this repo with the root `Dockerfile` and the README frontmatter above.
3. The container listens on port `7860`, which matches the Space config.
4. In Hugging Face Space settings, add a custom domain and point a CNAME at the
   `*.hf.space` hostname that Hugging Face assigns to the Space.

HF custom domains require PRO. For a fully free custom domain, this repo includes
a Cloudflare Worker proxy in `cloudflare/cardiojeopardy-proxy.ts` with
`wrangler.jsonc`, routing `cardiojeopardy.stevetodman.com/*` to the running
Hugging Face Space.

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
