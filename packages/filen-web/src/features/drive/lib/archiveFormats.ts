import type { AesStrength, CompressFormat, SevenZMethod, StreamCodec, ZipMethod } from "@filen/sdk-rs"
import type { ArchiveKey } from "@/lib/i18n"
import type { ArchiveFormatInfo } from "@/workers/sdk.worker"

// The formats the compress UI offers, with their static words. Levels, the highest level the codec
// memory allows, encoder memory and the real extension come from the SDK (archiveHelpers.ts).

export type FormatChoiceId =
	| "zip"
	| "7z"
	| "tar.gz"
	| "tar.xz"
	| "tar.zst"
	| "tar"
	| "tar.bz2"
	| "tar.lz4"
	| "tar.br"
	| "tar.lz"
	| "tar.lzma"
	| "gz"
	| "bz2"
	| "xz"
	| "lzma"
	| "lz"
	| "lz4"
	| "br"
	| "zst"

export type FormatGroup = "common" | "more" | "single"

export type ZipMethodId = ZipMethod["type"]

export type SevenZMethodId = SevenZMethod["type"]

export interface FormatChoice {
	id: FormatChoiceId
	group: FormatGroup
	family: "zip" | "sevenZ" | "tar" | "single"
	codec: StreamCodec | null
	labelKey: ArchiveKey
	hintKey: ArchiveKey
	// For display only; a name gets ArchiveFormatInfo.extension.
	displayExtension: string
	encryptable: boolean
}

function tarChoice(
	id: FormatChoiceId,
	group: FormatGroup,
	codec: StreamCodec | null,
	labelKey: ArchiveKey,
	hintKey: ArchiveKey
): FormatChoice {
	return { id, group, family: "tar", codec, labelKey, hintKey, displayExtension: `.${id}`, encryptable: false }
}

function singleChoice(id: FormatChoiceId, codec: StreamCodec, labelKey: ArchiveKey, hintKey: ArchiveKey): FormatChoice {
	return { id, group: "single", family: "single", codec, labelKey, hintKey, displayExtension: `.${id}`, encryptable: false }
}

export const FORMAT_CHOICES: readonly FormatChoice[] = [
	{
		id: "zip",
		group: "common",
		family: "zip",
		codec: null,
		labelKey: "archiveFormatZip",
		hintKey: "archiveFormatZipHint",
		displayExtension: ".zip",
		encryptable: true
	},
	{
		id: "7z",
		group: "common",
		family: "sevenZ",
		codec: null,
		labelKey: "archiveFormatSevenZ",
		hintKey: "archiveFormatSevenZHint",
		displayExtension: ".7z",
		encryptable: true
	},
	tarChoice("tar.gz", "common", "gzip", "archiveFormatTarGz", "archiveFormatTarGzHint"),
	tarChoice("tar.xz", "common", "xz", "archiveFormatTarXz", "archiveFormatTarXzHint"),
	tarChoice("tar.zst", "common", "zstd", "archiveFormatTarZst", "archiveFormatTarZstHint"),
	tarChoice("tar", "more", null, "archiveFormatTar", "archiveFormatTarHint"),
	tarChoice("tar.bz2", "more", "bzip2", "archiveFormatTarBz2", "archiveFormatTarBz2Hint"),
	tarChoice("tar.lz4", "more", "lz4", "archiveFormatTarLz4", "archiveFormatTarLz4Hint"),
	tarChoice("tar.br", "more", "brotli", "archiveFormatTarBr", "archiveFormatTarBrHint"),
	tarChoice("tar.lz", "more", "lzip", "archiveFormatTarLz", "archiveFormatTarLzHint"),
	tarChoice("tar.lzma", "more", "lzma", "archiveFormatTarLzma", "archiveFormatTarLzmaHint"),
	singleChoice("gz", "gzip", "archiveFormatGz", "archiveFormatGzHint"),
	singleChoice("bz2", "bzip2", "archiveFormatBz2", "archiveFormatBz2Hint"),
	singleChoice("xz", "xz", "archiveFormatXz", "archiveFormatXzHint"),
	singleChoice("lzma", "lzma", "archiveFormatLzma", "archiveFormatLzmaHint"),
	singleChoice("lz", "lzip", "archiveFormatLz", "archiveFormatLzHint"),
	singleChoice("lz4", "lz4", "archiveFormatLz4", "archiveFormatLz4Hint"),
	singleChoice("br", "brotli", "archiveFormatBr", "archiveFormatBrHint"),
	singleChoice("zst", "zstd", "archiveFormatZst", "archiveFormatZstHint")
]

