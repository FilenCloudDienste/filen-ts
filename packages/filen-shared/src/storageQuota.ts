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
