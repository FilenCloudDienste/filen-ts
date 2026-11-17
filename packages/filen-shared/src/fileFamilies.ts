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

const MIB = 1024n * 1024n

// The largest file each synthesizer reads: it holds the file whole.
export const SYNTH_CAPS: Readonly<Record<NonNullable<AudioFormat["synth"]>, bigint>> = { midi: 4n * MIB, module: 32n * MIB }

const MIDI: AudioFormat = { synth: "midi", cap: SYNTH_CAPS.midi }
const TRACKER: AudioFormat = { synth: "module", cap: SYNTH_CAPS.module }

// Extensions libopenmpt reads that name other, commoner formats, which they keep: a Netpbm image, a 3D model, music
// notation or Doom's MUS, id's IMF, a self-extracting archive, a FAR archive, Mobile XMF. `mod` is no collision: a
// content read tells an MPEG program stream from a module.
export const TRACKER_COLLISIONS: ReadonlySet<string> = new Set(["ppm", "mdl", "mus", "imf", "sfx", "far", "xmf"])

// Extensions libopenmpt reads that files of other kinds commonly carry too: a STEP or AMF model, a debug-symbol bundle,
// a DBM database, an ACE comic archive, a terrain or surface model, a polynomial texture map, a Family Tree Maker
// file, an SELinux file context, a server-side include, and other programs' own data. Such a file is a tracker module
// only once a read of its head says so (fileKind's trackerModule read); until then it has no kind.
export const TRACKER_SNIFFED: ReadonlySet<string> = new Set([
	"amf",
	"ams",
	"cba",
	"dbm",
	"dmf",
	"dsm",
	"dsym",
	"dtm",
	"etx",
	"fc",
	"fmt",
	"fst",
	"ftm",
	"ice",
	"ims",
	"med",
	"mms",
	"psm",
	"ptm",
	"stm",
	"stp",
	"tcb",
	"wow"
])

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
	["dts", { decoded: true }],
	// Windows Media Audio, in ASF.
	["wma", { decoded: true }],
	// Bare MPEG audio of any layer: MP1 and MP2 only FFmpeg decodes.
	["mp2", { decoded: true }],
	["mpa", { decoded: true }],
	// MIDI songs, rendered with the bundled SoundFont; RMI is a song in a RIFF wrapper.
	["mid", MIDI],
	["midi", MIDI],
	["kar", MIDI],
	["rmi", MIDI],
	// Tracker modules: every format libopenmpt reads (filen-web's src/vendor/libopenmpt/extensions.json, which a test
	// keeps these rows equal to), but the TRACKER_COLLISIONS other formats use.
	["mptm", TRACKER],
	["mod", TRACKER],
	["s3m", TRACKER],
	["xm", TRACKER],
	["it", TRACKER],
	["667", TRACKER],
	["669", TRACKER],
	["amf", TRACKER],
	["ams", TRACKER],
	["c67", TRACKER],
	["cba", TRACKER],
	["dbm", TRACKER],
	["digi", TRACKER],
	["dmf", TRACKER],
	["dsm", TRACKER],
	["dsym", TRACKER],
	["dtm", TRACKER],
	["etx", TRACKER],
	["fc", TRACKER],
	["fc13", TRACKER],
	["fc14", TRACKER],
	["fmt", TRACKER],
	["fst", TRACKER],
	["ftm", TRACKER],
	["ims", TRACKER],
	["ice", TRACKER],
	["j2b", TRACKER],
	["m15", TRACKER],
	["med", TRACKER],
	["mms", TRACKER],
	["mt2", TRACKER],
	["mtm", TRACKER],
	["nst", TRACKER],
	["okt", TRACKER],
	["plm", TRACKER],
	["psm", TRACKER],
	["pt36", TRACKER],
	["ptm", TRACKER],
	["puma", TRACKER],
	["rtm", TRACKER],
	["sfx2", TRACKER],
	["smod", TRACKER],
	["st26", TRACKER],
	["stk", TRACKER],
	["stm", TRACKER],
	["stx", TRACKER],
	["stp", TRACKER],
	["symmod", TRACKER],
	["tcb", TRACKER],
	["gmc", TRACKER],
	["gtk", TRACKER],
	["gt2", TRACKER],
	["ult", TRACKER],
	["unic", TRACKER],
	["wow", TRACKER],
	["gdm", TRACKER],
	["mo3", TRACKER],
	["oxm", TRACKER],
	["umx", TRACKER],
	["xpk", TRACKER],
	["mmcmp", TRACKER]
])

// Subtitle files a text editor reads as they are (videos/sidecars.ts names their formats). Image-based tracks (VobSub,
// PGS) and the ambiguous `.sub` are not text.
export const SUBTITLE_FILE_EXTENSIONS: ReadonlySet<string> = new Set(["srt", "vtt", "ass", "ssa", "smi", "sami"])

// Application and library packages that are zip archives under their own extension: browsed and extracted as zips. A
// .crx is a zip behind a signed header, which the SDK skips.
export const ZIP_PACKAGE_EXTENSIONS: ReadonlySet<string> = new Set([
	"apk",
	"aab",
	"aar",
	"ipa",
	"jar",
	"war",
	"ear",
	"xpi",
	"crx",
	"whl",
	"nupkg",
	"vsix",
	"appx",
	"msix"
])
