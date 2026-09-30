import { clampedRatio, type StorageUsageLevel } from "@filen/shared"

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
