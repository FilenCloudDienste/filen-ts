import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Type } from "arktype"
import type { JsClientConfig } from "@filen/sdk-rs"

// bootSdk applies the stored transfer preset and archive memory in one config before any client
// exists; an unreadable preference leaves only its own knobs on wasm's defaults.
const { kvGetJson, setClientConfig } = vi.hoisted(() => ({
	kvGetJson: vi.fn<(key: string, schema: Type) => Promise<unknown>>(),
	setClientConfig: vi.fn<(config: JsClientConfig) => Promise<void>>()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { boot: () => Promise.resolve({ ok: true, threads: 2 }), setClientConfig },
	threadCount: () => 2
}))
vi.mock("@/lib/storage/adapter", () => ({ storage: () => Promise.resolve({}), kvGetJson }))
vi.mock("@/lib/storage/capability", () => ({ isOpfsApiAvailable: () => true }))
vi.mock("@/lib/sdk/session", () => ({ persistSession: vi.fn(), resumeSession: () => Promise.resolve(false) }))
vi.mock("@/queries/client", () => ({ queryClient: {} }))
vi.mock("@/queries/persist", () => ({ restorePersistedQueries: vi.fn(), purgePersistedQueries: () => Promise.resolve() }))

import { bootSdk } from "@/lib/sdk/boot"
import { useBootStore } from "@/stores/boot"
import { buildJsClientConfig, DEFAULT_TRANSFER_PREFERENCES } from "@/features/settings/lib/transferConfig"
import { TRANSFER_PRESET_VALUES } from "@filen/shared"

const MIB = 1024 * 1024

function stored(rows: Record<string, unknown>): void {
	kvGetJson.mockImplementation((key, schema) => {
		const row = rows[key]

		if (row instanceof Error) {
			return Promise.reject(row)
		}

		return Promise.resolve(schema.allows(row) ? row : null)
	})
}

beforeEach(() => {
	setClientConfig.mockResolvedValue(undefined)
	useBootStore.setState({ phase: "idle" })
})

describe("bootSdk client config", () => {
	it("merges the transfer preset with the archive memory, in bytes", async () => {
		stored({ "settings.transferConfig.v1": { preset: "maximum" }, "settings.archiveConfig.v1": { codecMemoryMib: 512 } })

		await bootSdk()

		expect(setClientConfig).toHaveBeenCalledTimes(1)
		expect(setClientConfig.mock.calls[0]?.[0]).toEqual({
			concurrency: TRANSFER_PRESET_VALUES.maximum.concurrency,
			fileIoMemoryBudget: TRANSFER_PRESET_VALUES.maximum.memoryMib * MIB,
			archiveCodecMemBudget: 512 * MIB
		})
		expect(useBootStore.getState().phase).toBe("ready")
	})

	it("uses each preference's default when nothing is stored", async () => {
		stored({})

		await bootSdk()

		expect(setClientConfig.mock.calls[0]?.[0]).toEqual({
			...buildJsClientConfig(DEFAULT_TRANSFER_PREFERENCES),
			archiveCodecMemBudget: 128 * MIB
		})
	})

	it("keeps wasm's defaults for a preference that fails to read, applying the other", async () => {
		stored({ "settings.transferConfig.v1": new Error("kv down"), "settings.archiveConfig.v1": { codecMemoryMib: 64 } })

		await bootSdk()

		expect(setClientConfig.mock.calls[0]?.[0]).toEqual({ archiveCodecMemBudget: 64 * MIB })
		expect(useBootStore.getState().phase).toBe("ready")
	})

	it("still boots when applying the config fails", async () => {
		stored({})
		setClientConfig.mockRejectedValueOnce(new Error("worker gone"))

		await bootSdk()

		expect(useBootStore.getState().phase).toBe("ready")
	})
})
