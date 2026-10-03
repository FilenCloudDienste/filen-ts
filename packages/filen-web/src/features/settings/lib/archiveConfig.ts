import { type, type Type } from "arktype"
import type { JsClientConfig } from "@filen/sdk-rs"
import { kvPreference } from "@/lib/storage/preference"

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

export function buildArchiveClientConfig(prefs: ArchivePreferences): JsClientConfig {
	return {
		archiveCodecMemBudget: prefs.codecMemoryMib * MIB
	}
}
