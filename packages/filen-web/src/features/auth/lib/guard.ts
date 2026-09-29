import { redirect } from "@tanstack/react-router"
import { sdkApi } from "@/lib/sdk/client"
import { whenBootReady } from "@/lib/sdk/boot"

// Session presence for route guards. Awaits boot (which includes session resume) before reading
// hasClient(): reading earlier would see `false` mid-boot and bounce an authed reload. Any failure
// reads as signed out.
export async function isSignedIn(): Promise<boolean> {
	await whenBootReady()
	return sdkApi.hasClient().catch(() => false)
}

// Shared `beforeLoad` for unauthed-only pages (/login, /register): a live session bounces straight
// to Drive. Inverse of the `_app` layout's protect-guard, which stays inline in its route (different
// condition, different target).
export async function redirectIfAuthed(): Promise<void> {
	if (await isSignedIn()) {
		throw redirect({ to: "/drive/$", params: { _splat: "" } })
	}
}
