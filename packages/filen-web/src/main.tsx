import "@/polyfills"
import { i18n } from "@/lib/i18n" // side-effect: initialize i18next before any component calls useTranslation

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { createRouter, RouterProvider } from "@tanstack/react-router"

import "@/index.css"
import { routeTree } from "@/routeTree.gen"
import { bootSdk, whenBootReady } from "@/lib/sdk/boot"
import { advanceBootSplash, dismissBootSplash } from "@/lib/bootSplash"
import { registerAllActions } from "@/lib/keymap/actions"
import { NotFoundScreen } from "@/features/shell/components/notFoundScreen"
import { useReminderStore } from "@/features/shell/store/useReminderStore"
import { connectFileKindVerdictStorage } from "@/features/drive/lib/fileKindVerdictStorage"
import "@/features/assistant/loop/register" // side-effect: registers the on-device assistant with its UI
import { LANGUAGE_STORAGE_KEY, startLanguage } from "@/lib/i18n/language"
import { prepareLegacyWebStartup } from "@/lib/legacyWebMigration.logic"
import { installSessionEndedCheck } from "@/features/shell/lib/sessionEnded"
import { desktopBridge } from "@/lib/desktop"
import { syncDesktopShellStrings } from "@/lib/i18n/desktopShell"
import { refreshDocumentTitle } from "@/lib/head/refreshTitle"

// notFoundMode "root" (the default is "fuzzy") keeps every unknown URL on ONE full-page 404 instead of
// rendering it inside whichever ancestor layout happened to match, and makes the root match the
// not-found boundary — which is what lets the root route title the page (see __root.tsx). A future
// thrown notFound() therefore also renders at the root; nothing throws one today.
// Accepted: the 404 renders through the root Outlet, which is inside BootGate, so an unknown URL shows
// the boot screen until the SDK is ready. Bypassing that would mean teaching BootGate to read
// router-internal not-found state for a page whose only action is a router Link.
const router = createRouter({ routeTree, defaultNotFoundComponent: NotFoundScreen, notFoundMode: "root" })

// Kick the SDK boot as a module-level side effect, BEFORE <RouterProvider> mounts, so the boot-ready
// gate (whenBootReady) is already in flight when the router runs its initial route guards. It must
// NOT live inside a render effect: a guard awaiting boot while boot awaited first paint would
// deadlock. Not awaited — BootGate observes the zustand boot phases and holds the boot screen until
// ready. Runs exactly once (module code is not double-invoked, unlike StrictMode effects).
// The previous web app's language and signed-in state, read before the splash weights its phases and the language is
// detected. The desktop app never ran it.
if (desktopBridge() === undefined) {
	prepareLegacyWebStartup(LANGUAGE_STORAGE_KEY)
}

// Signs out, with a note on the sign-in screen, once the server stops accepting the session.
installSessionEndedCheck()

advanceBootSplash("bundle")
void bootSdk()

// Fetched alongside the SDK boot; the first render waits for it briefly (English if it is late).
const languageReady = startLanguage()

i18n.on("languageChanged", () => {
	void refreshDocumentTitle(router)
})

// Each first screen dismisses the splash itself; this only stops one that never does (a router error
// page) from staying hidden under it. The bundle is a single chunk, so after boot settles the first screen
// is a render away and the margin is generous.
void whenBootReady().then(() => {
	setTimeout(dismissBootSplash, 10_000)
	// File-kind verdicts the listings' first paint reads (an icon, a tile's video badge).
	connectFileKindVerdictStorage()
})

// Every keyboard action, registered before the first render — the defs are static data, so `comboFor`
// and `<Kbd>` are correct from the very first paint.
registerAllActions()

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
	// Latched HERE rather than inside installE2eHooks, and synchronously: the import below is
	// fire-and-forget, so a latch inside it races the first render of the authed shell. Both startup
	// reminders are modal alertdialogs, and while one stands Base UI's markOthers aria-hides the whole
	// shell — every role-based locator in the suite then matches nothing, several steps from the cause.
	// Suppressing them here rather than dismissing them from the test side also removes a fixed 3s (and
	// up to 15s more) from every authed page load. AccountReminders keeps its own coverage in
	// src/tests/accountReminders.test.ts.
	useReminderStore.setState({ keysDismissed: true, storageDismissed: true })

	void import("@/e2e-hooks")
		.then(m => {
			m.installE2eHooks()
		})
		.catch((error: unknown) => {
			// Nothing retries this import, so a failed chunk fetch leaves window.__filenE2E absent for
			// the life of the page and every hook-driven spec fails on a missing global. Say so once.
			console.error("[e2e] hook install failed — window.__filenE2E will never appear", error)
		})
}

const rootElement = document.getElementById("root")

if (!rootElement) {
	throw new Error("Root element not found")
}

void languageReady.then(() => {
	// After the language settles, so the desktop shell is not relabelled in English first.
	syncDesktopShellStrings()
	createRoot(rootElement).render(
		<StrictMode>
			<RouterProvider router={router} />
		</StrictMode>
	)
})
