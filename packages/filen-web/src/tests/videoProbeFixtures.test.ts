import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { BLOCK_BYTES, type ProbeTier, type VideoProbe } from "@filen/shared/videos"
import { CARD_BUDGET, MEDIA_DIR, TIERS, blocksOf, fileReadRange, measureProbe } from "@/tests/support/videoProbe"

// Every generated media fixture at every tier against ffprobe's ground truth. Local only: the media
// (pnpm run fixtures:videos) is gitignored, so this skips without it.

interface ManifestStream {
	type: string
	codec?: string
	tag?: string
	width?: number
	height?: number
	pixFmt?: string
	channels?: number
	sampleRate?: number
	language?: string
	title?: string
	filename?: string
	default: boolean
	forced: boolean
}

interface ManifestEntry {
	name: string
	size: number
	format: string
	duration: number
	streams: ManifestStream[]
	chapters: { start: number; end: number; title: string }[]
}

const MANIFEST = join(MEDIA_DIR, "manifest.json")
const manifest: ManifestEntry[] = existsSync(MANIFEST) ? (JSON.parse(readFileSync(MANIFEST, "utf8")) as ManifestEntry[]) : []

// ffprobe names against the probe's; subrip/ass are Matroska CodecIDs here.
const CODEC_NAMES: Readonly<Record<string, string>> = { subrip: "S_TEXT/UTF8", ass: "S_TEXT/ASS" }
// ffprobe reports Matroska's legacy ISO 639-2 code; the probe prefers BCP 47.
const BCP47_TO_LEGACY: Readonly<Record<string, string>> = { en: "eng", de: "ger", ja: "jpn" }

function legacyLanguage(lang: string | null): string | undefined {
	return lang === null ? undefined : (BCP47_TO_LEGACY[lang] ?? lang)
}

function expectedLanguage(stream: ManifestStream): string | undefined {
	return stream.language === "und" ? undefined : stream.language
}

// The probe's container and full-tier index per ffprobe format; ISOBMFF and Matroska go by extension below.
const CONTAINERS: Readonly<Record<string, { container: string; index: string }>> = {
	avi: { container: "avi", index: "idx" },
	mpegts: { container: "ts", index: "none" }
}
// Containers with no default flag: the probe marks the first audio track default, ffprobe none.
const FLAGLESS = new Set(["avi", "mpegts"])

// AAC in TS is stream type 0x0f; as private data (0x06, which ffmpeg's BDAV muxer writes) no descriptor
// names it, so the probe skips the track while ffprobe identifies it from its payload.
function probedStream(stream: ManifestStream, format: string): boolean {
	return !(format === "mpegts" && stream.codec === "aac" && stream.tag === "[6][0][0][0]")
}

