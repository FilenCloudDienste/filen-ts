import type { StringifiedClient } from "@filen/sdk-rs"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import { log } from "@/lib/log"

export interface ChangePasswordParams {
	currentPassword: string
	newPassword: string
}

// Injected collaborators so the attempt is unit-testable without a worker — same shape as
// runLoginAttempt/runResetAttempt (see login-attempt.ts/reset-attempt.ts): change-password has no
// two-factor retry and nothing analogous to a dismissible mid-flight dialog to cancel against, so
// there is no generation counter either.
export interface ChangePasswordAttemptDeps {
	changePassword: (params: ChangePasswordParams) => Promise<StringifiedClient>
	persist: (blob: StringifiedClient) => Promise<void>
}

export type ChangePasswordAttemptOutcome =
	// `persisted: false` = the password WAS changed (the worker's live client already re-derived its
	// keys) but the new session could not be saved on this device — resume-after-close would land on
	// dead, pre-change credentials; the in-tab session is still fully functional.
	| { status: "success"; persisted: boolean }
	// Any failure from the SDK call itself (wrong current password, network, …). `persist` is never
	// reached in this branch — there is nothing new to persist.
	| { status: "error"; dto: ErrorDTO }

// One change-password attempt. `changePassword` mutates the WORKER'S LIVE client in place (it
// re-derives keys from the new password) and returns the client re-stringified AFTER that
// mutation — persisting that blob immediately is not an optimization, it is the fingerprint
// re-sync the mutation requires: the pre-change blob already on disk authenticates with the OLD
// password, so leaving it persisted would resurrect dead credentials on the very next resume. The
// underlying principle — a credential-mutating call changes live client state without changing
// object identity, so any "did the session change" cache must be updated in lockstep — carries
// over regardless of runtime (native client handles or wasm ones alike); persist therefore runs
// unconditionally, before the caller does anything else with the result (including refetching the
// account query).
export async function runChangePasswordAttempt(
	deps: ChangePasswordAttemptDeps,
	params: ChangePasswordParams
): Promise<ChangePasswordAttemptOutcome> {
	let blob: StringifiedClient
	try {
		blob = await deps.changePassword(params)
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}
	// Isolated from the result on purpose: the SDK call already SUCCEEDED (the account's password is
	// already changed server-side) by the time this runs, so a local save failure must not read as a
	// failed change — the same "succeeded but not saved" category login/reset already surface via
	// `persisted: false` rather than a hard error.
	let persisted = true
	try {
		await deps.persist(blob)
	} catch (e) {
		persisted = false
		log.warn("security", "change-password session persist failed", asErrorDTO(e))
	}
	return { status: "success", persisted }
}
