import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"

// Shared outcome-union shapes + the runOp SDK-call wrapper every action-helper layer (drive,
// contacts, ...) builds on, instead of each domain hand-rolling its own copy.

// A write that resolves to a domain item on success (rename, favorite-toggle, ...).
export type ActionOutcome<T> = { status: "success"; item: T } | { status: "error"; dto: ErrorDTO }

// A write with no meaningful success payload (delete, block, empty-trash, ...).
export type VoidActionOutcome = { status: "success" } | { status: "error"; dto: ErrorDTO }

// Every worker call funnels through here so a rejection — whichever side ends up catching it, a
// singular action's own try/catch or runBulk's per-item catch — is already LABEL-FIRST-shaped.
// asErrorDTO is idempotent on a DTO the worker's Comlink boundary already threw and normalizes
// anything else (e.g. a plain Error from a mocked op in tests), so this is safe to apply uniformly.
// A call site whose remote result is itself a union (a directory-vs-file ternary, or a remote method
// whose own resolved type is a union) needs an explicit `runOp<T>(...)` type argument — Comlink's
// Remote<T> wraps a return type through two DISTRIBUTIVE conditional types, which turns a union
// return into a union of Promises rather than a Promise of a union, defeating T's inference.
export async function runOp<T>(op: Promise<T>): Promise<T> {
	try {
		return await op
	} catch (e) {
		// A plain ErrorDTO thrown intact is what the singular actions' own try/catch and runBulk's
		// per-item catch both expect to receive; an Error subclass would just need unwrapping right
		// back out again.
		// eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberate, see above
		throw asErrorDTO(e)
	}
}
