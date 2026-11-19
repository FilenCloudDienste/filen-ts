import { execFileSync } from "node:child_process"
import { randomFillSync } from "node:crypto"
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// Synthetic media for the Videos probe/remux/subtitle work: test patterns and tones only, nothing
// copyrighted, so the set can be regenerated anywhere ffmpeg + mkvtoolnix are installed. Output goes to
// the gitignored fixtures/videos/ together with manifest.json, the ffprobe ground truth tests compare
// against. Existing files are kept unless --force is passed.
//
//   brew install ffmpeg mkvtoolnix
//   pnpm run fixtures:videos [--force]

const OUT = "fixtures/videos"
const TMP = join(OUT, ".tmp")
const force = process.argv.includes("--force")

// ffmpeg applies an option to the file after it, so the output flags go last.
const INPUT_FLAGS = ["-y", "-hide_banner", "-loglevel", "error"]
const OUTPUT_FLAGS = ["-map_metadata", "-1", "-fflags", "+bitexact"]

// SVT_LOG=1: SVT-AV1 prints its config banner to stderr otherwise, past ffmpeg's -loglevel.
function run(command: string, args: string[]): void {
	execFileSync(command, args, { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, SVT_LOG: "1" } })
}

function video(width: number, height: number, fps: number, seconds: number): string[] {
	return ["-f", "lavfi", "-i", `testsrc2=size=${String(width)}x${String(height)}:rate=${String(fps)}:duration=${String(seconds)}`]
}

