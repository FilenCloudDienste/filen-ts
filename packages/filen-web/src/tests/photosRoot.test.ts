import { describe, expect, it } from "vitest"
import type { ErrorDTO } from "@/lib/sdk/errors"
import { isRootGoneError, shouldResetRootOnError } from "@/features/photos/lib/root"

function goneDto(): ErrorDTO {
	return {
		species: "plain",
		message: "directory not found: 11111111-1111-1111-1111-111111111111",
		label: "directory not found: 11111111-1111-1111-1111-111111111111"
	}
}

function transientDto(): ErrorDTO {
	return { species: "plain", message: "network request failed", label: "network request failed" }
}

// A gone-directory error is never an SDK-kind error (getCachedDir/getDirOptional's own resolution
// fails before the SDK layer is ever reached — see sdk.worker.ts's "uuid" branch) — this fixture
// proves the message-prefix check doesn't accidentally also match an SDK error carrying an
// unrelated kind that happens to share the same english words.
function sdkKindDto(kind: string): ErrorDTO {
	return { species: "sdk", kind, message: `directory not found: x`, label: `directory not found: x` }
}

describe("isRootGoneError", () => {
	it("matches a plain error whose message starts with the directory-not-found prefix", () => {
		expect(isRootGoneError(goneDto())).toBe(true)
	})

	it("does not match a transient/unrelated plain error", () => {
		expect(isRootGoneError(transientDto())).toBe(false)
	})

	it("does not match an SDK-species error even if its message contains the same words", () => {
		expect(isRootGoneError(sdkKindDto("network"))).toBe(false)
	})
})

describe("shouldResetRootOnError (root state machine: gone-error resets; transient/offline does NOT)", () => {
	it("resets on a genuine gone-root error while online", () => {
		expect(shouldResetRootOnError(goneDto(), true)).toBe(true)
	})

	it("does NOT reset on a transient error while online", () => {
		expect(shouldResetRootOnError(transientDto(), true)).toBe(false)
	})

	it("does NOT reset on a gone-root-shaped error while offline (defense-in-depth: connectivity gate wins)", () => {
		expect(shouldResetRootOnError(goneDto(), false)).toBe(false)
	})

	it("does NOT reset on a transient error while offline", () => {
		expect(shouldResetRootOnError(transientDto(), false)).toBe(false)
	})
})
