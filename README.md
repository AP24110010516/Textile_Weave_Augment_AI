# WeaveAugment AI

A textile image workspace with a React + Vite frontend and an Express backend. The existing Stability AI SDXL image-to-image augmentation remains available, alongside a local dataset organizer and clearly marked model-dependent workspaces.

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
   npm run models:download --workspace=weaveaugment-ai-backend
   npm run dev:backend
   ```

   This downloads the pinned local ONNX weights into the ignored `backend/models/` directory (about 130 MB total). Model files are not committed. The Render build downloads the same pinned models automatically.

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

The backend serves the built frontend and the API from the same origin. Configure the hosting platform to route its public domain to this Node.js process and provide `STABILITY_API_KEY`, a persistent `DATABASE_PATH`, and, if needed, `PORT` as environment variables. The default Render free service has an ephemeral filesystem; use a host with persistent storage or attach a persistent disk before relying on account persistence across restarts. API requests use `/api`, including `GET /api/status`, `POST /api/stable-diffusion/augment`, `POST /api/defects/detect`, `POST /api/defects/remove`, and the account endpoints under `/api/auth`.

The backend deployment target and public domain depend on the hosting platform; this project does not define or claim a hosted URL.

## Notes

- The frontend sends uploaded textile images to `POST /api/stable-diffusion/augment`. Defect creation and color variation use this existing SDXL image-to-image integration. The selected fabric type (cotton, silk, denim, wool, or polyester) is passed to the backend and reinforced in the generation prompt. The Color Variation Generator asks SDXL to choose natural fabric color variations. The requested output count (1–50) is sent to the backend. SDXL availability depends on `STABILITY_API_KEY`.
- The backend sends the request to the Stability AI SDXL image-to-image API and returns generated images as data URLs.
- Authentication uses SQLite, scrypt password hashes, and opaque server-side sessions in HttpOnly, SameSite cookies. Password reset is not available because no email-delivery integration is configured.
- The dataset builder labels images in the browser and exports ZIP/CSV files. It identifies exact duplicates only; similar-image matching is not implemented.
- Defect detection runs the MIT-licensed `hazemaaa/fabric-defect-detection` YOLO11 ONNX checkpoint locally with ONNX Runtime. It predicts 20 classes and bounding boxes from the Alibaba Tianchi Guangdong cloth-flaw dataset; its published benchmark and taxonomy are specific to that dataset, so accuracy is not guaranteed for other fabrics. Uploaded images are aspect-preserving letterboxed to the model's 2446×1000 input geometry, and boxes are mapped back to the uploaded image.
- Defect removal uses the Apache-2.0 OpenCV `opencv/inpainting_lama` ONNX checkpoint locally. Selected detector boxes are expanded into masks and inpainted with LaMa; output outside the feathered mask is preserved from the original upload. Review corrected images, especially for defects larger than the model's 512×512 inpainting context.
- Both ONNX models run on CPU through `onnxruntime-node`; `sharp` handles image decoding, resizing, and encoding. Inference is serialized per backend process, so multiple image views and large uploads can take noticeable time on CPU. If weights are absent, the endpoints return a setup error instead of fabricated detections or images. Run `npm run models:download --workspace=weaveaugment-ai-backend` to install the pinned checkpoints.
- The `/` landing page uses the supplied `frontend/public/landing-background.png` image and remains unchanged. Other routes use a subtle animated textile background in light and dark themes; reduced-motion preferences are respected. `/how-it-works` is a separate page.
- Explore Tools sends signed-out visitors to login and, after authentication, opens `/tools`, the protected Tools Selection page. Tool workspaces remain available from Explore Tools and Dashboard quick access, but their links are omitted from the sidebar. The sidebar brand opens Dashboard, which closes the sidebar; its navigation toggle reopens it.
- The authenticated application uses a navy, white, and muted-purple palette with a collapsible sidebar, responsive mobile navigation, and a light/dark theme preference that applies across routes.
- The theme preference is stored in browser local storage and applies across routes.
- Generation history, saved result images, and dataset-export records are held in browser memory for the current app session; they reset on refresh and are not saved to user accounts. Dataset exports are downloaded locally and are not retained by the application.
