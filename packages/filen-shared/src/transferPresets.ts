// Five-tier transfer performance ladder, plus a custom chunk count (TransferPerformanceChoice). The names are shared by every Filen client, so a preset means
// the same intent everywhere; TRANSFER_PRESET_VALUES holds mobile's numbers, kept low by the iOS
// file-descriptor ceiling, and DESKTOP_WEB_TRANSFER_PRESET_VALUES holds the web's and the desktop shell's.
// concurrency caps the SDK's in-flight chunk transfers (every other request gets 4 more places), memoryMib is its
// file-IO chunk-buffer budget.
// The streaming read-ahead window is capped at budget/2 and floored at one encrypted chunk (~1 MiB), so
// the 4 MiB minimum keeps a >= 2 MiB window.
export const TRANSFER_PERFORMANCE_PRESETS = ["slowConnection", "batterySaver", "balanced", "performance", "maximum"] as const

export type TransferPerformancePreset = (typeof TRANSFER_PERFORMANCE_PRESETS)[number]

export const DEFAULT_TRANSFER_PERFORMANCE_PRESET: TransferPerformancePreset = "balanced"

// What a user picks: a preset, or "custom" with a chunk count of their own (at most the app's maximum preset's).
export const TRANSFER_PERFORMANCE_CHOICES = [...TRANSFER_PERFORMANCE_PRESETS, "custom"] as const

export type TransferPerformanceChoice = (typeof TRANSFER_PERFORMANCE_CHOICES)[number]

// A custom choice's buffer never drops below 4 chunks (4 MiB on mobile), so a download's read-ahead keeps 2.
const MIN_BUFFER_CHUNKS = 4

export const TRANSFER_PRESET_VALUES: Record<TransferPerformancePreset, { concurrency: number; memoryMib: number }> = {
	slowConnection: { concurrency: 2, memoryMib: 4 },
	batterySaver: { concurrency: 4, memoryMib: 4 },
	balanced: { concurrency: 8, memoryMib: 8 },
	performance: { concurrency: 16, memoryMib: 16 },
	maximum: { concurrency: 32, memoryMib: 32 }
}

// One full chunk as the SDK's file-IO budget counts it: 1 MiB of data plus the 28-byte encryption overhead, so a
// budget of N of these buys exactly N chunks, not N - 1.
export const FULL_CHUNK_BYTES = 1024 * 1024 + 28

// The web's ladder, also used by the desktop shell's sync and transfer clients (a browser tab or a desktop process has
// no iOS file-descriptor ceiling). chunks: the file-IO budget, in full chunks (budget = chunks * FULL_CHUNK_BYTES).
// concurrency: the cap on in-flight chunk transfers; the SDK keeps four request slots beyond it (and a pool of its own
// for locks), so listings still get requests while transfers fill the budget. rateLimitPerSec: requests started per
// second across the whole client; the SDK's own 64 would cap transfers near 64 MiB/s on every preset above battery saver.
export const DESKTOP_WEB_TRANSFER_PRESET_VALUES: Record<
	TransferPerformancePreset,
	{ chunks: number; concurrency: number; rateLimitPerSec: number }
> = {
	slowConnection: { chunks: 4, concurrency: 2, rateLimitPerSec: 64 },
	batterySaver: { chunks: 8, concurrency: 12, rateLimitPerSec: 64 },
	balanced: { chunks: 32, concurrency: 48, rateLimitPerSec: 160 },
	performance: { chunks: 64, concurrency: 96, rateLimitPerSec: 320 },
	maximum: { chunks: 128, concurrency: 160, rateLimitPerSec: 640 }
}

// The largest custom chunk count each ladder allows: its maximum preset's.
export const MOBILE_CUSTOM_CONCURRENCY_MAX = TRANSFER_PRESET_VALUES.maximum.concurrency
export const DESKTOP_WEB_CUSTOM_CONCURRENCY_MAX = DESKTOP_WEB_TRANSFER_PRESET_VALUES.maximum.concurrency

// A stored custom count made whole and kept within 1 and max; anything that is no number becomes the fallback.
export function clampCustomConcurrency(value: unknown, max: number, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(1, Math.round(value))) : fallback
}

// The values a choice stands for. Custom: exactly `customConcurrency` chunks in flight, a buffer of at least as many
// chunks, and the request rate of the lowest preset that allows that many.
export function mobileTransferValues(
	choice: TransferPerformanceChoice,
	customConcurrency: number
): { concurrency: number; memoryMib: number } {
	if (choice !== "custom") {
		return TRANSFER_PRESET_VALUES[choice]
	}

	const concurrency = clampCustomConcurrency(customConcurrency, MOBILE_CUSTOM_CONCURRENCY_MAX, MOBILE_CUSTOM_CONCURRENCY_MAX)

	return { concurrency, memoryMib: Math.max(MIN_BUFFER_CHUNKS, concurrency) }
}

export function desktopWebTransferValues(
	choice: TransferPerformanceChoice,
	customConcurrency: number
): { chunks: number; concurrency: number; rateLimitPerSec: number } {
	if (choice !== "custom") {
		return DESKTOP_WEB_TRANSFER_PRESET_VALUES[choice]
	}

	const concurrency = clampCustomConcurrency(customConcurrency, DESKTOP_WEB_CUSTOM_CONCURRENCY_MAX, DESKTOP_WEB_CUSTOM_CONCURRENCY_MAX)
	const covering =
		TRANSFER_PERFORMANCE_PRESETS.find(preset => DESKTOP_WEB_TRANSFER_PRESET_VALUES[preset].concurrency >= concurrency) ?? "maximum"

	return {
		chunks: Math.max(MIN_BUFFER_CHUNKS, concurrency),
		concurrency,
		rateLimitPerSec: DESKTOP_WEB_TRANSFER_PRESET_VALUES[covering].rateLimitPerSec
	}
}
