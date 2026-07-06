import "@/polyfills"
import "@/lib/i18n" // side-effect: initialize i18next before any component calls useTranslation

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { createRouter, RouterProvider } from "@tanstack/react-router"

import "@/index.css"
import { routeTree } from "@/routeTree.gen"
import { bootSdk } from "@/lib/sdk/boot"

const router = createRouter({ routeTree })

// Kick the SDK boot as a module-level side effect, BEFORE <RouterProvider> mounts, so the boot-ready
// gate (whenBootReady) is already in flight when the router runs its initial route guards. It must
// NOT live inside a render effect: a guard awaiting boot while boot awaited first paint would
// deadlock. Not awaited — BootGate observes the zustand boot phases and holds the boot screen until
// ready. Runs exactly once (module code is not double-invoked, unlike StrictMode effects).
void bootSdk()

// Type-level router registration — makes `Link`/`redirect`/`navigate` paths across the app fully typed
// against this route tree.
declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router
	}
}

// E2E-only test hooks. The dynamic import behind this env condition is dead-code-eliminated from a
// normal build (asserted by the no-flag build grep), so nothing test-related ships to production.
if (import.meta.env.VITE_E2E === "1") {
	void import("@/e2e-hooks").then(m => {
		m.installE2eHooks(router)
	})
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
