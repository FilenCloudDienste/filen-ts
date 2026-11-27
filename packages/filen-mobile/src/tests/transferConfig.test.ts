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
	resolveTransferValues,
	getResolvedTransferConfig,
	parseCustomConcurrency,
	normalizeTransferChoice,
	normalizeCustomConcurrency,
	DEFAULT_CUSTOM_CONCURRENCY,
	TRANSFER_CUSTOM_CONCURRENCY_SECURE_STORE_KEY,
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

describe("transferConfig — resolveTransferValues", () => {
	// Conservative 4/8/16/32 ladder — the previous 160/224/256 tiers exhausted iOS's low FD limit
	// through the shared client that also backs the video HTTP provider ("could not load this file").
	it("maps the default (balanced) preset to 8 conc / 8 MiB", () => {
		expect(resolveTransferValues("balanced", DEFAULT_CUSTOM_CONCURRENCY)).toEqual({
			concurrency: 8,
			fileIoMemoryBudget: BigInt(8 * MIB),
			maxParallelRequests: 8,
			maxIoMemoryUsage: 8 * MIB
		})
	})

	it("maps maximum to 32 conc / 32 MiB (2× the SDK default, deep FD headroom on iOS)", () => {
		expect(resolveTransferValues("maximum", DEFAULT_CUSTOM_CONCURRENCY)).toEqual({
			concurrency: 32,
			fileIoMemoryBudget: BigInt(32 * MIB),
			maxParallelRequests: 32,
			maxIoMemoryUsage: 32 * MIB
		})
	})

	it("maps batterySaver to 4 / 4 MiB (memory floor: budget/2 stays above one chunk)", () => {
		expect(resolveTransferValues("batterySaver", DEFAULT_CUSTOM_CONCURRENCY)).toMatchObject({ concurrency: 4, maxIoMemoryUsage: 4 * MIB })
	})

	it("keeps every preset's concurrency well under iOS's ~256 FD soft limit (regression guard)", () => {
		for (const choice of ["slowConnection", "batterySaver", "balanced", "performance", "maximum", "custom"] as const) {
			expect(resolveTransferValues(choice, 1000).concurrency).toBeLessThanOrEqual(32)
		}
	})

	it("maps slowConnection to 2 / 4 MiB", () => {
		expect(resolveTransferValues("slowConnection", DEFAULT_CUSTOM_CONCURRENCY)).toEqual({
			concurrency: 2,
			fileIoMemoryBudget: BigInt(4 * MIB),
			maxParallelRequests: 2,
			maxIoMemoryUsage: 4 * MIB
		})
	})

	it("maps custom to exactly its count, with a buffer of at least 4 MiB", () => {
		expect(resolveTransferValues("custom", 2)).toEqual({
			concurrency: 2,
			fileIoMemoryBudget: BigInt(4 * MIB),
			maxParallelRequests: 2,
			maxIoMemoryUsage: 4 * MIB
		})
		expect(resolveTransferValues("custom", 12)).toMatchObject({ concurrency: 12, maxIoMemoryUsage: 12 * MIB })
	})

	it("ignores the custom count for a preset", () => {
		expect(resolveTransferValues("performance", 3).concurrency).toBe(16)
	})
})

describe("transferConfig — normalize + parse", () => {
	it("normalizeTransferChoice keeps every choice and defaults anything else", () => {
		expect(normalizeTransferChoice("custom")).toBe("custom")
		expect(normalizeTransferChoice("slowConnection")).toBe("slowConnection")
		expect(normalizeTransferChoice("turbo")).toBe("balanced")
		expect(normalizeTransferChoice(null)).toBe("balanced")
	})

	it("normalizeCustomConcurrency clamps into 1..32 and defaults a non-number", () => {
		expect(normalizeCustomConcurrency(0)).toBe(1)
		expect(normalizeCustomConcurrency(-5)).toBe(1)
		expect(normalizeCustomConcurrency(99)).toBe(32)
		expect(normalizeCustomConcurrency(2.6)).toBe(3)
		expect(normalizeCustomConcurrency("4")).toBe(DEFAULT_CUSTOM_CONCURRENCY)
		expect(normalizeCustomConcurrency(Number.NaN)).toBe(DEFAULT_CUSTOM_CONCURRENCY)
		expect(normalizeCustomConcurrency(null)).toBe(DEFAULT_CUSTOM_CONCURRENCY)
		expect(DEFAULT_CUSTOM_CONCURRENCY).toBe(8)
	})

	it("parseCustomConcurrency accepts whole numbers 1..32 only", () => {
		expect(parseCustomConcurrency("1")).toBe(1)
		expect(parseCustomConcurrency(" 32 ")).toBe(32)
		expect(parseCustomConcurrency("07")).toBe(7)
		expect(parseCustomConcurrency("0")).toBeNull()
		expect(parseCustomConcurrency("33")).toBeNull()
		expect(parseCustomConcurrency("2.5")).toBeNull()
		expect(parseCustomConcurrency("-1")).toBeNull()
		expect(parseCustomConcurrency("1e1")).toBeNull()
		expect(parseCustomConcurrency("")).toBeNull()
		expect(parseCustomConcurrency("abc")).toBeNull()
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

	it("reads a stored custom choice with its count", async () => {
		storeValues[TRANSFER_PERFORMANCE_PRESET_SECURE_STORE_KEY] = "custom"
		storeValues[TRANSFER_CUSTOM_CONCURRENCY_SECURE_STORE_KEY] = 3

		const resolved = await getResolvedTransferConfig()

		expect(resolved.concurrency).toBe(3)
		expect(resolved.fileIoMemoryBudget).toBe(BigInt(4 * MIB))
	})

	it("clamps a stored out-of-range custom count and defaults a missing one", async () => {
		storeValues[TRANSFER_PERFORMANCE_PRESET_SECURE_STORE_KEY] = "custom"
		storeValues[TRANSFER_CUSTOM_CONCURRENCY_SECURE_STORE_KEY] = 500

		expect((await getResolvedTransferConfig()).concurrency).toBe(32)

		delete storeValues[TRANSFER_CUSTOM_CONCURRENCY_SECURE_STORE_KEY]

		expect((await getResolvedTransferConfig()).concurrency).toBe(8)
	})

	it("reads a stored slowConnection preset", async () => {
		storeValues[TRANSFER_PERFORMANCE_PRESET_SECURE_STORE_KEY] = "slowConnection"

		expect((await getResolvedTransferConfig()).concurrency).toBe(2)
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
		// SDK defaults: no archive jobs run here, and the 5 ms bulk-request window stays on.
		expect(cfg.archiveCodecMemBudget).toBeUndefined()
		expect(cfg.archiveJobConcurrency).toBeUndefined()
		expect(cfg.batchWindowMs).toBeUndefined()
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
