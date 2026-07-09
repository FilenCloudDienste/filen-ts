import type { StringifiedClient } from "@filen/sdk-rs"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import type { SdkErrorKind } from "@/lib/sdk/errorKinds.gen"
import { log } from "@/lib/log"

export interface LoginParams {
	email: string
	password: string
	twoFactorCode?: string
}

// Injected collaborators so the attempt state machine is unit-testable without a worker or DOM.
// `generation` reads the caller's cancellation counter: the caller bumps it when the user dismisses
// the two-factor dialog, which marks any attempt started under an older value as stale on settle.
export interface LoginAttemptDeps {
	login: (params: LoginParams) => Promise<StringifiedClient>
	logout: () => Promise<void>
	persist: (blob: StringifiedClient) => Promise<void>
	broadcast: () => void
	generation: () => number
}

export type LoginAttemptOutcome =
	// `persisted: false` = signed in but the session could not be saved (resume-after-close is lost).
	| { status: "success"; persisted: boolean }
	// Two-factor code required/rejected — the caller opens (or keeps open) the code dialog.
	| { status: "two-factor"; wrongCode: boolean }
	// Any other failure — the caller surfaces the DTO's label.
	| { status: "error"; dto: ErrorDTO }
	// Canceled while in flight — the result was discarded; the caller changes nothing.
	| { status: "stale" }

// `satisfies` pins these to the generated kind union: an SDK rename fails compilation here instead
// of silently breaking the two-factor branch at runtime.
const TWO_FACTOR_KINDS: readonly string[] = ["Enter2fa", "Wrong2fa"] satisfies readonly SdkErrorKind[]
const WRONG_2FA = "Wrong2fa" satisfies SdkErrorKind

// One login attempt (first submit or two-factor retry — identical apart from `twoFactorCode`).
// The generation captured at start decides, once the login settles, whether anyone still wants the
// result: a dialog dismissal mid-flight bumps the counter, so a late failure is swallowed (no
// dialog reopen, no toast) and a late success is discarded — cancel means cancel.
export async function runLoginAttempt(deps: LoginAttemptDeps, params: LoginParams): Promise<LoginAttemptOutcome> {
	const generation = deps.generation()
	let blob: StringifiedClient
	try {
		blob = await deps.login(params)
	} catch (e) {
		if (deps.generation() !== generation) {
			return { status: "stale" }
		}
		const dto = asErrorDTO(e)
		if (dto.kind !== undefined && TWO_FACTOR_KINDS.includes(dto.kind)) {
			// Wrong2fa only ever arrives for an attempt that DID send a code (a retry), so it always
			// means "the code you just entered was rejected"; Enter2fa is the code-less first attempt.
			return { status: "two-factor", wrongCode: dto.kind === WRONG_2FA }
		}
		return { status: "error", dto }
	}
	if (deps.generation() !== generation) {
		// Canceled but the login landed: the worker holds an orphaned authed client. Discard it —
		// no persist, no broadcast, no navigation; the burned login is the cost of honest cancel
		// semantics. Fire-and-forget: a failed logout just leaves a client the next login replaces.
		void deps.logout().catch(() => undefined)
		return { status: "stale" }
	}
	// Persist is deliberately isolated from the login result: the worker IS authenticated here, so a
	// failed local save must not masquerade as a failed login (the user would retry against a
	// rate-limited endpoint). Losing resume-after-close beats losing the sign-in — report and proceed.
	let persisted = true
	try {
		await deps.persist(blob)
	} catch (e) {
		persisted = false
		log.warn("login", "session persist failed", asErrorDTO(e))
	}
	if (persisted) {
		// Only a durably persisted session is announced — other tabs react by reading it from kv,
		// and an unpersisted one would leave them nothing to adopt.
		deps.broadcast()
	}
	return { status: "success", persisted }
}
