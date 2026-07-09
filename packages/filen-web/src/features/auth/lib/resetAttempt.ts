import type { StringifiedClient } from "@filen/sdk-rs"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import { log } from "@/lib/log"

export interface ResetParams {
	token: string
	email: string
	newPassword: string
	masterKeysFileText?: string
}

// Injected collaborators so the attempt is unit-testable without a worker — mirrors runLoginAttempt's
// shape (see loginAttempt.ts), simplified: completePasswordReset has no two-factor retry and nothing
// analogous to a dismissible mid-flight dialog to cancel against, so there is no generation counter.
export interface ResetAttemptDeps {
	completeReset: (params: ResetParams) => Promise<StringifiedClient>
	persist: (blob: StringifiedClient) => Promise<void>
	broadcast: () => void
}

export type ResetAttemptOutcome =
	// `persisted: false` = the reset succeeded (and auto-logged the user in) but the session could not
	// be saved on this device — resume-after-close is lost, the in-tab session is still fully functional.
	| { status: "success"; persisted: boolean }
	// Any failure — an expired/invalid token, a rejected master-keys file (BadRecoveryKey), or a
	// transport error. The caller surfaces the DTO's label.
	| { status: "error"; dto: ErrorDTO }

// One password-reset completion attempt, with or without an imported master-keys file (the caller
// simply omits `masterKeysFileText` when there is none — the rename to the SDK's own `recoverKey`
// param name happens at the single worker call site, never here).
export async function runResetAttempt(deps: ResetAttemptDeps, params: ResetParams): Promise<ResetAttemptOutcome> {
	let blob: StringifiedClient
	try {
		blob = await deps.completeReset(params)
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}
	// Persist is deliberately isolated from the reset result: the worker IS authenticated here
	// (completePasswordReset auto-logs-in, matching login), so a failed local save must not masquerade
	// as a failed reset — losing resume-after-close beats losing the completed reset.
	let persisted = true
	try {
		await deps.persist(blob)
	} catch (e) {
		persisted = false
		log.warn("reset", "session persist failed", asErrorDTO(e))
	}
	if (persisted) {
		// Only a durably persisted session is announced — other tabs react by reading it from kv, and
		// an unpersisted one would leave them nothing to adopt.
		deps.broadcast()
	}
	return { status: "success", persisted }
}