function checkRecord(entry: ManifestEntry, tier: ProbeTier, record: VideoProbe): void {
	const isMatroska = entry.format.startsWith("matroska")
	const known = CONTAINERS[entry.format]
	const flagless = FLAGLESS.has(entry.format)

	expect(record.container).toBe(
		known?.container ?? (isMatroska ? (entry.name.endsWith(".webm") ? "webm" : "mkv") : entry.name.endsWith(".mov") ? "mov" : "mp4")
	)
	expect(record.partial).toBe(false)

	if (tier === "cover") {
		const cover = entry.streams.find(stream => stream.filename?.startsWith("cover.") === true)

		expect(record.cover === null).toBe(cover === undefined)

		return
	}

	expect(Math.abs((record.durationSec ?? 0) - entry.duration)).toBeLessThan(0.1)

	const video = entry.streams.find(stream => stream.type === "video" && stream.filename === undefined)

	expect(record.video?.codec).toBe(video?.codec)
	expect(record.video?.w).toBe(video?.width)
	expect(record.video?.h).toBe(video?.height)
	// WebM VP9 without CodecPrivate states no bit depth; its codec string assumes profile 0's 8 bits. AVI's
	// BITMAPINFOHEADER states none either, and names a codec string only for H.264 (from its SPS) and VP8.
	expect(record.video?.bitDepth).toBe(
		(isMatroska && video?.codec === "vp9") || entry.format === "avi" ? null : video?.pixFmt?.includes("10") === true ? 10 : 8
	)

	if (entry.format !== "avi" || video?.codec === "h264") {
		expect(record.video?.codecString).not.toBeNull()
	}

	const audio = entry.streams.filter(stream => stream.type === "audio" && probedStream(stream, entry.format))

	expect(
		record.audio.map(track => ({
			codec: track.codec,
			ch: track.ch,
			rate: track.rate,
			lang: legacyLanguage(track.lang),
			name: track.name ?? undefined,
			def: flagless ? undefined : track.def,
			forced: track.forced
		}))
	).toEqual(
		audio.map(stream => ({
			codec: stream.codec,
			ch: stream.channels,
			rate: stream.sampleRate,
			lang: expectedLanguage(stream),
			name: tier === "full" || isMatroska ? stream.title : undefined,
			def: flagless ? undefined : stream.default,
			forced: stream.forced
		}))
	)
	expect(record.audio.every(track => track.codecString !== null)).toBe(true)

	const subs = entry.streams.filter(stream => stream.type === "subtitle")

	expect(record.subs.map(sub => ({ codecId: sub.codecId, lang: legacyLanguage(sub.lang), def: sub.def }))).toEqual(
		subs.map(stream => ({
			codecId: CODEC_NAMES[stream.codec ?? ""] ?? stream.codec,
			lang: expectedLanguage(stream),
			def: stream.default
		}))
	)

	if (tier === "full") {
		expect(record.chapters.map(chapter => ({ t: chapter.t, title: chapter.title }))).toEqual(
			entry.chapters.map(chapter => ({ t: chapter.start, title: chapter.title }))
		)

		for (const chapter of record.chapters) {
			if (chapter.end !== undefined) {
				expect(entry.chapters.find(expected => expected.start === chapter.t)?.end).toBe(chapter.end)
			}
		}

		expect(record.index).toBe(known?.index ?? (isMatroska ? (entry.name.includes("nocues") ? "none" : "cues") : "moov"))
	}
}

describe.skipIf(manifest.length === 0)("video probe against the generated fixtures", () => {
	const rows: string[] = []

	for (const entry of manifest) {
		it(`probes ${entry.name} at every tier`, async () => {
			const file = await fileReadRange(join(MEDIA_DIR, entry.name))

			try {
				for (const tier of TIERS) {
					const measured = await measureProbe(file.size, file.readRange, tier)

					rows.push(
						[
							entry.name,
							tier,
							String(measured.blockReads),
							(measured.downloaded / BLOCK_BYTES).toFixed(2),
							String(measured.consumed),
							measured.record?.video?.codecString ?? "-",
							measured.record?.audio.map(track => track.codecString ?? "?").join(",") ?? "-"
						].join(" | ")
					)

					expect(measured.record).not.toBeNull()

					if (measured.record !== null) {
						checkRecord(entry, tier, measured.record)
					}

					if (tier === "card") {
						expect(measured.blockReads).toBeLessThanOrEqual(CARD_BUDGET)
					}
				}
			} finally {
				await file.close()
			}
		})
	}

	it("reads a tail moov of more than 4 MiB at the full tier within ceil(moov) + 2 blocks", async () => {
		const name = "long-tailmoov.mp4"
		// The moov's size, from the fixture's box layout: 4,460,696 bytes.
		const file = await fileReadRange(join(MEDIA_DIR, name))

		try {
			const measured = await measureProbe(file.size, file.readRange, "full")

			expect(measured.record?.durationSec).toBe(10800)
			expect(measured.blockReads).toBeLessThanOrEqual(blocksOf(4_460_696) + 2)
		} finally {
			await file.close()
		}

		// The read-cost table, to compare against after a parser change.
		console.log(["file | tier | block reads | MiB downloaded | bytes parsed | video | audio", ...rows].join("\n"))
	})
})
