# WeaveAugment AI

A Stable Diffusion XL textile image augmentation app with a React + Vite frontend and an Express backend.

## Project structure

```text
WeaveAugment-AI/
├── backend/
├── frontend/
├── .gitignore
├── README.md
├── package.json
└── package-lock.json
```

The root npm workspace configuration and lockfile manage both applications. Frontend and backend package manifests contain only their respective dependencies.

## Setup and local development

1. Install dependencies from the project root:
   ```bash
   npm install
   ```

2. Add your Stability AI key to `backend/.env`:
   ```env
   STABILITY_API_KEY=your_key_here
   PORT=3001
   ```

3. Start the backend in one terminal:
   ```bash
   npm run dev:backend
   ```

4. Start the frontend in another terminal:
   ```bash
   npm run dev:frontend
   ```

Open the frontend Local URL printed by Vite. Vite binds to loopback only and proxies `/api` requests to the backend.

## Production

Build the frontend and start the backend from the project root:

```bash
npm run build
npm start
```

The backend serves the built frontend and the API from the same origin. Configure the hosting platform to route its public domain to this Node.js process and provide `STABILITY_API_KEY` and, if needed, `PORT` as environment variables. API requests use `/api`, including `POST /api/stable-diffusion/augment`.

The backend deployment target and public domain depend on the hosting platform; this project does not define or claim a hosted URL.

## Notes

- Traditional augmentation controls were removed in favor of the SDXL-only workflow.
- The frontend sends uploaded textile images to `POST /api/stable-diffusion/augment`.
- The backend sends the request to the Stability AI SDXL image-to-image API and returns generated images as data URLs.
