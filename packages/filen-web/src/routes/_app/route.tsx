import { createFileRoute, redirect } from "@tanstack/react-router"
import { isSignedIn } from "@/features/auth/lib/guard"
import { AppShell } from "@/features/shell/components/appShell"

// Authed layout: everything under it (Drive today; the other modules later) requires a session — the
// worker holding a Client (`hasClient()`) — and bounces to sign-in otherwise. `_app` is a pathless
// layout, so its children keep clean URLs (e.g. /drive).
export const Route = createFileRoute("/_app")({
	beforeLoad: async () => {
		if (!(await isSignedIn())) {
			throw redirect({ to: "/login" })
		}
	},
	component: AppShell
})
