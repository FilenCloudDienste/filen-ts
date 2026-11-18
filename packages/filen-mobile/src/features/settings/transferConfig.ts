import secureStore, { useSecureStore } from "@/lib/secureStore"
import { LogLevel, type JsClientConfig } from "@filen/sdk-rs"
import {
	TRANSFER_PERFORMANCE_PRESETS,
	type TransferPerformancePreset,
	DEFAULT_TRANSFER_PERFORMANCE_PRESET,
	TRANSFER_PRESET_VALUES
} from "@filen/shared"

export const TRANSFER_PERFORMANCE_PRESET_SECURE_STORE_KEY = "transfers.performancePreset"
export const TRANSFER_UPLOAD_LIMIT_KBPS_SECURE_STORE_KEY = "transfers.uploadLimitKbps"
export const TRANSFER_DOWNLOAD_LIMIT_KBPS_SECURE_STORE_KEY = "transfers.downloadLimitKbps"

// API request-rate governor (requests/sec). Not user-tunable — pinned to today's value.
export const SDK_RATE_LIMIT_PER_SEC = 128

const MIB = 1024 * 1024

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

// concurrency (from TRANSFER_PRESET_VALUES) caps the SDK's in-flight chunk transfers; every other
// request (listings, renames, upload/done, bulk calls) has 4 more places chunks never take, so the
// client holds at most concurrency + 4 requests (plus lock requests) at once. Under HTTP/1.1 each
// in-flight request tends to hold its own socket = one file descriptor, and the SAME client backs the
// localhost video HTTP provider — so the chunk cap is shared between bulk transfers and video
// streaming. iOS's default file-descriptor soft limit is low (historically 256), and the provider +
// SQLite + the expo-image disk cache all draw from the same table; the previous top presets (224/256)
// could exhaust it → EMFILE surfacing as "could not load this file" + choppy / slow video. The ladder
// is deliberately conservative (4/8/16/32) — even "maximum" (32, 36 requests with the headroom) sits
// at 2× the SDK's own default (16) and leaves a huge FD margin on iOS,
// prioritising reliable video streaming over peak bulk-transfer parallelism. maxParallelRequests /
// maxIoMemoryUsage below are mirrored (no consumer found in the pinned SDK, but set to avoid any
// regression — see the design doc).
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
		fileIoMemoryBudget: resolved.fileIoMemoryBudget,
		// Left undefined on purpose: the app's own thumbnail pipeline runs under the SDK's defaults —
		// 64 MiB per decode, 64 MiB max source, 2 concurrent decodes — and since every image thumbnail
		// is now an SDK decode (remote or from a local path), those defaults really are the single
		// source of truth for an app process. Only the video frame still goes through the manipulator,
		// which decodes whole images through UIImage/Glide, far above that. The provider extensions
		// receive an explicit per-host budget through auth.json (fileProvider.ts).
		thumbnailMemBudget: undefined,
		thumbnailMaxSourceBytes: undefined,
		thumbnailDecodeConcurrency: undefined,
		// The app runs no archive jobs: the platform defaults (one job at a time on mobile) stay.
		archiveCodecMemBudget: undefined,
		archiveJobConcurrency: undefined,
		// The app opens no archive readers: the platform default (64 MiB on iOS and Android) stays.
		archiveRetainedBudget: undefined,
		// The SDK's 5 ms default: concurrent calls to a route with a bulk twin go out as one request
		// (fewer API requests for bulk actions); the first call of a burst is never delayed.
		batchWindowMs: undefined
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
