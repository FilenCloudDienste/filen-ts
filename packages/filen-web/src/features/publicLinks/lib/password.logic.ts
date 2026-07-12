import type { DirPublicInfo, DirPublicLink } from "@filen/sdk-rs"
import { isPasswordError } from "@/features/publicLinks/lib/state.logic"

// Pure state machines for the two password flows — file and directory — so the gate, the invalid
// fallback, and the "checking/wrong" transitions are decided by directly-testable functions rather
// than tangled react-query branching in the views.
//
// ★ SECURITY: nothing here holds or returns the typed password. The password lives ONLY in the view's
// in-memory state and the worker-call closure; a reload drops that state and re-prompts by
// construction (there is no persistence path for it to survive). These functions see only booleans
// and a react-query status.

export type LinkAccessState = "loading" | "prompt" | "checking" | "wrong" | "ready" | "error"

// FILE links carry no up-front password flag: a protected file simply throws on getLinkedFile without
// the password, so the gate is driven entirely by the resolve outcome. Before any submit a password
// error means "prompt"; after a submit it means "wrong". A non-password error is a genuinely dead link
// → the shared invalid surface. `submitted` flips true the first time the visitor sends a password.
export function fileAccessState(input: { status: "pending" | "error" | "success"; error: unknown; submitted: boolean }): LinkAccessState {
	if (input.status === "pending") {
		return input.submitted ? "checking" : "loading"
	}

	if (input.status === "success") {
		return "ready"
	}

	if (!isPasswordError(input.error)) {
		return "error"
	}

	return input.submitted ? "wrong" : "prompt"
}

// DIRECTORY links report password protection up front via DirPublicInfo.hasPassword, but the info call
// itself succeeds WITHOUT the password (it only says one is needed). The password is then validated by
// a second call — listing the root WITH the password set — so acceptance is an explicit imperative
// step the view owns: `verifying` while that listing is in flight, `failed` after it rejects, `accepted`
// once it resolves. An unprotected link (or an already-accepted one) is immediately ready.
export function dirAccessState(input: {
	infoStatus: "pending" | "error" | "success"
	hasPassword: boolean
	accepted: boolean
	verifying: boolean
	failed: boolean
}): LinkAccessState {
	if (input.infoStatus === "pending") {
		return "loading"
	}

	if (input.infoStatus === "error") {
		return "error"
	}

	if (!input.hasPassword || input.accepted) {
		return "ready"
	}

	if (input.verifying) {
		return "checking"
	}

	return input.failed ? "wrong" : "prompt"
}

// The link handle every browse call (list/size/zip) uses, with the session's accepted password folded
// in. Keeping this a pure derivation means the password is threaded identically at every folder depth
// — entering subfolders never re-prompts because the SAME link (password and all) is reused, and the
// virtual navigation stack never has to carry it.
export function linkForBrowsing(info: DirPublicInfo, acceptedPassword: string | undefined): DirPublicLink {
	return { ...info.link, password: acceptedPassword ?? info.link.password }
}
