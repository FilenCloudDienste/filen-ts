import { createFileRoute, redirect } from "@tanstack/react-router"
import { sdkApi } from "@/lib/sdk/client"
import { whenBootReady } from "@/lib/sdk/boot"

// The index has no UI of its own — it forwards to the app when a session is present, else to sign-in.
// Session presence is the worker's `hasClient()` (a plain boolean check on the held Client). Any
// failure defaults to sign-in. This runs behind the root boot gate, so a slow/failed worker surfaces
// as the boot screen/error, never as a stuck redirect.
export const Route = createFileRoute("/")({
	beforeLoad: async () => {
		// Await boot (incl. session resume) so hasClient() reflects a resumed session, not a mid-boot read.
		await whenBootReady()
		const authed = await sdkApi.hasClient().catch(() => false)
		throw redirect({ to: authed ? "/drive" : "/login" })
	}
})