const CHOICES_BY_ID: ReadonlyMap<FormatChoiceId, FormatChoice> = new Map(FORMAT_CHOICES.map(choice => [choice.id, choice]))

export function formatChoice(id: FormatChoiceId): FormatChoice {
	const choice = CHOICES_BY_ID.get(id)

	if (choice === undefined) {
		throw new Error(`unknown archive format ${id}`)
	}

	return choice
}

const CHOICE_IDS: ReadonlySet<string> = new Set(CHOICES_BY_ID.keys())

export function isFormatChoiceId(value: string): value is FormatChoiceId {
	return CHOICE_IDS.has(value)
}

export const PRESET_FORMATS = ["zip", "7z", "tar.gz"] as const

export type PresetFormat = (typeof PRESET_FORMATS)[number]

export const ZIP_METHODS: readonly ZipMethodId[] = ["stored", "deflate", "bzip2"]

export const SEVENZ_METHODS: readonly SevenZMethodId[] = ["lzma2", "lzma", "ppmd", "bzip2", "deflate", "copy"]

export const AES_STRENGTHS: readonly AesStrength[] = ["aes128", "aes192", "aes256"]

// 7-Zip's own default for the names is off; hiding them is the private choice.
export const DEFAULTS = { zipMethod: "deflate", sevenZMethod: "lzma2", solid: true, aes: "aes256", encryptNames: true } as const

// A level every leveled ZIP and 7-Zip method takes; the SDK's level ranges and memory ignore the
// format's own level, so it stands in until one is picked.
const PROBE_LEVEL = 1

// The single-file group only when exactly one file is selected.
export function choicesFor(selection: { singleFile: boolean }): FormatChoice[] {
	return selection.singleFile ? [...FORMAT_CHOICES] : FORMAT_CHOICES.filter(choice => choice.group !== "single")
}

function isZipMethod(method: ZipMethodId | SevenZMethodId | undefined): method is ZipMethodId {
	return method !== undefined && (ZIP_METHODS as readonly string[]).includes(method)
}

function isSevenZMethod(method: ZipMethodId | SevenZMethodId | undefined): method is SevenZMethodId {
	return method !== undefined && (SEVENZ_METHODS as readonly string[]).includes(method)
}

// What the UI shows a slider for; the slider's range itself is the SDK's.
export function hasLevels(choice: FormatChoiceId, method: ZipMethodId | SevenZMethodId | null): boolean {
	switch (formatChoice(choice).family) {
		case "zip":
			return method !== "stored"
		case "sevenZ":
			return method !== "copy"
		case "tar":
			return choice !== "tar"
		case "single":
			return true
	}
}

function zipMethod(id: ZipMethodId, level: number): ZipMethod {
	return id === "stored" ? { type: "stored" } : { type: id, level }
}

function sevenZMethod(id: SevenZMethodId, level: number): SevenZMethod {
	return id === "copy" ? { type: "copy" } : { type: id, level }
}

function streamFormat(choice: FormatChoice, level: number | null): CompressFormat {
	const { codec } = choice

	if (codec === null) {
		return { type: "tar" }
	}

	const compression = level === null ? { codec } : { codec, level }

	return choice.family === "single" ? { type: "single", compression } : { type: "tar", compression }
}

