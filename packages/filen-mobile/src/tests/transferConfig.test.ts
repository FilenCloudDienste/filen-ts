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
	it("maps balanced to 160 conc / 96 MiB with mirrored fields", () => {
		expect(resolvePreset("balanced")).toEqual({
			concurrency: 160,
			fileIoMemoryBudget: BigInt(96 * MIB),
			maxParallelRequests: 160,
			maxIoMemoryUsage: 96 * MIB
		})
	})

	it("maps maximum to 256 conc / 256 MiB", () => {
		expect(resolvePreset("maximum")).toEqual({
			concurrency: 256,
			fileIoMemoryBudget: BigInt(256 * MIB),
			maxParallelRequests: 256,
			maxIoMemoryUsage: 256 * MIB
		})
	})

	it("maps batterySaver to 64 / 32 MiB", () => {
		expect(resolvePreset("batterySaver")).toMatchObject({ concurrency: 64, maxIoMemoryUsage: 32 * MIB })
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
		expect(resolved.concurrency).toBe(160)
		expect(resolved.uploadKbps).toBeUndefined()
		expect(resolved.downloadKbps).toBeUndefined()
	})

	it("reads a stored preset + bandwidth (null bandwidth → undefined)", async () => {
		storeValues[TRANSFER_PERFORMANCE_PRESET_SECURE_STORE_KEY] = "maximum"
		storeValues[TRANSFER_UPLOAD_LIMIT_KBPS_SECURE_STORE_KEY] = 5120
		storeValues[TRANSFER_DOWNLOAD_LIMIT_KBPS_SECURE_STORE_KEY] = null

		const resolved = await getResolvedTransferConfig()

		expect(resolved.concurrency).toBe(256)
		expect(resolved.uploadKbps).toBe(5120)
		expect(resolved.downloadKbps).toBeUndefined()
	})

	it("falls back to balanced for an unknown stored preset string", async () => {
		storeValues[TRANSFER_PERFORMANCE_PRESET_SECURE_STORE_KEY] = "turbo"

		expect((await getResolvedTransferConfig()).concurrency).toBe(160)
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
