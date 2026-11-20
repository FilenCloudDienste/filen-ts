import { redirect, type UseNavigateResult } from "@tanstack/react-router"
import { sdkApi } from "@/lib/sdk/client"
import { whenBootReady } from "@/lib/sdk/boot"
import { takeSignInTarget } from "@/features/settings/lib/pendingPlans"

// Session presence for route guards. Awaits boot (which includes session resume) before reading
// hasClient(): reading earlier would see `false` mid-boot and bounce an authed reload. Any failure
// reads as signed out.
export async function isSignedIn(): Promise<boolean> {
	await whenBootReady()
	return sdkApi.hasClient().catch(() => false)
}

// Shared `beforeLoad` for unauthed-only pages (/login, /register): a live session bounces straight
// to the page a signed-out visit asked for, else the configured start screen ("/" resolves it). Inverse of the `_app` layout's protect-guard,
// which stays inline in its route (different condition, different target).
export async function redirectIfAuthed(): Promise<void> {
	if (await isSignedIn()) {
		const target = takeSignInTarget()

		switch (target?.kind) {
			case "plans":
				throw target.target.plan === undefined
					? redirect({ to: "/settings/plans" })
					: redirect({ to: "/settings/plans/$plan", params: { plan: String(target.target.plan) } })
			case "path":
				throw redirect({ href: target.href })
			default:
				throw redirect({ to: "/" })
		}
	}
}

// Where a sign-in made on a form (sign-in, password reset) goes: the plans or the page a signed-out visit asked for,
// else the configured start screen ("/" resolves it). Taking the target here clears it, so it never waits for a later
// sign-in in this tab.
export async function navigateAfterSignIn(navigate: UseNavigateResult<string>): Promise<void> {
	const target = takeSignInTarget()

	switch (target?.kind) {
		case "plans":
			await (target.target.plan === undefined
				? navigate({ to: "/settings/plans" })
				: navigate({ to: "/settings/plans/$plan", params: { plan: String(target.target.plan) } }))
			break
		case "path":
			await navigate({ href: target.href })
			break
		default:
			await navigate({ to: "/" })
	}
}
