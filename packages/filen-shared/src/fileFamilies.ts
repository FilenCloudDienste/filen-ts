// Format facts per extension that more than one app or worker reads. Each app keeps its own category tables and derives
// them from these rows.

export interface AudioFormat {
	// Rendered by a synthesizer rather than decoded from samples.
	synth?: "midi" | "module"
	// No browser plays it as it is: the remux worker decodes it.
	decoded?: true
	// Largest file the preview opens, below the category's own limits.
	cap?: bigint
}

// Every audio extension the apps play, one row each.
export const AUDIO_FORMATS: ReadonlyMap<string, AudioFormat> = new Map<string, AudioFormat>([
	["mp3", {}],
	["m4a", {}],
	["m4b", {}],
	["aac", {}],
	["wav", {}],
	["ogg", {}],
	["oga", {}],
	["weba", {}],
	["flac", {}],
	["opus", {}],
	// AIFF and CAF play natively in Safari; elsewhere they fail.
	["aiff", {}],
	["aif", {}],
	["caf", {}],
	// Matroska audio (never played direct) and bare AC-3, E-AC-3 and DTS streams.
	["mka", { decoded: true }],
	["ac3", { decoded: true }],
	["eac3", { decoded: true }],
	["ec3", { decoded: true }],
	["dts", { decoded: true }]
])

// Subtitle files a text editor reads as they are (videos/sidecars.ts names their formats). Image-based tracks (VobSub,
// PGS) and the ambiguous `.sub` are not text.
export const SUBTITLE_FILE_EXTENSIONS: ReadonlySet<string> = new Set(["srt", "vtt", "ass", "ssa", "smi", "sami"])

// Application and library packages that are zip archives under their own extension: browsed and extracted as zips.
export const ZIP_PACKAGE_EXTENSIONS: ReadonlySet<string> = new Set([
	"apk",
	"aab",
	"aar",
	"ipa",
	"jar",
	"war",
	"ear",
	"xpi",
	"whl",
	"nupkg",
	"vsix",
	"appx",
	"msix"
])