function stereo(seconds: number): string[] {
	return ["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${String(seconds)}`]
}

function surround(seconds: number): string[] {
	const exprs = ["sin(440*2*PI*t)", "sin(494*2*PI*t)", "sin(523*2*PI*t)", "0.2*sin(55*2*PI*t)", "sin(587*2*PI*t)", "sin(659*2*PI*t)"]

	return ["-f", "lavfi", "-i", `aevalsrc=exprs=${exprs.join("|")}:channel_layout=5.1:sample_rate=48000:duration=${String(seconds)}`]
}

const H264 = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-g", "48", "-pix_fmt", "yuv420p"]
const AAC = ["-c:a", "aac", "-b:a", "128k", "-ac", "2"]

// One output per entry, written by `make` into a temporary name first so an interrupted run never
// leaves a truncated fixture that a later run would keep.
interface Fixture {
	name: string
	make: (out: string) => void
}

function ffmpeg(args: string[]): (out: string) => void {
	return out => {
		run("ffmpeg", [...INPUT_FLAGS, ...args, ...OUTPUT_FLAGS, out])
	}
}

// mkvmerge exits 1 for warnings with a usable file, 2 for errors.
function mkvmerge(args: string[]): (out: string) => void {
	return out => {
		try {
			run("mkvmerge", ["--quiet", "-o", out, ...args])
		} catch (error) {
			if (typeof error === "object" && error !== null && "status" in error && error.status === 1) {
				return
			}

			throw error
		}
	}
}

function intermediate(name: string): string {
	return join(TMP, name)
}

const CHAPTERS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE Chapters SYSTEM "matroskachapters.dtd">
<Chapters>
	<EditionEntry>
		<ChapterAtom>
			<ChapterTimeStart>00:00:00.000000000</ChapterTimeStart>
			<ChapterTimeEnd>00:00:05.000000000</ChapterTimeEnd>
			<ChapterSkipType>1</ChapterSkipType>
			<ChapterDisplay><ChapterString>Intro</ChapterString><ChapLanguageIETF>en</ChapLanguageIETF></ChapterDisplay>
		</ChapterAtom>
		<ChapterAtom>
			<ChapterTimeStart>00:00:05.000000000</ChapterTimeStart>
			<ChapterDisplay><ChapterString>Chapter 1</ChapterString><ChapLanguageIETF>en</ChapLanguageIETF></ChapterDisplay>
		</ChapterAtom>
		<ChapterAtom>
			<ChapterTimeStart>00:00:24.000000000</ChapterTimeStart>
			<ChapterTimeEnd>00:00:30.000000000</ChapterTimeEnd>
			<ChapterSkipType>2</ChapterSkipType>
			<ChapterDisplay><ChapterString>End Credits</ChapterString><ChapLanguageIETF>en</ChapLanguageIETF></ChapterDisplay>
		</ChapterAtom>
	</EditionEntry>
</Chapters>
`

const SRT_EN = `1
00:00:01,000 --> 00:00:03,000
Hello, <i>world</i>.

2
00:00:06,000 --> 00:00:08,500
{\\an8}Top of the frame.

3
00:00:10,000 --> 00:00:12,000
Two lines,
one cue.
`

const SRT_DE_FORCED = `1
00:00:02,000 --> 00:00:04,000
Nur erzwungene Untertitel.
`

const SRT_RU = `1
00:00:01,000 --> 00:00:03,000
Привет, мир.

2
00:00:05,000 --> 00:00:07,000
Субтитры в кодировке Windows-1251.
`

const SRT_JA = `1
00:00:01,000 --> 00:00:03,000
こんにちは世界。

2
00:00:05,000 --> 00:00:07,000
シフトJISの字幕。
`

const VTT_EN_SDH = `WEBVTT

00:00:01.000 --> 00:00:03.000 line:90%
[door creaks]

00:00:04.000 --> 00:00:06.000
<v Narrator>It was late.
`

const ASS_JA = `[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,1,2,20,20,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\b1}こんにちは{\\b0}\\N世界
Dialogue: 0,0:00:05.00,0:00:07.00,Default,,0,0,0,,{\\an8}Top line
`

const MICRODVD = `{24}{72}Hello from MicroDVD.
{144}{204}Second|line.
`

const SMI = `<SAMI>
<HEAD><STYLE TYPE="text/css"><!-- .ENCC {Name: English; lang: en-US;} --></STYLE></HEAD>
<BODY>
<SYNC Start=1000><P Class=ENCC>Hello from SAMI.
<SYNC Start=3000><P Class=ENCC>&nbsp;
</BODY>
</SAMI>
`

const EDL = `0.0	5.0	3
24.0	30.0	3
`

const MOVIE_NFO = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<movie>
	<title>Test Pattern</title>
	<originaltitle>Test Pattern</originaltitle>
	<sorttitle>Pattern, Test</sorttitle>
	<year>2024</year>
	<plot>A moving test pattern and a 440 Hz tone.</plot>
	<runtime>1</runtime>
	<genre>Documentary</genre>
	<mpaa>NR</mpaa>
</movie>
`

function text(content: string, encoding?: string): (out: string) => void {
	return out => {
		if (encoding === undefined) {
			writeFileSync(out, content)

			return
		}

		writeFileSync(out, execFileSync("iconv", ["-f", "UTF-8", "-t", encoding], { input: content }))
	}
}

// A placeholder payload for font attachments: Mediabunny reads front attachments whole, and the probe
// must not, so only the size matters.
function randomFile(path: string, bytes: number): void {
	const buffer = Buffer.alloc(bytes)

	randomFillSync(buffer)
	writeFileSync(path, buffer)
}

const LONG_SECONDS = 3 * 60 * 60

const INTERMEDIATES: Fixture[] = [
	{ name: "base.mp4", make: ffmpeg([...video(1280, 720, 24, 30), ...stereo(30), ...H264, ...AAC]) },
	{ name: "base-ac3.mp4", make: ffmpeg([...video(1280, 720, 24, 30), ...surround(30), ...H264, "-c:a", "ac3", "-b:a", "384k"]) },
	{
		name: "long.mp4",
		make: ffmpeg([
			...video(320, 180, 15, LONG_SECONDS),
			...stereo(LONG_SECONDS),
			"-c:v",
			"libx264",
			"-preset",
			"ultrafast",
			"-crf",
			"45",
			"-g",
			"150",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"aac",
			"-b:a",
			"24k",
			"-ac",
			"1"
		])
	},
	{ name: "en.srt", make: text(SRT_EN) },
	{ name: "ja.ass", make: text(ASS_JA) },
	{ name: "chapters.xml", make: text(CHAPTERS_XML) },
	{ name: "cover.jpg", make: ffmpeg([...video(600, 900, 1, 1), "-frames:v", "1", "-q:v", "4"]) },
	{
		name: "fonts",
		make: out => {
			mkdirSync(out, { recursive: true })

			for (const index of [1, 2, 3]) {
				randomFile(join(out, `font${String(index)}.ttf`), 10 * 1024 * 1024)
			}
		}
	}
]

const FIXTURES: Fixture[] = [
	// ISOBMFF
	{ name: "h264-aac-faststart.mp4", make: ffmpeg(["-i", intermediate("base.mp4"), "-c", "copy", "-movflags", "+faststart"]) },
	{ name: "h264-aac-tailmoov.mp4", make: ffmpeg(["-i", intermediate("base.mp4"), "-c", "copy"]) },
	{ name: "h264-aac.mov", make: ffmpeg(["-i", intermediate("base.mp4"), "-c", "copy", "-f", "mov"]) },
	{
		name: "h264-bpyramid-aac.mp4",
		make: ffmpeg([
			...video(1280, 720, 24, 10),
			...stereo(10),
			...H264,
			"-x264-params",
			"bframes=3:b-pyramid=normal",
			...AAC,
			"-movflags",
			"+faststart"
		])
	},
	{
		name: "hevc-main10-aac.mp4",
		make: ffmpeg([
			...video(1280, 720, 24, 10),
			...stereo(10),
			"-c:v",
			"libx265",
			"-preset",
			"ultrafast",
			"-pix_fmt",
			"yuv420p10le",
			"-tag:v",
			"hvc1",
			"-x265-params",
			"log-level=error",
			...AAC,
			"-movflags",
			"+faststart"
		])
	},
	{
		name: "av1-aac.mp4",
		make: ffmpeg([
			...video(1280, 720, 24, 10),
			...stereo(10),
			"-c:v",
			"libsvtav1",
			"-preset",
			"12",
			"-crf",
			"45",
			...AAC,
			"-movflags",
			"+faststart"
		])
	},
	{ name: "h264-ac3-51.mp4", make: ffmpeg(["-i", intermediate("base-ac3.mp4"), "-c", "copy", "-movflags", "+faststart"]) },
	{ name: "long-faststart.mp4", make: ffmpeg(["-i", intermediate("long.mp4"), "-c", "copy", "-movflags", "+faststart"]) },
	{ name: "long-tailmoov.mp4", make: ffmpeg(["-i", intermediate("long.mp4"), "-c", "copy"]) },

	// WebM
	{
		name: "vp9-opus.webm",
		make: ffmpeg([
			...video(1280, 720, 24, 10),
			...stereo(10),
			"-c:v",
			"libvpx-vp9",
			"-b:v",
			"1M",
			"-deadline",
			"realtime",
			"-cpu-used",
			"8",
			"-c:a",
			"libopus",
			"-b:a",
			"96k"
		])
	},
	{
		name: "av1-opus.webm",
		make: ffmpeg([
			...video(1280, 720, 24, 10),
			...stereo(10),
			"-c:v",
			"libsvtav1",
			"-preset",
			"12",
			"-crf",
			"45",
			"-c:a",
			"libopus",
			"-b:a",
			"96k"
		])
	},

	// Matroska
	{ name: "h264-aac-cues.mkv", make: mkvmerge([intermediate("base.mp4")]) },
	{ name: "h264-aac-nocues.mkv", make: mkvmerge(["--cues", "0:none", "--cues", "1:none", intermediate("base.mp4")]) },
	{
		name: "h264-aac-attachments.mkv",
		make: mkvmerge([
			intermediate("base.mp4"),
			...[1, 2, 3].flatMap(index => [
				"--attachment-mime-type",
				"font/ttf",
				"--attach-file",
				join(intermediate("fonts"), `font${String(index)}.ttf`)
			]),
			"--attachment-mime-type",
			"image/jpeg",
			"--attachment-name",
			"cover.jpg",
			"--attach-file",
			intermediate("cover.jpg")
		])
	},
	// Two audio languages, text + ASS subtitles, skip-typed chapters, a cover: the detail-page probe target.
	{
		name: "h264-multitrack.mkv",
		make: mkvmerge([
			"--title",
			"Multitrack Test",
			"--language",
			"0:und",
			"--language",
			"1:en",
			"--track-name",
			"1:Stereo",
			"--default-track-flag",
			"1:yes",
			intermediate("base.mp4"),
			"--no-video",
			"--language",
			"1:de",
			"--track-name",
			"1:Surround 5.1",
			"--default-track-flag",
			"1:no",
			intermediate("base-ac3.mp4"),
			"--language",
			"0:en",
			intermediate("en.srt"),
			"--language",
			"0:ja",
			intermediate("ja.ass"),
			"--chapters",
			intermediate("chapters.xml"),
			"--attachment-mime-type",
			"image/jpeg",
			"--attachment-name",
			"cover.jpg",
			"--attach-file",
			intermediate("cover.jpg")
		])
	},
	{
		name: "hevc-opengop-aac.mkv",
		make: ffmpeg([
			...video(1280, 720, 24, 10),
			...stereo(10),
			"-c:v",
			"libx265",
			"-preset",
			"ultrafast",
			"-x265-params",
			"log-level=error:open-gop=1:keyint=48:min-keyint=48",
			...AAC
		])
	},
	{ name: "h264-ac3-51.mkv", make: mkvmerge([intermediate("base-ac3.mp4")]) },
	{ name: "h264-eac3-51.mkv", make: ffmpeg(["-i", intermediate("base-ac3.mp4"), "-c:v", "copy", "-c:a", "eac3", "-b:a", "384k"]) },
	{
		name: "h264-dts-51.mkv",
		make: ffmpeg(["-i", intermediate("base-ac3.mp4"), "-c:v", "copy", "-c:a", "dca", "-strict", "-2", "-b:a", "768k"])
	},
	{ name: "h264-flac.mkv", make: ffmpeg([...video(1280, 720, 24, 10), ...stereo(10), ...H264, "-c:a", "flac"]) },
	{ name: "long.mkv", make: mkvmerge([intermediate("long.mp4")]) },
	// One ~20 s GOP at high bitrate: a single fMP4 fragment larger than a SourceBuffer append should be.
	{
		name: "h264-longgop-1080p.mkv",
		make: ffmpeg([
			...video(1920, 1080, 30, 20),
			...stereo(20),
			"-c:v",
			"libx264",
			"-preset",
			"veryfast",
			"-b:v",
			"30M",
			"-maxrate",
			"30M",
			"-bufsize",
			"60M",
			"-g",
			"9999",
			"-keyint_min",
			"9999",
			"-sc_threshold",
			"0",
			"-pix_fmt",
			"yuv420p",
			...AAC
		])
	},

	// MPEG-TS: BDAV (192-byte packets, the AAC as private data) from the ISOBMFF source with an "und"
	// language descriptor, and 188-byte TS from the Matroska remux, whose millisecond timestamps it keeps.
	{
		name: "h264-aac-faststart.m2ts",
		make: ffmpeg(["-i", intermediate("base.mp4"), "-c", "copy", "-metadata:s:a:0", "language=und"])
	},
	{ name: "h264-ac3-51.ts", make: ffmpeg(["-i", join(OUT, "h264-ac3-51.mkv"), "-c", "copy"]) },

	// AVI, which no browser plays natively.
	{ name: "mpeg4-mp3.avi", make: ffmpeg([...video(640, 360, 24, 5), ...stereo(5), "-c:v", "mpeg4", "-q:v", "5", "-c:a", "libmp3lame"]) },

	// Sidecars, named after h264-aac-faststart.mp4.
	{ name: "h264-aac-faststart.en.srt", make: text(SRT_EN) },
	{ name: "h264-aac-faststart.de.forced.srt", make: text(SRT_DE_FORCED) },
	{ name: "h264-aac-faststart.ru.srt", make: text(SRT_RU, "CP1251") },
	{ name: "h264-aac-faststart.ja.srt", make: text(SRT_JA, "SHIFT_JIS") },
	{ name: "h264-aac-faststart.en.sdh.vtt", make: text(VTT_EN_SDH) },
	{ name: "h264-aac-faststart.ja.ass", make: text(ASS_JA) },
	{ name: "h264-aac-faststart.sub", make: text(MICRODVD) },
	{ name: "h264-aac-faststart.smi", make: text(SMI) },
	{ name: "h264-aac-faststart.edl", make: text(EDL) },
	{ name: "h264-aac-faststart.nfo", make: text(MOVIE_NFO) },
	{ name: "h264-aac-faststart-poster.jpg", make: ffmpeg(["-i", intermediate("cover.jpg"), "-q:v", "4"]) }
]

function build(fixture: Fixture, dir: string): void {
	const path = join(dir, fixture.name)

	if (!force && existsSync(path)) {
		return
	}

	const partial = join(dir, `partial-${fixture.name}`)

	rmSync(partial, { recursive: true, force: true })
	console.log(`fixtures:videos ${fixture.name}`)
	fixture.make(partial)
	rmSync(path, { recursive: true, force: true })
	renameSync(partial, path)
}

interface ProbeStream {
	index?: number
	codec_type?: string
	codec_name?: string
	codec_tag_string?: string
	profile?: string
	width?: number
	height?: number
	pix_fmt?: string
	color_transfer?: string
	channels?: number
	sample_rate?: string
	disposition?: { default?: number; forced?: number }
	tags?: { language?: string; title?: string; filename?: string }
}

interface Probe {
	format?: { format_name?: string; duration?: string }
	streams?: ProbeStream[]
	chapters?: { start_time?: string; end_time?: string; tags?: { title?: string } }[]
}

// The fields probe tests assert on, per media fixture.
function groundTruth(name: string): unknown {
	const path = join(OUT, name)
	const raw = execFileSync("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-show_chapters", "-of", "json", path], {
		encoding: "utf8"
	})
	const probe = JSON.parse(raw) as Probe

	return {
		name,
		size: statSync(path).size,
		format: probe.format?.format_name,
		duration: probe.format?.duration === undefined ? null : Number(probe.format.duration),
		streams: (probe.streams ?? []).map(stream => ({
			index: stream.index,
			type: stream.codec_type,
			codec: stream.codec_name,
			tag: stream.codec_tag_string,
			profile: stream.profile,
			width: stream.width,
			height: stream.height,
			pixFmt: stream.pix_fmt,
			transfer: stream.color_transfer,
			channels: stream.channels,
			sampleRate: stream.sample_rate === undefined ? undefined : Number(stream.sample_rate),
			language: stream.tags?.language,
			title: stream.tags?.title,
			filename: stream.tags?.filename,
			default: stream.disposition?.default === 1,
			forced: stream.disposition?.forced === 1
		})),
		chapters: (probe.chapters ?? []).map(chapter => ({
			start: Number(chapter.start_time),
			end: Number(chapter.end_time),
			title: chapter.tags?.title
		}))
	}
}

const MEDIA = /\.(mp4|mov|mkv|webm|avi|ts|m2ts)$/

mkdirSync(TMP, { recursive: true })

for (const fixture of INTERMEDIATES) {
	build(fixture, TMP)
}

for (const fixture of FIXTURES) {
	build(fixture, OUT)
}

writeFileSync(
	join(OUT, "manifest.json"),
	`${JSON.stringify(
		FIXTURES.filter(fixture => MEDIA.test(fixture.name)).map(fixture => groundTruth(fixture.name)),
		null,
		"\t"
	)}\n`
)

const total = FIXTURES.reduce((sum, fixture) => sum + statSync(join(OUT, fixture.name)).size, 0)

console.log(`fixtures:videos ${String(FIXTURES.length)} fixtures, ${(total / 1024 / 1024).toFixed(1)} MiB in ${OUT}`)
