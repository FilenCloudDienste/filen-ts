import { describe, expect, it } from "vitest"
import { isIncomingShareLoading, incomingShareAction } from "@/features/incomingShare/utils"

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

describe("incomingShareAction", () => {
	it("offers the confirm button when there is something to save and the device is online", () => {
		expect(incomingShareAction({ hasPayloads: true, isOnline: true })).toBe("confirm")
	})

	it("replaces the button with the offline notice rather than leaving the screen actionless", () => {
		// The shipped bug (#104): the button is gated on connectivity, so going offline removed the
		// screen's only action with nothing explaining why. Whatever the state, it must never be
		// "button gone AND no notice" while there are files waiting to be saved.
		expect(incomingShareAction({ hasPayloads: true, isOnline: false })).toBe("offlineNotice")
	})

	it("always offers something while files are waiting, whatever the connectivity", () => {
		// The shape of #104 stated directly: with files on screen there is no state where the user is
		// given neither an action nor an explanation. Which of the two is the tests above; that it is
		// never "none" is what actually broke.
		for (const isOnline of [true, false]) {
			expect(incomingShareAction({ hasPayloads: true, isOnline })).not.toBe("none")
		}
	})

	it("stays silent when the share produced no files, online or not", () => {
		// The list renders its own empty/error state there; an offline notice would blame
		// connectivity for a share that simply carried nothing uploadable.
		expect(incomingShareAction({ hasPayloads: false, isOnline: false })).toBe("none")
		expect(incomingShareAction({ hasPayloads: false, isOnline: true })).toBe("none")
	})
})
