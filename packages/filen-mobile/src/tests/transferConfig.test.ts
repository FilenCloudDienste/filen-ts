import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@filen/sdk-rs", () => ({
	LogLevel: { Off: "Off", Error: "Error", Warn: "Warn", Info: "Info", Debug: "Debug", Trace: "Trace" }
}))

const storeValues: Record<string, unknown> = {}

vi.mock("@/lib/secureStore", () => ({
	default: {
		get: vi.fn(async (key: string) => (key in storeValues ? storeValues[key] : null)),
		set: vi.fn(async (key: string, value: unknown) => {
			storeValues[key] = value
		})
	},
	useSecureStore: vi.fn()
}))

import {
	resolvePreset,
	getResolvedTransferConfig,
	buildJsClientConfig,
	bandwidthKbpsToSdkArg,
	kbpsToMbLabel,
	DEFAULT_RESOLVED_TRANSFER_CONFIG,
	TRANSFER_PERFORMANCE_PRESET_SECURE_STORE_KEY,
	TRANSFER_UPLOAD_LIMIT_KBPS_SECURE_STORE_KEY,
	TRANSFER_DOWNLOAD_LIMIT_KBPS_SECURE_STORE_KEY,
	SDK_RATE_LIMIT_PER_SEC
} from "@/features/settings/transferConfig"

const MIB = 1024 * 1024

describe("transferConfig — resolvePreset", () => {
	// Conservative 4/8/16/32 ladder — the previous 160/224/256 tiers exhausted iOS's low FD limit
	// through the shared client that also backs the video HTTP provider ("could not load this file").
	it("maps the default (balanced) preset to 8 conc / 8 MiB", () => {
		expect(resolvePreset("balanced")).toEqual({
			concurrency: 8,
			fileIoMemoryBudget: BigInt(8 * MIB),
			maxParallelRequests: 8,
			maxIoMemoryUsage: 8 * MIB
		})
	})

	it("maps maximum to 32 conc / 32 MiB (2× the SDK default, deep FD headroom on iOS)", () => {
		expect(resolvePreset("maximum")).toEqual({
			concurrency: 32,
			fileIoMemoryBudget: BigInt(32 * MIB),
			maxParallelRequests: 32,
			maxIoMemoryUsage: 32 * MIB
		})
	})

	it("maps batterySaver to 4 / 4 MiB (memory floor: budget/2 stays above one chunk)", () => {
		expect(resolvePreset("batterySaver")).toMatchObject({ concurrency: 4, maxIoMemoryUsage: 4 * MIB })
	})

	it("keeps every preset's concurrency well under iOS's ~256 FD soft limit (regression guard)", () => {
		for (const preset of ["batterySaver", "balanced", "performance", "maximum"] as const) {
			expect(resolvePreset(preset).concurrency).toBeLessThanOrEqual(32)
		}
	})
})

describe("transferConfig — getResolvedTransferConfig", () => {
	beforeEach(() => {
		for (const k of Object.keys(storeValues)) {
			delete storeValues[k]
		}
	})

	it("falls back to the balanced default + unlimited when unset", async () => {
		const resolved = await getResolvedTransferConfig()

		expect(resolved).toEqual(DEFAULT_RESOLVED_TRANSFER_CONFIG)
		expect(resolved.concurrency).toBe(8)
		expect(resolved.uploadKbps).toBeUndefined()
		expect(resolved.downloadKbps).toBeUndefined()
	})

	it("reads a stored preset + bandwidth (null bandwidth → undefined)", async () => {
		storeValues[TRANSFER_PERFORMANCE_PRESET_SECURE_STORE_KEY] = "maximum"
		storeValues[TRANSFER_UPLOAD_LIMIT_KBPS_SECURE_STORE_KEY] = 5120
		storeValues[TRANSFER_DOWNLOAD_LIMIT_KBPS_SECURE_STORE_KEY] = null

		const resolved = await getResolvedTransferConfig()

		expect(resolved.concurrency).toBe(32)
		expect(resolved.uploadKbps).toBe(5120)
		expect(resolved.downloadKbps).toBeUndefined()
	})

	it("falls back to balanced for an unknown stored preset string", async () => {
		storeValues[TRANSFER_PERFORMANCE_PRESET_SECURE_STORE_KEY] = "turbo"

		expect((await getResolvedTransferConfig()).concurrency).toBe(8)
	})
})

describe("transferConfig — buildJsClientConfig", () => {
	it("assembles the SDK config (bigint budget, pinned rate limit, Info log level)", () => {
		const cfg = buildJsClientConfig({
			concurrency: 160,
			fileIoMemoryBudget: BigInt(96 * MIB),
			maxParallelRequests: 160,
			maxIoMemoryUsage: 96 * MIB,
			uploadKbps: 5120,
			downloadKbps: undefined
		})

		expect(cfg.concurrency).toBe(160)
		expect(cfg.fileIoMemoryBudget).toBe(BigInt(96 * MIB))
		expect(cfg.rateLimitPerSec).toBe(SDK_RATE_LIMIT_PER_SEC)
		expect(cfg.uploadBandwidthKilobytesPerSec).toBe(5120)
		expect(cfg.downloadBandwidthKilobytesPerSec).toBeUndefined()
		expect(cfg.logLevel).toBe("Info")
	})
})

describe("transferConfig — helpers", () => {
	it("bandwidthKbpsToSdkArg maps null/undefined to 0 (unlimited) and passes numbers through", () => {
		expect(bandwidthKbpsToSdkArg(null)).toBe(0)
		expect(bandwidthKbpsToSdkArg(undefined)).toBe(0)
		expect(bandwidthKbpsToSdkArg(5120)).toBe(5120)
	})

	it("kbpsToMbLabel renders MB/s (1024-based)", () => {
		expect(kbpsToMbLabel(1024)).toBe("1 MB/s")
		expect(kbpsToMbLabel(51200)).toBe("50 MB/s")
	})
})
