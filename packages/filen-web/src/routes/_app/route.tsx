import { createFileRoute, redirect } from "@tanstack/react-router"
import { sdkApi } from "@/lib/sdk/client"
import { whenBootReady } from "@/lib/sdk/boot"
import { AppShell } from "@/features/shell/components/appShell"

// Authed layout: everything under it (Drive today; the other modules later) requires a session — the
// worker holding a Client (`hasClient()`) — and bounces to sign-in otherwise. `_app` is a pathless
// layout, so its children keep clean URLs (e.g. /drive).
export const Route = createFileRoute("/_app")({
	beforeLoad: async () => {
		// Await boot (incl. session resume) before reading hasClient(): during the router's initial
		// load the worker may still be booting, and reading too early would bounce an authed reload.
		await whenBootReady()
		const authed = await sdkApi.hasClient().catch(() => false)
		if (!authed) {
			throw redirect({ to: "/login" })
		}
	},
	component: AppShell
})
