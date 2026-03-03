# pico.chat Frontend

Frontend for **pico.chat** (Vite + TypeScript), focused on realtime text + video rooms with a soft aesthetic UI.

## About

This is a **vibe-coded app** frontend: fast iteration, modern visuals, and live collaboration flow.

## Features

- Landing page with hero, features, testimonials, FAQ
- Signup / Login / Logout flow
- Dashboard for text/video room creation and joining
- Duo and group room modes
- Realtime text chat with emoji reactions
- WebRTC video calling with Socket.IO signaling
- Per-tile mic/camera status and live voice meter bars

## Tech Stack

- Vite
- TypeScript
- Socket.IO Client
- GSAP
- Native WebRTC APIs

## Project Location

Frontend root is:

- `antigravity-scroll`

## Scripts

Run from `antigravity-scroll`:

```bash
npm install
npm run dev
npm run build
npm run preview
```

## Environment Variables

Use `antigravity-scroll/.env`:

- `VITE_API_URL=http://localhost:3001`
- `VITE_SOCKET_URL=http://localhost:3001`

Backend/API config lives in server docs:

- `antigravity-scroll/server/README.md`

## Local Development Flow

1. Start backend:

```bash
npm run server
```

2. Start frontend (new terminal):

```bash
npm run dev
```

3. Open:

- `http://localhost:5173`

## Deploy Notes

- Deploy frontend on Vercel.
- Deploy backend on Render/Railway.
- Set frontend envs (`VITE_API_URL`, `VITE_SOCKET_URL`) to backend URL.
- Configure backend `CORS_ORIGIN` to frontend domain.

## Security Note

Do not store secrets (Mongo/Redis/JWT credentials) in README files.
Put them only in `.env` and keep `.env` out of git.
