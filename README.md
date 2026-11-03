# RENDERFLOW AI

A minimalist bilingual architectural image studio for turning SketchUp screenshots into photorealistic visualizations.

## Current status

This first frontend release includes:
- Responsive minimalist studio interface
- Light and dark themes (saved in browser)
- English and Khmer interface switching
- SketchUp image upload, preview, drag-and-drop and file validation
- Architectural style presets, view type, lighting and output-quality controls
- Geometry-preservation preference and custom prompt field
- Gallery and history placeholder pages

## AI rendering status

The frontend is ready for an AI service integration, but **live image generation is not connected yet**. The Generate button intentionally reports this instead of pretending to render. A secure backend endpoint and provider credentials/usage limits must be configured before public AI generation can work.

## Deploy to Cloudflare Pages

1. In Cloudflare Dashboard, open **Workers & Pages**.
2. Choose **Create application** → **Pages** → **Connect to Git**.
3. Connect GitHub and select `Watt05/renderflow-ai`.
4. Framework preset: **None**.
5. Build command: leave blank.
6. Build output directory: `/` (repository root).
7. Deploy.

Cloudflare will provide a public `*.pages.dev` address. Every push to `main` will trigger a new deployment.

## Important before public AI launch

Do not place provider API keys in frontend JavaScript. Add them as encrypted secrets in the server-side Worker environment. Configure authentication, rate limits, image size limits, abuse controls and a clear usage quota before opening generation to everyone.