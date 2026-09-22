// Pure derivation for the Account section's storage breakdown card — mirrors old-web's
// settings/general storage bar math (files / versioned / free) exactly: `usedClamped` never
// exceeds `maxStorage` (a plan downgrade can otherwise report >100% used), `filesBytes` excludes
// the versioned slice so the three segments always sum to `maxStorage`.
export interface StorageBreakdown {
	usedBytes: bigint
	maxBytes: bigint
	filesBytes: bigint
	versionedBytes: bigint
	freeBytes: bigint
}

// `maxStorage <= 0` means the account's quota isn't resolvable (mid-provisioning or a plan the API
// hasn't priced yet) — every derived field but the raw used/max pair zeros out rather than
// producing a negative or divide-by-zero segment. `versionedStorage` is defensively clamped to
// `usedClamped` too: both are independent live-API reads, and a stale/racing versioned figure that
// (however briefly) exceeds total usage must never drive `filesBytes` negative.
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

// Percent helper for the three segment widths — `total` guaranteed >0 by the caller (only called
// with `breakdown.maxBytes`, and the maxStorage<=0 branch above is rendered as an empty state
// rather than three zero-width segments, so this never has to guard a zero denominator itself).
export function storagePercent(part: bigint, total: bigint): number {
	if (total <= 0n) {
		return 0
	}

	const ratio = Number(part) / Number(total)

	return Math.min(100, Math.max(0, ratio * 100))
}
