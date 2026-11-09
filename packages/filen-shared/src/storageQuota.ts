import { formatBytes } from "./misc"

// Storage-usage warning tier — mirrors mobile's segmented storage bar (green under 75%, yellow
// 75-90%, red 90%+ of quota used). Consumers (web's storageMeter.tsx sidebar meter and account storage
// bars; mobile's storageUsageBar.tsx) color themselves by this tier rather than each hardcoding its own
// threshold.
export type StorageUsageLevel = "ok" | "warn" | "critical"

const WARN_THRESHOLD_PERCENT = 75
const CRITICAL_THRESHOLD_PERCENT = 90

export function storageUsageLevel(usedPercent: number): StorageUsageLevel {
	if (usedPercent >= CRITICAL_THRESHOLD_PERCENT) {
		return "critical"
	}

	if (usedPercent >= WARN_THRESHOLD_PERCENT) {
		return "warn"
	}

	return "ok"
}

// The account's storage figures, shaped alike on every SDK surface.
export interface StorageCounters {
	storageUsed: bigint
	maxStorage: bigint
}

// Null when the quota isn't resolvable (maxStorage <= 0). Floors at 0: a plan downgrade can leave
// storageUsed above maxStorage.
export function freeBytes(info: StorageCounters): bigint | null {
	if (info.maxStorage <= 0n) {
		return null
	}

	const free = info.maxStorage - info.storageUsed

	return free > 0n ? free : 0n
}

// The account's quota split into files / versioned / free, which always sum to maxBytes. Used is clamped
// to the quota (a plan downgrade can report more) and versioned to used (both are independent reads, so a
// racing versioned figure must not drive files negative). An unresolvable quota (maxStorage <= 0) zeros
// every segment.
export interface StorageBreakdown {
	usedBytes: bigint
	maxBytes: bigint
	filesBytes: bigint
	versionedBytes: bigint
	freeBytes: bigint
}

export function deriveStorageBreakdown(storageUsed: bigint, maxStorage: bigint, versionedStorage: bigint): StorageBreakdown {
	if (maxStorage <= 0n) {
		return { usedBytes: storageUsed, maxBytes: maxStorage, filesBytes: 0n, versionedBytes: 0n, freeBytes: 0n }
	}

	const usedClamped = storageUsed >= maxStorage ? maxStorage : storageUsed < 0n ? 0n : storageUsed
	const versionedClamped = versionedStorage >= usedClamped ? usedClamped : versionedStorage < 0n ? 0n : versionedStorage

	return {
		usedBytes: usedClamped,
		maxBytes: maxStorage,
		filesBytes: usedClamped - versionedClamped,
		versionedBytes: versionedClamped,
		freeBytes: maxStorage - usedClamped
	}
}

// The server refuses any non-empty upload once storageUsed reaches maxStorage, so an exact fill is
// already over the limit. An unresolvable quota (maxStorage <= 0) is never over it.
export function isStorageOverLimit(info: StorageCounters): boolean {
	return info.maxStorage > 0n && info.storageUsed >= info.maxStorage
}

export type QuotaVerdict = { status: "fits" } | { status: "exceeds"; neededBytes: bigint; freeBytes: bigint } | { status: "unknown" }

export function quotaVerdict(neededBytes: bigint, info: StorageCounters | undefined): QuotaVerdict {
	const free = info === undefined ? null : freeBytes(info)

	if (free === null) {
		return { status: "unknown" }
	}

	return neededBytes <= free ? { status: "fits" } : { status: "exceeds", neededBytes, freeBytes: free }
}

export function sumBytes(sizes: readonly (number | bigint)[]): bigint {
	let total = 0n

	for (const size of sizes) {
		total += BigInt(size)
	}

	return total
}

export interface QuotaCheckDeps {
	cached: () => StorageCounters | undefined
	fetchFresh: () => Promise<StorageCounters>
	// Whether the cached figure is recent enough to answer from; left out, a cached figure of any age is.
	isCachedFresh?: () => boolean
}

// A fresh cached "fits" is trusted as is. A cached "exceeds" may predate a delete made elsewhere, and a
// stale or missing cache proves nothing, so those read once fresh. "unknown" never blocks: the server
// decides. Nothing to store always fits: empty files are not counted against the quota, and a fresh
// read could not change that.
export async function resolveQuotaVerdict(deps: QuotaCheckDeps, neededBytes: bigint): Promise<QuotaVerdict> {
	if (neededBytes <= 0n) {
		return { status: "fits" }
	}

	const cached = deps.cached()
	const cachedVerdict = quotaVerdict(neededBytes, cached)

	if (cached !== undefined && cachedVerdict.status !== "exceeds" && (deps.isCachedFresh?.() ?? true)) {
		return cachedVerdict
	}

	try {
		return quotaVerdict(neededBytes, await deps.fetchFresh())
	} catch {
		return { status: "unknown" }
	}
}

// The storage figures in words, as the assistant's get_storage reports them: used, total and free as the
// meter shows them, and what old file versions take.
export function storageSummary({
	storageUsed,
	maxStorage,
	versionedStorage
}: StorageCounters & { versionedStorage: bigint }): Record<string, string | number> {
	if (maxStorage <= 0n) {
		return { used: formatBytes(Number(storageUsed)), note: "The storage quota is not known" }
	}

	const breakdown = deriveStorageBreakdown(storageUsed, maxStorage, versionedStorage)

	return {
		used: formatBytes(Number(storageUsed)),
		total: formatBytes(Number(maxStorage)),
		free: formatBytes(Number(breakdown.freeBytes)),
		usedPercent: Math.round((Number(storageUsed) / Number(maxStorage)) * 100),
		versions: formatBytes(Number(breakdown.versionedBytes))
	}
}
