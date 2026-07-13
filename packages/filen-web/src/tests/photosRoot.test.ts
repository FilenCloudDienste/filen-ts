import { beforeEach, describe, expect, it, vi } from "vitest"

// Same mock boundary/shape as sidebarWidth.test.ts/startScreen.test.ts: `@/lib/storage/adapter`
// itself, backed by an in-memory Map reset per test.
const { kvStore } = vi.hoisted(() => ({ kvStore: new Map<string, unknown>() }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(kvStore.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		kvStore.set(key, value)

		return Promise.resolve()
	},
	kvDelete: (key: string) => {
		kvStore.delete(key)

		return Promise.resolve()
	}
}))

import type { ErrorDTO } from "@/lib/sdk/errors"
import { clearPhotosRoot, getPhotosRoot, isRootGoneError, setPhotosRoot, shouldResetRootOnError } from "@/features/photos/lib/root"

beforeEach(() => {
	kvStore.clear()
})

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

describe("photos root: kv round-trip (unset -> chosen -> ready)", () => {
	it("is unset (null) when nothing is persisted", async () => {
		await expect(getPhotosRoot()).resolves.toBeNull()
	})

	it("roundtrips a chosen root through set/get (chosen -> ready)", async () => {
		await setPhotosRoot("root-uuid-1")

		await expect(getPhotosRoot()).resolves.toBe("root-uuid-1")
	})

	it("choosing a new root overwrites the previous one", async () => {
		await setPhotosRoot("root-uuid-1")
		await setPhotosRoot("root-uuid-2")

		await expect(getPhotosRoot()).resolves.toBe("root-uuid-2")
	})

	it("clearPhotosRoot resets back to unset (the gone-root reset path)", async () => {
		await setPhotosRoot("root-uuid-1")
		await clearPhotosRoot()

		await expect(getPhotosRoot()).resolves.toBeNull()
	})
})

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
