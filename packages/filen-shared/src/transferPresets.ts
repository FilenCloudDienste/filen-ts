// Four-tier transfer performance ladder. The names are shared by every Filen client, so a preset means
// the same intent everywhere; TRANSFER_PRESET_VALUES holds mobile's numbers, kept low by the iOS
// file-descriptor ceiling, and the web keeps a ladder of its own. concurrency is the SDK's global
// in-flight HTTP request cap, memoryMib its file-IO chunk-buffer budget. The streaming read-ahead window
// is capped at budget/2 and floored at one encrypted chunk (~1 MiB), so the 4 MiB minimum keeps a >= 2 MiB
// window.
export const TRANSFER_PERFORMANCE_PRESETS = ["batterySaver", "balanced", "performance", "maximum"] as const

export type TransferPerformancePreset = (typeof TRANSFER_PERFORMANCE_PRESETS)[number]

export const DEFAULT_TRANSFER_PERFORMANCE_PRESET: TransferPerformancePreset = "balanced"

export const TRANSFER_PRESET_VALUES: Record<TransferPerformancePreset, { concurrency: number; memoryMib: number }> = {
	batterySaver: { concurrency: 4, memoryMib: 4 },
	balanced: { concurrency: 8, memoryMib: 8 },
	performance: { concurrency: 16, memoryMib: 16 },
	maximum: { concurrency: 32, memoryMib: 32 }
}
