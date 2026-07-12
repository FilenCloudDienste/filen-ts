import type { PreviewCategory } from "@/features/drive/lib/preview.logic"
import type { ErrorDTO } from "@/lib/sdk/errors"

// The normalized, presentation-ready result of resolving a public link — a plain, worker-free shape
// the query fn (queries/publicLink.ts) produces from the raw SDK types, so the route renders from
// this alone and never touches @filen/sdk-rs shapes directly. `password` is its own arm: a directory
// link reports it up-front via DirPublicInfo.hasPassword, before any name is resolvable.
export type PublicLinkResource =
	{ kind: "file"; name: string; size: bigint; category: PreviewCategory } | { kind: "directory"; name: string } | { kind: "password" }

// The four presentation states the /f/ /d/ routes render. `ready` carries the resolved resource;
// `password` and `invalid` are the two terminal non-ready surfaces (the real password PROMPT ships
// with the full viewer — this foundation only DETECTS the state).
export type PublicLinkState =
	| { status: "loading" }
	| { status: "invalid" }
	| { status: "password" }
	| { status: "ready"; resource: Extract<PublicLinkResource, { kind: "file" | "directory" }> }

// Best-effort: does a rejected resolution look like "this link needs a password" rather than "this
// link is gone"? A file link has no up-front hasPassword flag (unlike a directory) — a protected file
// simply throws on getLinkedFile without the password — so the only signal available at this layer is
// the error text. Duck-typed against the ErrorDTO the worker boundary throws (kind/label/message),
// substring-matched case-insensitively — deliberately lenient, since misclassifying a password error
// as "unavailable" (or vice-versa) only changes which of two placeholder surfaces shows this step.
export function isPasswordError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) {
		return false
	}

	const dto = error as Partial<ErrorDTO>
	const haystack = `${dto.kind ?? ""} ${dto.label ?? ""} ${dto.message ?? ""}`.toLowerCase()

	return haystack.includes("password")
}

// The three inputs a query exposes, reduced to what the state machine needs (pure — no React, no
// react-query import, so it is directly unit-testable). `status` mirrors react-query's own
// pending/error/success; `data` is present only on success, `error` only on error.
export interface PublicLinkQueryInput {
	status: "pending" | "error" | "success"
	data: PublicLinkResource | undefined
	error: unknown
}

// Maps a resolved-link resolver's outcome to the rendered state. A null resolver result (bad uuid /
// bad-or-short key — resolved BEFORE any query runs) is the caller's own `invalid` short-circuit and
// never reaches here.
export function publicLinkState(input: PublicLinkQueryInput): PublicLinkState {
	if (input.status === "pending") {
		return { status: "loading" }
	}

	if (input.status === "error") {
		return isPasswordError(input.error) ? { status: "password" } : { status: "invalid" }
	}

	const data = input.data

	if (data === undefined) {
		return { status: "invalid" }
	}

	if (data.kind === "password") {
		return { status: "password" }
	}

	return { status: "ready", resource: data }
}
