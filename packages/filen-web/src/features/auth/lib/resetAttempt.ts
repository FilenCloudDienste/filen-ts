import type { StringifiedClient } from "@filen/sdk-rs"
import { readTwoFactorKind } from "@/features/auth/lib/twoFactorKinds"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import { log } from "@/lib/log"

export interface ResetParams {
	token: string
	email: string
	newPassword: string
	masterKeysFileText?: string
}

// Injected collaborators so the attempt is unit-testable without a worker — mirrors runLoginAttempt's
// shape (see loginAttempt.ts), simplified: nothing here can be retried (see the two-factor-terminal
// arm) and there is no dismissible mid-flight dialog to cancel against, so there is no generation
// counter.
export interface ResetAttemptDeps {
	completeReset: (params: ResetParams) => Promise<StringifiedClient>
	persist: (blob: StringifiedClient) => Promise<void>
	broadcast: () => void
}

export type ResetAttemptOutcome =
	// `persisted: false` = the reset succeeded (and auto-logged the user in) but the session could not
	// be saved on this device — resume-after-close is lost, the in-tab session is still fully functional.
	| { status: "success"; persisted: boolean }
	// A two-factor account cannot be signed in from here at all: completePasswordReset posts the
	// password/master-key replacement FIRST and only then logs in, sending a placeholder code the
	// account rejects — as Enter2fa or Wrong2fa, the same event either way, so both map here. Reaching
	// that login leg means the replacement already landed, so the new password is almost certainly
	// live; the caller must NOT resubmit, a retry would re-post the reset with a spent token.
	//
	// The "almost" is the endpoint-response assumption: the kind mapping is a generic
	// API-response-code map, not login-specific, so a reset endpoint that itself answered enter_2fa
	// would land here too. The terminal panel's copy hedges accordingly.
	| { status: "two-factor-terminal" }
	// Any other failure — an expired/invalid token, a rejected master-keys file (BadRecoveryKey), or a
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
		const dto = asErrorDTO(e)
		if (readTwoFactorKind(dto.kind) !== null) {
			// The only arm that drops its DTO — logged because the outcome rests on the endpoint-response
			// assumption above: if a reset endpoint ever answers this itself (token NOT spent), the panel's
			// guidance is wrong and this line is the only thing that can attribute the reports.
			log.warn("reset", "two-factor blocked the post-reset sign-in", dto)
			return { status: "two-factor-terminal" }
		}
		return { status: "error", dto }
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
