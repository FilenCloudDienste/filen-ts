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
	DEFAULT_TRANSFER_PREFERENCES,
	FULL_CHUNK_BYTES,
	WEB_TRANSFER_PRESET_VALUES,
	type TransferPreferences
} from "@/features/settings/lib/transferConfig"
import { TRANSFER_PERFORMANCE_PRESETS } from "@filen/shared"

beforeEach(() => {
	kvStore.clear()
})

describe("buildJsClientConfig", () => {
	it("maps the default preset to its concurrency, chunk budget and request rate", () => {
		expect(buildJsClientConfig(DEFAULT_TRANSFER_PREFERENCES)).toEqual({
			concurrency: 48,
			fileIoMemoryBudget: 32 * 1_048_604,
			rateLimitPerSec: 160
		})
	})

	it("pins the web ladder", () => {
		expect(WEB_TRANSFER_PRESET_VALUES).toEqual({
			batterySaver: { chunks: 8, concurrency: 12, rateLimitPerSec: 64 },
			balanced: { chunks: 32, concurrency: 48, rateLimitPerSec: 160 },
			performance: { chunks: 64, concurrency: 96, rateLimitPerSec: 320 },
			maximum: { chunks: 128, concurrency: 160, rateLimitPerSec: 640 }
		})
	})

	// The SDK charges a full chunk 1 MiB plus its 28-byte encryption overhead; a budget in plain MiB
	// would buy one chunk fewer than the preset names.
	it("budgets whole chunks, overhead included", () => {
		for (const preset of TRANSFER_PERFORMANCE_PRESETS) {
			const { fileIoMemoryBudget } = buildJsClientConfig({ preset })

			expect(fileIoMemoryBudget).toBe(WEB_TRANSFER_PRESET_VALUES[preset].chunks * FULL_CHUNK_BYTES)
			expect(Math.floor((fileIoMemoryBudget ?? 0) / FULL_CHUNK_BYTES)).toBe(WEB_TRANSFER_PRESET_VALUES[preset].chunks)
		}

		expect(FULL_CHUNK_BYTES).toBe(1_048_604)
	})

	it("leaves every preset more requests than chunks, so listings still get through", () => {
		for (const values of Object.values(WEB_TRANSFER_PRESET_VALUES)) {
			expect(values.concurrency).toBeGreaterThan(values.chunks)
		}
	})

	it("emits only the three knobs the wasm client actually honors", () => {
		expect(Object.keys(buildJsClientConfig(DEFAULT_TRANSFER_PREFERENCES))).toEqual([
			"concurrency",
			"fileIoMemoryBudget",
			"rateLimitPerSec"
		])
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
