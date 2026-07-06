import "@/polyfills"
import "@/lib/i18n" // side-effect: initialize i18next before any component calls useTranslation

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { createRouter, RouterProvider } from "@tanstack/react-router"

import "@/index.css"
import { routeTree } from "@/routeTree.gen"

const router = createRouter({ routeTree })

// Type-level router registration — makes `Link`/`redirect`/`navigate` paths across the app fully typed
// against this route tree.
declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router
	}
}

const rootElement = document.getElementById("root")

if (!rootElement) {
	throw new Error("Root element not found")
}

createRoot(rootElement).render(
	<StrictMode>
		<RouterProvider router={router} />
	</StrictMode>
)
