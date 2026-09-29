import type { StringifiedClient } from "@filen/sdk-rs"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import { persistSessionBlob } from "@/lib/sdk/persistOutcome"
import { log } from "@/lib/log"

export interface ChangeEmailParams {
	password: string
	newEmail: string
}

// Injected collaborators, same shape as runChangePasswordAttempt (changePassword.logic.ts) — this
// attempt mirrors that one's post-success handling exactly, adapted for one API-shape difference:
// wasm's `changeEmail(password, new_email)` returns `Promise<void>`, not a re-derived
// `StringifiedClient` the way `changePassword` does. `toStringified` (already wired on the worker
// for exactly this "re-read whatever client is currently live" purpose) stands in for that missing
// return value, so both share the same persistSessionBlob law.
export interface ChangeEmailAttemptDeps {
	changeEmail: (params: ChangeEmailParams) => Promise<void>
	toStringified: () => Promise<StringifiedClient>
	persist: (blob: StringifiedClient) => Promise<void>
	clearSession: () => Promise<void>
}

export type ChangeEmailAttemptOutcome =
	// `persisted: false` = the email WAS changed server-side but the re-read session could not be
	// saved on this device (or could not even be re-read) — the stale pre-change blob is cleared
	// too, so resume-after-close lands unauthed rather than reviving a blob whose recorded email no
	// longer matches the account's real one. The in-tab session is still fully functional.
	{ status: "success"; persisted: boolean } | { status: "error"; dto: ErrorDTO }

export async function runChangeEmailAttempt(deps: ChangeEmailAttemptDeps, params: ChangeEmailParams): Promise<ChangeEmailAttemptOutcome> {
	try {
		await deps.changeEmail(params)
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	// The mutation already SUCCEEDED server-side by this point — every failure from here on is
	// "succeeded but not saved locally", surfaced as `persisted: false`, never a hard error.
	let blob: StringifiedClient | null = null
	try {
		blob = await deps.toStringified()
	} catch (e) {
		log.warn("settings", "change-email post-mutation toStringified failed", asErrorDTO(e))
	}

	// On failure the pre-change blob, which records the dead old email, is cleared so the next resume
	// starts clean instead of reviving a stale identity.
	const persisted = await persistSessionBlob(deps, blob, "settings", "change-email session")

	return { status: "success", persisted }
}
