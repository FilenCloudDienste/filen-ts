import { type, type Type } from "arktype"
import type { JsClientConfig } from "@filen/sdk-rs"
import { kvPreference } from "@/lib/storage/preference"
import { pdfMemoryConstrained } from "@/features/preview/lib/pdfLimits"

// Advanced settings → memory one archive job's codecs may use. Like the transfer preset, the wasm
// client reads it only when it is built, so a change applies at the next page load. Its own key, so a
// transfer preference stored before this existed never fails a widened schema.
const MIB = 1024 * 1024

export const ARCHIVE_CODEC_MEMORY_MIB = [64, 128, 256, 512] as const

export type ArchiveCodecMemoryMib = (typeof ARCHIVE_CODEC_MEMORY_MIB)[number]

export interface ArchivePreferences {
	codecMemoryMib: ArchiveCodecMemoryMib
}

// The SDK's own web default.
export const DEFAULT_ARCHIVE_PREFERENCES: ArchivePreferences = {
	codecMemoryMib: 128
}

const archivePreferencesSchema: Type<ArchivePreferences> = type({
	codecMemoryMib: type.enumerated(...ARCHIVE_CODEC_MEMORY_MIB)
})

export const { get: getArchivePreferences, set: setArchivePreferences } = kvPreference({
	key: "settings.archiveConfig.v1",
	schema: archivePreferencesSchema,
	fallback: DEFAULT_ARCHIVE_PREFERENCES
})

// What every archive reader keeps between its calls (indexes, chunks, decoder checkpoints), process-wide: the SDK's
// own 48 MiB for a browser, half on a phone or tablet, whose tab is killed far sooner. Past it a reader gives up the
// least recently used of what it holds and reads it again when next asked.
export const ARCHIVE_RETAINED_BUDGET_MIB = 48
export const MOBILE_ARCHIVE_RETAINED_BUDGET_MIB = 24

export function buildArchiveClientConfig(prefs: ArchivePreferences, mobile: boolean = pdfMemoryConstrained()): JsClientConfig {
	return {
		archiveCodecMemBudget: prefs.codecMemoryMib * MIB,
		archiveRetainedBudget: (mobile ? MOBILE_ARCHIVE_RETAINED_BUDGET_MIB : ARCHIVE_RETAINED_BUDGET_MIB) * MIB
	}
}
