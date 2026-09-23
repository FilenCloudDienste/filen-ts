import type { UserInfo } from "@filen/sdk-rs"

export type StorageCounters = Pick<UserInfo, "storageUsed" | "maxStorage">

// Null when the quota isn't resolvable (maxStorage <= 0, see storageBreakdown.ts). Floors at 0: a plan
// downgrade can leave storageUsed above maxStorage.
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
}

// A cached "fits" is trusted as is. A cached "exceeds" may predate a delete made elsewhere and a missing
// cache proves nothing, so only those read once fresh. "unknown" never blocks: the server decides.
export async function resolveQuotaVerdict(deps: QuotaCheckDeps, neededBytes: bigint): Promise<QuotaVerdict> {
	const cached = deps.cached()
	const cachedVerdict = quotaVerdict(neededBytes, cached)

	if (cachedVerdict.status === "fits" || (cached !== undefined && cachedVerdict.status === "unknown")) {
		return cachedVerdict
	}

	try {
		return quotaVerdict(neededBytes, await deps.fetchFresh())
	} catch {
		return { status: "unknown" }
	}
}