// Level-agnostic and unencrypted: what ArchiveFormatInfo is asked for.
export function probeFormat(choice: FormatChoiceId, method?: ZipMethodId | SevenZMethodId): CompressFormat {
	const entry = formatChoice(choice)

	switch (entry.family) {
		case "zip":
			return { type: "zip", method: zipMethod(isZipMethod(method) ? method : DEFAULTS.zipMethod, PROBE_LEVEL) }
		case "sevenZ":
			return {
				type: "sevenZ",
				method: sevenZMethod(isSevenZMethod(method) ? method : DEFAULTS.sevenZMethod, PROBE_LEVEL),
				solid: DEFAULTS.solid
			}
		default:
			return streamFormat(entry, null)
	}
}

// A format without levels is returned as it is.
export function withLevel(format: CompressFormat, level: number): CompressFormat {
	switch (format.type) {
		case "tar":
			return format.compression === undefined ? format : { ...format, compression: { ...format.compression, level } }
		case "single":
			return { ...format, compression: { ...format.compression, level } }
		case "zip":
			return { ...format, method: zipMethod(format.method.type, level) }
		case "sevenZ":
			return { ...format, method: sevenZMethod(format.method.type, level) }
	}
}

// null for a format without levels; else the wanted level (the SDK's default when none) kept within
// what the codec memory runs.
export function effectiveLevel(info: ArchiveFormatInfo, wanted: number | null): number | null {
	if (info.levels === null) {
		return null
	}

	const highest = info.maxLevel ?? info.levels.min

	return Math.min(Math.max(wanted ?? info.levels.defaultLevel, info.levels.min), highest)
}

// Not even the lowest level fits the codec memory.
export function isFormatRunnable(info: ArchiveFormatInfo): boolean {
	return info.levels === null || info.maxLevel !== null
}

export interface FormatOptions {
	level: number | null
	zipMethod: ZipMethodId
	sevenZMethod: SevenZMethodId
	solid: boolean
	aes: AesStrength
	encryptNames: boolean
}

function requireLevel(level: number | null, choice: FormatChoiceId): number {
	if (level === null) {
		throw new Error(`archive format ${choice} needs a level`)
	}

	return level
}

// `options.level` is effectiveLevel's; a method that takes a level must have one. `encrypted` is
// ignored for a format that cannot hold a password.
export function buildCompressFormat(choice: FormatChoiceId, options: FormatOptions, encrypted: boolean): CompressFormat {
	const entry = formatChoice(choice)

	switch (entry.family) {
		case "zip": {
			const method: ZipMethod =
				options.zipMethod === "stored"
					? { type: "stored" }
					: { type: options.zipMethod, level: requireLevel(options.level, choice) }

			return encrypted ? { type: "zip", method, encryption: options.aes } : { type: "zip", method }
		}
		case "sevenZ": {
			const method: SevenZMethod =
				options.sevenZMethod === "copy"
					? { type: "copy" }
					: { type: options.sevenZMethod, level: requireLevel(options.level, choice) }

			return encrypted
				? { type: "sevenZ", method, solid: options.solid, encryption: options.encryptNames ? "entriesAndHeaders" : "entries" }
				: { type: "sevenZ", method, solid: options.solid }
		}
		default:
			return streamFormat(entry, options.level)
	}
}

// The last extension of every name the SDK reads as an archive (filen-sdk-rs fs/archive/format.rs,
// EXTENSIONS): each multi-part one (".tar.gz") ends in one of these too. Lowercase, without the dot.
export const ARCHIVE_NAME_EXTENSIONS: ReadonlySet<string> = new Set([
	"zip",
	"7z",
	"tar",
	"tgz",
	"tbz",
	"tbz2",
	"txz",
	"tlz",
	"tzst",
	"gz",
	"bz2",
	"xz",
	"lzma",
	"lz",
	"lz4",
	"br",
	"zst"
])

// Whether to offer Extract: a string lookup, no SDK call. The SDK's archiveNameInfo, and the archive's
// own bytes when it is read, decide what it is. As the SDK, the extension needs a name before it:
// ".zip" alone is no archive's name.
export function isArchiveCandidateName(name: string): boolean {
	const dot = name.lastIndexOf(".")

	return dot > 0 && ARCHIVE_NAME_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}
