import secureStore, { useSecureStore } from "@/lib/secureStore"
import { LogLevel, type JsClientConfig } from "@filen/sdk-rs"

export const TRANSFER_PERFORMANCE_PRESET_SECURE_STORE_KEY = "transfers.performancePreset"
export const TRANSFER_UPLOAD_LIMIT_KBPS_SECURE_STORE_KEY = "transfers.uploadLimitKbps"
export const TRANSFER_DOWNLOAD_LIMIT_KBPS_SECURE_STORE_KEY = "transfers.downloadLimitKbps"

export const TRANSFER_PERFORMANCE_PRESETS = ["batterySaver", "balanced", "performance", "maximum"] as const

export type TransferPerformancePreset = (typeof TRANSFER_PERFORMANCE_PRESETS)[number]

export const DEFAULT_TRANSFER_PERFORMANCE_PRESET: TransferPerformancePreset = "balanced"

// API request-rate governor (requests/sec). Not user-tunable — pinned to today's value.
export const SDK_RATE_LIMIT_PER_SEC = 128

const MIB = 1024 * 1024

// concurrency = the SDK's GLOBAL in-flight HTTP request cap (GlobalConcurrencyLimitLayer). Under
// HTTP/1.1 each in-flight request tends to hold its own socket = one file descriptor, and the SAME
// client backs the localhost video HTTP provider — so this cap is shared between bulk transfers and
// video streaming. iOS's default file-descriptor soft limit is low (historically 256), and the
// provider + SQLite + the expo-image disk cache all draw from the same table; the previous top
// presets (224/256) could exhaust it → EMFILE surfacing as "could not load this file" + choppy /
// slow video. Deliberately conservative ladder (4/8/16/32) — even "maximum" (32) sits at 2× the
// SDK's own default (16) and leaves a huge FD margin on iOS, prioritising reliable video streaming
// over peak bulk-transfer parallelism.
//
// memoryMib = the SDK's fileIoMemoryBudget (in-flight chunk-buffer budget; the streaming read-ahead
// window is capped at budget/2, floored at one encrypted chunk ≈ 1 MiB, so the 4 MiB minimum keeps a
// ≥ 2 MiB window). maxParallelRequests / maxIoMemoryUsage are mirrored (no consumer found in the
// pinned SDK, but set to avoid any regression — see the design doc).
export const TRANSFER_PRESET_VALUES: Record<TransferPerformancePreset, { concurrency: number; memoryMib: number }> = {
	batterySaver: { concurrency: 4, memoryMib: 4 },
	balanced: { concurrency: 8, memoryMib: 8 },
	performance: { concurrency: 16, memoryMib: 16 },
	maximum: { concurrency: 32, memoryMib: 32 }
}

// 1 / 2 / 5 / 10 / 25 / 50 MB/s in KB/s (1024-based). null = unlimited. All ≥ the SDK's 16 KB/s upload floor.
export const TRANSFER_BANDWIDTH_PRESETS_KBPS: readonly number[] = [1024, 2048, 5120, 10240, 25600, 51200]

export type ResolvedTransferConfig = {
	concurrency: number
	fileIoMemoryBudget: bigint
	maxParallelRequests: number
	maxIoMemoryUsage: number
	uploadKbps: number | undefined
	downloadKbps: number | undefined
}

export function resolvePreset(preset: TransferPerformancePreset): {
	concurrency: number
	fileIoMemoryBudget: bigint
	maxParallelRequests: number
	maxIoMemoryUsage: number
} {
	const { concurrency, memoryMib } = TRANSFER_PRESET_VALUES[preset]
	const bytes = memoryMib * MIB

	return {
		concurrency,
		fileIoMemoryBudget: BigInt(bytes),
		maxParallelRequests: concurrency,
		maxIoMemoryUsage: bytes
	}
}

export const DEFAULT_RESOLVED_TRANSFER_CONFIG: ResolvedTransferConfig = {
	...resolvePreset(DEFAULT_TRANSFER_PERFORMANCE_PRESET),
	uploadKbps: undefined,
	downloadKbps: undefined
}

function normalizePreset(value: unknown): TransferPerformancePreset {
	return TRANSFER_PERFORMANCE_PRESETS.includes(value as TransferPerformancePreset)
		? (value as TransferPerformancePreset)
		: DEFAULT_TRANSFER_PERFORMANCE_PRESET
}

function normalizeKbps(value: unknown): number | undefined {
	return typeof value === "number" && value > 0 ? value : undefined
}

// Non-reactive one-shot read for boot/auth (mirrors theme.ts getInitialThemeSetting).
export async function getResolvedTransferConfig(): Promise<ResolvedTransferConfig> {
	const [presetRaw, uploadRaw, downloadRaw] = await Promise.all([
		secureStore.get<TransferPerformancePreset>(TRANSFER_PERFORMANCE_PRESET_SECURE_STORE_KEY),
		secureStore.get<number | null>(TRANSFER_UPLOAD_LIMIT_KBPS_SECURE_STORE_KEY),
		secureStore.get<number | null>(TRANSFER_DOWNLOAD_LIMIT_KBPS_SECURE_STORE_KEY)
	])

	return {
		...resolvePreset(normalizePreset(presetRaw)),
		uploadKbps: normalizeKbps(uploadRaw),
		downloadKbps: normalizeKbps(downloadRaw)
	}
}

export function buildJsClientConfig(resolved: ResolvedTransferConfig): JsClientConfig {
	return {
		concurrency: resolved.concurrency,
		rateLimitPerSec: SDK_RATE_LIMIT_PER_SEC,
		uploadBandwidthKilobytesPerSec: resolved.uploadKbps,
		downloadBandwidthKilobytesPerSec: resolved.downloadKbps,
		logLevel: LogLevel.Info,
		fileIoMemoryBudget: resolved.fileIoMemoryBudget
	}
}

// The live setBandwidthLimits setter takes required u32s where 0 = unlimited (NonZeroU32::new(0) → None).
export function bandwidthKbpsToSdkArg(kbps: number | null | undefined): number {
	return kbps ?? 0
}

export function kbpsToMbLabel(kbps: number): string {
	return `${kbps / 1024} MB/s`
}

export function useTransferPerformancePreset(): [
	TransferPerformancePreset,
	(next: TransferPerformancePreset | ((prev: TransferPerformancePreset) => TransferPerformancePreset)) => void
] {
	return useSecureStore<TransferPerformancePreset>(TRANSFER_PERFORMANCE_PRESET_SECURE_STORE_KEY, DEFAULT_TRANSFER_PERFORMANCE_PRESET)
}

export function useUploadLimitKbps(): [number | null, (next: number | null | ((prev: number | null) => number | null)) => void] {
	return useSecureStore<number | null>(TRANSFER_UPLOAD_LIMIT_KBPS_SECURE_STORE_KEY, null)
}

export function useDownloadLimitKbps(): [number | null, (next: number | null | ((prev: number | null) => number | null)) => void] {
	return useSecureStore<number | null>(TRANSFER_DOWNLOAD_LIMIT_KBPS_SECURE_STORE_KEY, null)
}
