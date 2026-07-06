import { createFileRoute, redirect } from "@tanstack/react-router"
import { sdkApi } from "@/lib/sdk/client"
import { AppShell } from "@/components/shell/app-shell"

// Authed layout: everything under it (Drive today; the other modules later) requires a session. The
// guard mirrors the index redirect — a session is the worker holding a Client (`hasClient()`) — and
// bounces to sign-in otherwise. Real auth arrives later; this is the enforcement point it slots
// into. `_app` is a pathless layout, so its children keep clean URLs (e.g. /drive).
export const Route = createFileRoute("/_app")({
	beforeLoad: async () => {
		const authed = await sdkApi.hasClient().catch(() => false)
		if (!authed) {
			throw redirect({ to: "/login" })
		}
	},
	component: AppShell
})
