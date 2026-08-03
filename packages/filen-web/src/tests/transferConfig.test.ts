import { beforeEach, describe, expect, it, vi } from "vitest"

// Same mock boundary/shape as sidebarWidth.test.ts: `@/lib/storage/adapter` itself, backed by an
// in-memory Map reset per test — kvGetJson/kvSetJson's own envelope+schema contract is already
// covered by adapter.test.ts.
const { kvStore } = vi.hoisted(() => ({ kvStore: new Map<string, unknown>() }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(kvStore.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		kvStore.set(key, value)

		return Promise.resolve()
	}
}))

import {
	buildJsClientConfig,
	getTransferPreferences,
	setTransferPreferences,
	TRANSFER_PRESET_VALUES,
	DEFAULT_TRANSFER_PREFERENCES,
	type TransferPreferences
} from "@/features/settings/lib/transferConfig"

beforeEach(() => {
	kvStore.clear()
})

describe("buildJsClientConfig", () => {
	it("maps the default preset to its concurrency + memory budget", () => {
		expect(buildJsClientConfig(DEFAULT_TRANSFER_PREFERENCES)).toEqual({
			concurrency: 8,
			fileIoMemoryBudget: 8 * 1024 * 1024
		})
	})

	it("maps every preset to its own concurrency + memory budget", () => {
		for (const [preset, values] of Object.entries(TRANSFER_PRESET_VALUES)) {
			const prefs: TransferPreferences = { preset: preset as TransferPreferences["preset"] }
			const config = buildJsClientConfig(prefs)

			expect(config.concurrency).toBe(values.concurrency)
			expect(config.fileIoMemoryBudget).toBe(values.memoryMib * 1024 * 1024)
		}
	})

	it("emits only the two knobs the wasm client actually honors", () => {
		expect(Object.keys(buildJsClientConfig(DEFAULT_TRANSFER_PREFERENCES))).toEqual(["concurrency", "fileIoMemoryBudget"])
	})
})

describe("transfer preferences: get/set", () => {
	it("returns the default (balanced) when nothing is persisted", async () => {
		await expect(getTransferPreferences()).resolves.toEqual(DEFAULT_TRANSFER_PREFERENCES)
	})

	it("roundtrips a stored preference through set/get", async () => {
		const prefs: TransferPreferences = { preset: "maximum" }
		await setTransferPreferences(prefs)

		await expect(getTransferPreferences()).resolves.toEqual(prefs)
	})
})
