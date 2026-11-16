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
