import { describe, expect, it } from "vitest"
import { isIncomingShareLoading } from "@/features/incomingShare/utils"

const base = {
	isResolving: false,
	hasError: false,
	sharedCount: 0,
	resolvedCount: 0,
	hasResolvedOnce: false
}

describe("isIncomingShareLoading", () => {
	it("spins while a resolution is running", () => {
		expect(isIncomingShareLoading({ ...base, isResolving: true })).toBe(true)
		expect(isIncomingShareLoading({ ...base, isResolving: true, hasError: true })).toBe(true)
		expect(isIncomingShareLoading({ ...base, isResolving: true, resolvedCount: 2 })).toBe(true)
	})

	it("never spins on a resolution error", () => {
		expect(isIncomingShareLoading({ ...base, hasError: true, sharedCount: 1 })).toBe(false)
	})

	it("spins on the first frames when something was shared but resolution has not completed", () => {
		// The hook parses sharedPayloads synchronously at mount but only starts resolving in a
		// post-commit effect — this is the pre-resolve window the spinner must cover.
		expect(isIncomingShareLoading({ ...base, sharedCount: 1 })).toBe(true)
	})

	it("stops spinning once a resolution attempt completed empty (regression: infinite spinner)", () => {
		// A share the native parsers dropped resolved to an empty list with no error — the
		// screen must fall through to the empty state, not spin forever.
		expect(isIncomingShareLoading({ ...base, sharedCount: 1, hasResolvedOnce: true })).toBe(false)
	})

	it("does not spin when nothing was shared at all", () => {
		// Empty sync parse: resolution will never run, so waiting on it would never end.
		expect(isIncomingShareLoading(base)).toBe(false)
	})

	it("does not spin once resolved payloads are present", () => {
		expect(isIncomingShareLoading({ ...base, sharedCount: 1, resolvedCount: 1 })).toBe(false)
		expect(isIncomingShareLoading({ ...base, sharedCount: 1, resolvedCount: 1, hasResolvedOnce: true })).toBe(false)
	})
})
