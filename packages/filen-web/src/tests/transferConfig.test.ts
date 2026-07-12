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
	kbpsToMbLabel,
	getTransferPreferences,
	setTransferPreferences,
	TRANSFER_PRESET_VALUES,
	TRANSFER_BANDWIDTH_PRESETS_KBPS,
	DEFAULT_TRANSFER_PREFERENCES,
	type TransferPreferences
} from "@/features/settings/lib/transferConfig"

beforeEach(() => {
	kvStore.clear()
})

describe("buildJsClientConfig", () => {
	it("maps the default preset to its concurrency + memory budget, with no bandwidth cap", () => {
		expect(buildJsClientConfig(DEFAULT_TRANSFER_PREFERENCES)).toEqual({
			concurrency: 8,
			fileIoMemoryBudget: 8 * 1024 * 1024,
			uploadBandwidthKilobytesPerSec: undefined,
			downloadBandwidthKilobytesPerSec: undefined
		})
	})

	it("maps every preset to its own concurrency + memory budget", () => {
		for (const [preset, values] of Object.entries(TRANSFER_PRESET_VALUES)) {
			const prefs: TransferPreferences = { preset: preset as TransferPreferences["preset"], uploadKbps: null, downloadKbps: null }
			const config = buildJsClientConfig(prefs)

			expect(config.concurrency).toBe(values.concurrency)
			expect(config.fileIoMemoryBudget).toBe(values.memoryMib * 1024 * 1024)
		}
	})

	it("passes a set bandwidth cap straight through as kilobytes/sec", () => {
		const prefs: TransferPreferences = { preset: "balanced", uploadKbps: 1024, downloadKbps: 5120 }

		expect(buildJsClientConfig(prefs)).toMatchObject({
			uploadBandwidthKilobytesPerSec: 1024,
			downloadBandwidthKilobytesPerSec: 5120
		})
	})

	it("maps null (unlimited) to undefined, never 0 or null, matching the wasm config's optional-field convention", () => {
		const prefs: TransferPreferences = { preset: "balanced", uploadKbps: null, downloadKbps: null }
		const config = buildJsClientConfig(prefs)

		expect(config.uploadBandwidthKilobytesPerSec).toBeUndefined()
		expect(config.downloadBandwidthKilobytesPerSec).toBeUndefined()
	})
})

describe("kbpsToMbLabel", () => {
	it("formats every bandwidth preset as a whole-number MB/s label", () => {
		expect(TRANSFER_BANDWIDTH_PRESETS_KBPS.map(kbpsToMbLabel)).toEqual(["1 MB/s", "2 MB/s", "5 MB/s", "10 MB/s", "25 MB/s", "50 MB/s"])
	})
})

describe("transfer preferences: get/set", () => {
	it("returns the default (balanced, unlimited) when nothing is persisted", async () => {
		await expect(getTransferPreferences()).resolves.toEqual(DEFAULT_TRANSFER_PREFERENCES)
	})

	it("roundtrips a stored preference through set/get", async () => {
		const prefs: TransferPreferences = { preset: "maximum", uploadKbps: 2048, downloadKbps: null }
		await setTransferPreferences(prefs)

		await expect(getTransferPreferences()).resolves.toEqual(prefs)
	})
})
