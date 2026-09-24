// Storage-usage warning tier — mirrors mobile's segmented storage bar (green under 75%, yellow
// 75-90%, red 90%+ of quota used). Consumers (web's storageMeter.tsx sidebar meter,
// storageBreakdownCard.tsx's files segment; mobile's storageUsageBar.tsx) color themselves by this
// tier rather than each hardcoding its own threshold.
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
// decides.
export async function resolveQuotaVerdict(deps: QuotaCheckDeps, neededBytes: bigint): Promise<QuotaVerdict> {
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
