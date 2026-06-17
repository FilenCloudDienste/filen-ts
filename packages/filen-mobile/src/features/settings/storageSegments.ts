// Pure storage-usage math for the More-screen account header bar. From UserInfo (useAccountQuery):
// storageUsed is the TOTAL used (files + versioned), versionedStorage is the versioned-files subset,
// maxStorage is the quota. So Files = used - versioned, Free = max - used. Values returned as numbers
// (bytes) for flex weights + formatBytes; clamped so a malformed payload can't produce NaN/negatives.

export type StorageLevel = "ok" | "warn" | "critical"

export type StorageSegments = {
	files: number
	versioned: number
	free: number
	usedFraction: number
	level: StorageLevel
}

const WARN_FRACTION = 0.75
const CRITICAL_FRACTION = 0.9

export function computeStorageSegments(storageUsed: bigint, versionedStorage: bigint, maxStorage: bigint): StorageSegments {
	const used = Math.max(0, Number(storageUsed))
	const max = Math.max(0, Number(maxStorage))
	// Versioned is a subset of used — clamp so it can never exceed it (would yield negative Files).
	const versioned = Math.min(Math.max(0, Number(versionedStorage)), used)

	const files = Math.max(0, used - versioned)
	const free = Math.max(0, max - used)
	const usedFraction = max > 0 ? Math.min(1, used / max) : 0
	const level: StorageLevel = usedFraction >= CRITICAL_FRACTION ? "critical" : usedFraction >= WARN_FRACTION ? "warn" : "ok"

	return {
		files,
		versioned,
		free,
		usedFraction,
		level
	}
}
