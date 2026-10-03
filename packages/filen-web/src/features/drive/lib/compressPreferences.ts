import { type, type Type } from "arktype"
import type { AesStrength } from "@filen/sdk-rs"
import { kvPreference } from "@/lib/storage/preference"
import {
	AES_STRENGTHS,
	DEFAULTS,
	FORMAT_CHOICES,
	SEVENZ_METHODS,
	ZIP_METHODS,
	formatChoice,
	type FormatChoiceId,
	type FormatOptions,
	type SevenZMethodId,
	type ZipMethodId
} from "@/features/drive/lib/archiveFormats"

// The options a compress was last run with, per format: what the dialog opens on and the presets run
// with. Never a password, what happens to the originals or a destination. A stored level is clamped
// again when used (effectiveLevel), as the codec memory may have changed since.

export interface CompressPreferences {
	// What the dialog opens on.
	format: FormatChoiceId
	zip: { method: ZipMethodId; level: number | null; aes: AesStrength }
	sevenZ: { method: SevenZMethodId; level: number | null; solid: boolean; encryptNames: boolean }
	// Tarballs with a codec and single files, by format id.
	levels: Record<string, number>
}

export const DEFAULT_COMPRESS_PREFERENCES: CompressPreferences = {
	format: "zip",
	zip: { method: DEFAULTS.zipMethod, level: null, aes: DEFAULTS.aes },
	sevenZ: { method: DEFAULTS.sevenZMethod, level: null, solid: DEFAULTS.solid, encryptNames: DEFAULTS.encryptNames },
	levels: {}
}

// The ids `levels` holds: the stream codecs, whose level is the codec's.
const STREAM_LEVEL_IDS: ReadonlySet<string> = new Set(FORMAT_CHOICES.filter(choice => choice.codec !== null).map(choice => choice.id))

const levelSchema = type("number.integer | null")

const compressPreferencesSchema: Type<CompressPreferences> = type({
	format: type.enumerated(...FORMAT_CHOICES.map(choice => choice.id)),
	zip: { method: type.enumerated(...ZIP_METHODS), level: levelSchema, aes: type.enumerated(...AES_STRENGTHS) },
	sevenZ: { method: type.enumerated(...SEVENZ_METHODS), level: levelSchema, solid: "boolean", encryptNames: "boolean" },
	levels: { "[string]": "number.integer" }
})

// Rebuilt field by field, so nothing a caller added (or an older build stored) is kept.
function normalizeCompressPreferences(prefs: CompressPreferences): CompressPreferences {
	return {
		format: prefs.format,
		zip: { method: prefs.zip.method, level: prefs.zip.level, aes: prefs.zip.aes },
		sevenZ: {
			method: prefs.sevenZ.method,
			level: prefs.sevenZ.level,
			solid: prefs.sevenZ.solid,
			encryptNames: prefs.sevenZ.encryptNames
		},
		levels: Object.fromEntries(Object.entries(prefs.levels).filter(([id]) => STREAM_LEVEL_IDS.has(id)))
	}
}

const stored = kvPreference({
	key: "drive.compressPreferences.v1",
	schema: compressPreferencesSchema,
	fallback: DEFAULT_COMPRESS_PREFERENCES,
	normalize: normalizeCompressPreferences
})

let loaded: Promise<CompressPreferences> | undefined

// Read once a page; a write replaces the memo.
export function loadCompressPreferences(): Promise<CompressPreferences> {
	if (loaded !== undefined) {
		return loaded
	}

	const reading = stored.get()

	loaded = reading

	reading.catch(() => {
		if (loaded === reading) {
			loaded = undefined
		}
	})

	return reading
}

export async function setCompressPreferences(next: CompressPreferences): Promise<void> {
	loaded = Promise.resolve(normalizeCompressPreferences(next))

	await stored.set(next)
}

// A null level is the SDK's default.
export function presetOptions(prefs: CompressPreferences, choice: FormatChoiceId): FormatOptions {
	const { family } = formatChoice(choice)

	return {
		level: family === "zip" ? prefs.zip.level : family === "sevenZ" ? prefs.sevenZ.level : (prefs.levels[choice] ?? null),
		zipMethod: prefs.zip.method,
		sevenZMethod: prefs.sevenZ.method,
		solid: prefs.sevenZ.solid,
		aes: prefs.zip.aes,
		encryptNames: prefs.sevenZ.encryptNames
	}
}

// Only what the format used changes; a method without levels keeps the level last picked.
export function nextCompressPreferences(
	prev: CompressPreferences,
	used: { choice: FormatChoiceId; options: FormatOptions }
): CompressPreferences {
	const { choice, options } = used
	const { family } = formatChoice(choice)

	switch (family) {
		case "zip":
			return {
				...prev,
				format: choice,
				zip: { method: options.zipMethod, level: options.level ?? prev.zip.level, aes: options.aes }
			}
		case "sevenZ":
			return {
				...prev,
				format: choice,
				sevenZ: {
					method: options.sevenZMethod,
					level: options.level ?? prev.sevenZ.level,
					solid: options.solid,
					encryptNames: options.encryptNames
				}
			}
		default:
			return {
				...prev,
				format: choice,
				levels: options.level === null || !STREAM_LEVEL_IDS.has(choice) ? prev.levels : { ...prev.levels, [choice]: options.level }
			}
	}
}
