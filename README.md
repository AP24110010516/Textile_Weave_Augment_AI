# WeaveAugment AI

A textile image workspace with a React + Vite frontend and an Express backend. The available workflows are dataset preparation and Stability AI SDXL image generation for color variation and synthetic textile defect creation.

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

   The backend requires Node.js 22.13 or later for its built-in SQLite account database. Accounts and sessions are stored in the ignored `backend/data/` directory; set `DATABASE_PATH` to choose another persistent location in production.

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

The backend serves the built frontend and the API from the same origin. Configure the hosting platform to route its public domain to this Node.js process and provide `STABILITY_API_KEY`, a persistent `DATABASE_PATH`, and, if needed, `PORT` as environment variables. The default Render free service has an ephemeral filesystem; use a host with persistent storage or attach a persistent disk before relying on account persistence across restarts. API requests use `/api`, including `GET /api/status`, `POST /api/stable-diffusion/augment`, and the account endpoints under `/api/auth`.

The backend deployment target and public domain depend on the hosting platform; this project does not define or claim a hosted URL.

## Notes

- The frontend sends uploaded textile images to `POST /api/stable-diffusion/augment`. Dataset Builder, defect creation, and color variation use the existing Stability AI SDXL image-to-image integration. Dataset Builder sends the selected fabric, defect, strength (0.25–0.35, default 0.30), and requested variation count (1–50) to the backend. Its strength is calibrated to SDXL's 0.70–0.80 image-strength range, and its prompt asks for local variations of the selected existing defect. The Color Variation Generator asks SDXL to choose natural fabric color variations. SDXL availability depends on `STABILITY_API_KEY`.
- The backend sends the request to the Stability AI SDXL image-to-image API and returns generated images and the resolved prompts as data URLs and metadata.
- Authentication uses SQLite, scrypt password hashes, and opaque server-side sessions in HttpOnly, SameSite cookies. Password reset is not available because no email-delivery integration is configured.
- Dataset Builder uses the uploaded image as SDXL input. Saving a generated dataset, including when downloading its ZIP, stores the generated PNGs and generation metadata in the browser's IndexedDB Dataset Library. Dataset Library entries persist across refreshes in that browser, but are not synced to the server or other devices and can be removed by clearing browser site data.
- The backend uses `sharp` to validate and process generated images. It does not run separate local inference models.
- The `/` landing page uses the supplied `frontend/public/landing-background.png` image in both themes. Other routes use a subtle animated textile background in light and dark themes; reduced-motion preferences are respected. `/how-it-works` is a separate page.
- Successful login opens the protected Dashboard. Explore Tools sends signed-out visitors to login and authenticated visitors to `/tools`, the protected Tools Selection page. The sidebar has separate Workspace and Tools sections; Tools Selection is directly under Tools.
- The authenticated application uses a navy, white, and muted-purple palette with a collapsible sidebar, responsive mobile navigation, and a light/dark theme preference that applies across routes.
- The theme preference is stored in browser local storage and applies across routes.
- Generation history and individually saved result images are held in browser memory for the current app session; they reset on refresh and are not saved to user accounts. Dataset Library entries are stored separately in browser IndexedDB.
