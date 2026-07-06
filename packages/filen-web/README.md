# @filen/web

The Filen web app — a from-scratch rewrite of Filen's end-to-end encrypted Cloud Drive, Notes and Chats client for the browser. All cryptography, networking and transfers run through the Rust SDK (`@filen/sdk-rs`) inside a cross-origin-isolated worker; this package is the UI, routing and boot shell around it.

## Requirements

| Tool | Version |
| ---- | ------- |
| Node | >= 24   |
| npm  | >= 11   |

## Commands

| Command             | Description                                            |
| ------------------- | ------------------------------------------------------ |
| `npm run dev`       | Start the Vite dev server                              |
| `npm run build`     | Type-check, build the app, then build the service worker |
| `npm run preview`   | Serve the production build locally                     |
| `npm run test`      | Run the unit tests (Vitest)                            |
| `npm run test:e2e`  | Run the end-to-end tests (Playwright)                  |
| `npm run lint`      | ESLint plus a Prettier format check                    |
| `npm run typecheck` | Type-check without emitting                            |
| `npm run format`    | Format the source with Prettier                        |
