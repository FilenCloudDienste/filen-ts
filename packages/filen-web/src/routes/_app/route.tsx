import { createFileRoute, redirect } from "@tanstack/react-router"
import { isSignedIn } from "@/features/auth/lib/guard"
import { AppShell } from "@/features/shell/components/appShell"
import { validatePlansSearch } from "@/features/settings/lib/billingLinks"
import { rememberPlansTarget } from "@/features/settings/lib/pendingPlans"

// Authed layout: everything under it (Drive today; the other modules later) requires a session — the
// worker holding a Client (`hasClient()`) — and bounces to sign-in otherwise. `_app` is a pathless
// layout, so its children keep clean URLs (e.g. /drive).
export const Route = createFileRoute("/_app")({
	beforeLoad: async ({ location }) => {
		if (!(await isSignedIn())) {
			// A plans link (the desktop app's billing link, say) survives the sign-in it needs.
			if (location.pathname === "/settings/plans") {
				rememberPlansTarget(validatePlansSearch(location.search).plan)
			}

			throw redirect({ to: "/login" })
		}
	},
	component: AppShell
})
