import { redirect } from "@tanstack/react-router"
import { sdkApi } from "@/lib/sdk/client"
import { whenBootReady } from "@/lib/sdk/boot"

// Shared `beforeLoad` for unauthed-only pages (/login, /register): a live session bounces straight
// to Drive. Awaits boot — which includes session resume — before reading hasClient(); reading
// earlier would see `false` mid-boot. Inverse of the `_app` layout's protect-guard, which stays
// inline in its route (different condition, different target).
export async function redirectIfAuthed(): Promise<void> {
	await whenBootReady()
	const authed = await sdkApi.hasClient().catch(() => false)
	if (authed) {
		throw redirect({ to: "/drive/$", params: { _splat: "" } })
	}
}
