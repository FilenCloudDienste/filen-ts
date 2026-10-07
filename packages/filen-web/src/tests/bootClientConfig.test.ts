import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Type } from "arktype"
import type { JsClientConfig } from "@filen/sdk-rs"

// bootSdk applies the stored transfer preset and archive memory in one config before any client
// exists; an unreadable preference falls back to its own default without dropping the other.
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
import { buildJsClientConfig, DEFAULT_TRANSFER_PREFERENCES, FULL_CHUNK_BYTES } from "@/features/settings/lib/transferConfig"

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
			concurrency: 160,
			fileIoMemoryBudget: 128 * FULL_CHUNK_BYTES,
			rateLimitPerSec: 640,
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

	// wasm's own transfer defaults sit far below the default preset, so they are never the fallback.
	it("applies the default preset for a transfer preference that fails to read, keeping the other", async () => {
		stored({ "settings.transferConfig.v1": new Error("kv down"), "settings.archiveConfig.v1": { codecMemoryMib: 64 } })

		await bootSdk()

		expect(setClientConfig.mock.calls[0]?.[0]).toEqual({
			...buildJsClientConfig(DEFAULT_TRANSFER_PREFERENCES),
			archiveCodecMemBudget: 64 * MIB
		})
		expect(useBootStore.getState().phase).toBe("ready")
	})

	it("applies the default archive memory for an archive preference that fails to read, keeping the other", async () => {
		stored({ "settings.transferConfig.v1": { preset: "batterySaver" }, "settings.archiveConfig.v1": new Error("kv down") })

		await bootSdk()

		expect(setClientConfig.mock.calls[0]?.[0]).toEqual({
			...buildJsClientConfig({ preset: "batterySaver" }),
			archiveCodecMemBudget: 128 * MIB
		})
	})

	it("still boots when applying the config fails", async () => {
		stored({})
		setClientConfig.mockRejectedValueOnce(new Error("worker gone"))

		await bootSdk()

		expect(useBootStore.getState().phase).toBe("ready")
	})
})
