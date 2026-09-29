import { clampedRatio, type StorageUsageLevel } from "@filen/shared"

// Pure derivation for the Account section's storage breakdown row — mirrors old-web's
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

// Percent helper for the three segment widths, taking the breakdown's bigints.
export function storagePercent(part: bigint, total: bigint): number {
	return clampedRatio(Number(part), Number(total), 100)
}

// The used-space fill (never "versioned", which stays a fixed neutral color, or "free") warns/alerts
// by overall usage — mirrors mobile's segmented storage bar, where only the used-space fill changes
// color near quota. Shared by the storage breakdown row and the Account profile header's compact bar.
export const STORAGE_LEVEL_FILL_CLASS: Record<StorageUsageLevel, string> = {
	ok: "bg-chart-1",
	warn: "bg-yellow-500",
	critical: "bg-destructive"
}
