import { describe, expect, it, vi } from "vitest"
import { BlockSource, walkContainer, type SampleTables } from "@filen/shared/videos"
import { BufferTarget, EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output, TextSubtitleSource } from "mediabunny"
import { AVC_PRIVATE, FPS, GOP_FRAMES, videoPacket } from "@/tests/support/fragmentedMp4"
import { BlockAbortError } from "@/lib/media/blockCache"
import {
	DIRECT_READ_LAG_SECONDS,
	Mp4TextTap,
	isMp4TextCodec,
	readMp4TextSamples,
	tx3gCueText,
	wvttCueTexts,
	type Mp4TextSamples,
	type Mp4TextTrack
} from "@/workers/remux/mp4TextTap"
import type { TextTapCue } from "@/workers/remux/textTap"

const encode = (value: string): Uint8Array => new TextEncoder().encode(value)

function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
	let at = 0

	for (const part of parts) {
		out.set(part, at)
		at += part.length
	}

	return out
}

function u32(...values: number[]): Uint8Array {
	const out = new Uint8Array(values.length * 4)
	const view = new DataView(out.buffer)

	values.forEach((value, index) => {
		view.setUint32(index * 4, value)
	})

	return out
}

function u16(value: number): Uint8Array {
	return new Uint8Array([(value >> 8) & 0xff, value & 0xff])
}

function box(type: string, payload: Uint8Array): Uint8Array {
	return concat([u32(8 + payload.length), encode(type), payload])
}

// A tx3g sample: the length-prefixed text, then any modifier boxes.
function tx3g(text: string, ...boxes: Uint8Array[]): Uint8Array {
	const body = encode(text)

	return concat([u16(body.length), body, ...boxes])
}

// A styl box: records of startChar, endChar, font ID, face flags, size, color.
function styl(...records: [number, number, number][]): Uint8Array {
	return box(
		"styl",
		concat([
			u16(records.length),
			...records.map(([start, end, flags]) => concat([u16(start), u16(end), u16(1), new Uint8Array([flags, 18, 255, 255, 255, 255])]))
		])
	)
}

describe("MP4 text codecs", () => {
	it("are timed text, QuickTime text and WebVTT", () => {
		expect(isMp4TextCodec("tx3g")).toBe(true)
		expect(isMp4TextCodec("text")).toBe(true)
		expect(isMp4TextCodec("wvtt")).toBe(true)

		for (const codecId of ["stpp", "c608", "mp4s", "S_TEXT/UTF8", "constructor"]) {
			expect(isMp4TextCodec(codecId)).toBe(false)
		}
	})
})

describe("tx3gCueText", () => {
	it("reads the length-prefixed text, escaped", () => {
		expect(tx3gCueText(tx3g("Tom & <Jerry>\nline two"))).toBe("Tom &amp; &lt;Jerry>\nline two")
	})

	it("is null for an empty sample (the gap between cues) and for a broken length", () => {
		expect(tx3gCueText(tx3g(""))).toBeNull()
		expect(tx3gCueText(new Uint8Array([0, 9, 65]))).toBeNull()
		expect(tx3gCueText(new Uint8Array([0]))).toBeNull()
	})

	it("turns styl records into bold, italic and underline by character", () => {
		expect(tx3gCueText(tx3g("née bold it", styl([4, 8, 1], [9, 11, 2 | 4])))).toBe("née <b>bold</b> <i><u>it</u></i>")
	})

	it("leaves out a style record overlapping the one before it", () => {
		expect(tx3gCueText(tx3g("abcdef", styl([0, 4, 1], [2, 6, 2])))).toBe("<b>abcd</b>ef")
	})

	it("decodes UTF-16 text after a byte order mark", () => {
		const body = new Uint8Array([0xfe, 0xff, 0x00, 0x48, 0x00, 0x69])

		expect(tx3gCueText(concat([u16(body.length), body]))).toBe("Hi")
	})
})

describe("wvttCueTexts", () => {
	it("reads every vttc payload of a sample and nothing from a vtte", () => {
		const sample = concat([
			box("vttc", concat([box("sttg", encode("line:0")), box("payl", encode("<i>First</i>"))])),
			box("vttc", box("payl", encode("Second"))),
			box("vtte", new Uint8Array())
		])

		expect(wvttCueTexts(sample)).toEqual(["<i>First</i>", "Second"])
		expect(wvttCueTexts(box("vtte", new Uint8Array()))).toEqual([])
	})

	it("stops at a box that claims more than the sample holds", () => {
		expect(wvttCueTexts(concat([box("vttc", box("payl", encode("Kept"))), u32(4096), encode("vttc")]))).toEqual(["Kept"])
	})
})

// A file whose head holds the four sample tables (stts, stsc, stsz, stco), followed by the samples.
function tablesFile(samples: Uint8Array[], deltas: number[], perChunk: number[]): { file: Uint8Array; tables: SampleTables } {
	const stts = concat([u32(0, deltas.length), ...deltas.map(delta => u32(1, delta))])
	const chunkCount = perChunk.length
	const stsc = concat([u32(0, chunkCount), ...perChunk.map((count, index) => u32(index + 1, count, 1))])
	const stsz = concat([u32(0, 0, samples.length), ...samples.map(sample => u32(sample.length))])
	const headLength = stts.length + stsc.length + stsz.length + 8 + chunkCount * 4
	const chunkOffsets: number[] = []
	let offset = headLength
	let sample = 0

	for (const count of perChunk) {
		chunkOffsets.push(offset)

		for (let index = 0; index < count; index++) {
			offset += samples[sample]?.length ?? 0
			sample++
		}
	}

	const stco = concat([u32(0, chunkCount), u32(...chunkOffsets)])
	const file = concat([stts, stsc, stsz, stco, ...samples])
	let at = 0
	const range = (length: number) => {
		const out = { start: at, end: at + length }

		at += length

		return out
	}

	return {
		file,
		tables: {
			timescale: 1000,
			stts: range(stts.length),
			stss: null,
			stsc: range(stsc.length),
			stsz: range(stsz.length),
			chunkOffsets: range(stco.length),
			wideOffsets: false
		}
	}
}

const readOf = (file: Uint8Array) => (start: number, end: number) => Promise.resolve(file.slice(start, end))

describe("readMp4TextSamples", () => {
	it("places every sample by its chunk and times it by stts", async () => {
		const samples = [tx3g("one"), tx3g(""), tx3g("three")]
		const { file, tables } = tablesFile(samples, [1000, 500, 2000], [2, 1])
		const read = await readMp4TextSamples(tables, readOf(file))

		expect(read).not.toBeNull()

		const head = file.length - samples.reduce((sum, sample) => sum + sample.length, 0)

		expect(Array.from(read?.offsets ?? [])).toEqual([head, head + 5, head + 7])
		expect(Array.from(read?.sizes ?? [])).toEqual([5, 2, 7])
		expect(Array.from(read?.starts ?? [])).toEqual([0, 1, 1.5])
		expect(Array.from(read?.ends ?? [])).toEqual([1, 1.5, 3.5])
	})

	it("is null without the tables a sample needs, or with an empty track (a fragmented file's moov)", async () => {
		const { file, tables } = tablesFile([tx3g("one")], [1000], [1])

		expect(await readMp4TextSamples({ ...tables, stsz: null }, readOf(file))).toBeNull()
		expect(await readMp4TextSamples({ ...tables, timescale: 0 }, readOf(file))).toBeNull()

		const empty = tablesFile([], [], [])

		expect(await readMp4TextSamples(empty.tables, readOf(empty.file))).toBeNull()
	})

	it("keeps every array at the samples the sample-to-chunk table places, when it covers fewer than stts", async () => {
		const { file, tables } = tablesFile([tx3g("one"), tx3g("two"), tx3g("three")], [1000, 1000, 1000], [1])
		const read = await readMp4TextSamples(tables, readOf(file))

		expect(read?.offsets).toHaveLength(1)
		expect(read?.sizes).toHaveLength(1)
		expect(read?.starts).toHaveLength(1)
		expect(read?.ends).toHaveLength(1)
	})

	it("is null for a sample-to-chunk table going backwards", async () => {
		const { file, tables } = tablesFile([tx3g("a"), tx3g("b")], [1000, 1000], [1, 1])
		const broken = file.slice()
		const stsc = tables.stsc ?? { start: 0, end: 0 }

		// The second run's first chunk becomes 1, the same as the first's.
		broken.set(u32(1), stsc.start + 8 + 12)

		expect(await readMp4TextSamples(tables, readOf(broken))).toBeNull()
	})
})

// Samples laid out one after another from `base`, each `seconds` long.
function laidOut(texts: (string | Uint8Array)[], base: number, seconds = 2): { samples: Mp4TextSamples; bytes: Uint8Array } {
	const parts = texts.map(text => (typeof text === "string" ? tx3g(text) : text))
	const offsets: number[] = []
	let at = base

	for (const part of parts) {
		offsets.push(at)
		at += part.length
	}

	return {
		samples: {
			offsets: Float64Array.from(offsets),
			sizes: Uint32Array.from(parts.map(part => part.length)),
			starts: Float64Array.from(parts.map((_, index) => index * seconds)),
			ends: Float64Array.from(parts.map((_, index) => (index + 1) * seconds))
		},
		bytes: concat(parts)
	}
}

interface Harness {
	tap: Mp4TextTap
	cues: TextTapCue[]
	direct: ReturnType<typeof vi.fn<(start: number, end: number) => Promise<Uint8Array>>>
	land: (index: number) => void
}

// A file of `blockBytes`-sized blocks holding `bytes` at `base`; `land` marks a block resident and hands it to the tap.
function harness(params: {
	tracks: (file: Uint8Array) => Mp4TextTrack[]
	bytes: Uint8Array
	base: number
	blockBytes: number
	charBudget?: number
	direct?: (start: number, end: number) => Promise<Uint8Array>
}): Harness {
	const file = new Uint8Array(params.base + params.bytes.length)

	file.set(params.bytes, params.base)

	const resident = new Set<number>()
	const cues: TextTapCue[] = []
	const direct = vi.fn(params.direct ?? ((start: number, end: number) => Promise.resolve(file.slice(start, end))))
	const tap = new Mp4TextTap({
		tracks: params.tracks(file),
		peek: (start, end) => {
			for (let index = Math.floor(start / params.blockBytes); index <= Math.floor((end - 1) / params.blockBytes); index++) {
				if (!resident.has(index)) {
					return null
				}
			}

			return file.subarray(start, end)
		},
		readDirect: direct,
		emit: batch => {
			cues.push(...batch)
		},
		blockBytes: params.blockBytes,
		...(params.charBudget === undefined ? {} : { charBudget: params.charBudget })
	})

	return {
		tap,
		cues,
		direct,
		land: index => {
			resident.add(index)
			tap.addBlock(index, file.subarray(index * params.blockBytes, (index + 1) * params.blockBytes))
		}
	}
}

describe("Mp4TextTap", () => {
	it("takes the samples inside the blocks playback reads, once each, with no read of its own", () => {
		const { samples, bytes } = laidOut(["Hello", "", "World"], 100)
		const { tap, cues, direct, land } = harness({
			tracks: () => [{ number: 2, codecId: "tx3g", samples }],
			bytes,
			base: 100,
			blockBytes: 64
		})

		land(0)
		expect(cues).toEqual([])
		land(1)
		// "Hello" (100–107) lies in block 1; "World" (109–116) does too.
		expect(cues.map(cue => [cue.track, cue.start, cue.end, cue.text])).toEqual([
			[2, 0, 2, "Hello"],
			[2, 4, 6, "World"]
		])
		land(1)
		tap.advance(1000)
		expect(cues).toHaveLength(2)
		expect(direct).not.toHaveBeenCalled()
	})

	it("passes over an empty sample and never throws into the block cache", () => {
		const { samples, bytes } = laidOut(["Before", new Uint8Array(0), "After"], 0)
		const cues: TextTapCue[] = []
		// The block cache's peek refuses an empty or backwards range, as BlockCache.span does.
		const peek = (start: number, end: number): Uint8Array => {
			if (end <= start) {
				throw new RangeError("empty range")
			}

			return bytes.subarray(start, end)
		}
		const tap = new Mp4TextTap({
			tracks: [{ number: 1, codecId: "tx3g", samples }],
			peek,
			readDirect: () => Promise.resolve(new Uint8Array(0)),
			emit: batch => {
				cues.push(...batch)
			},
			blockBytes: 64
		})

		expect(() => {
			tap.addBlock(0, bytes)
		}).not.toThrow()
		expect(cues.map(cue => cue.text)).toEqual(["Before", "After"])

		const broken = new Mp4TextTap({
			tracks: [{ number: 1, codecId: "tx3g", samples }],
			peek: () => {
				throw new Error("hostile")
			},
			readDirect: () => Promise.resolve(new Uint8Array(0)),
			emit: () => undefined,
			blockBytes: 64
		})

		expect(() => {
			broken.addBlock(0, bytes)
		}).not.toThrow()
		expect(broken.active).toBe(false)
	})

	it("takes a sample crossing two blocks once the second lands", () => {
		const { samples, bytes } = laidOut(["Across the line"], 56)
		const { cues, land } = harness({ tracks: () => [{ number: 1, codecId: "tx3g", samples }], bytes, base: 56, blockBytes: 64 })

		land(0)
		expect(cues).toEqual([])
		land(1)
		expect(cues.map(cue => cue.text)).toEqual(["Across the line"])
	})

	it("reads samples playback passed without their bytes landing, in one read per stretch", async () => {
		const { samples, bytes } = laidOut(["a", "b", "c", "d"], 10_000)
		const { tap, cues, direct } = harness({
			tracks: () => [{ number: 1, codecId: "tx3g", samples }],
			bytes,
			base: 10_000,
			blockBytes: 64
		})

		// Within the lag the bytes may still come with playback's reads.
		tap.advance(DIRECT_READ_LAG_SECONDS - 1)
		expect(direct).not.toHaveBeenCalled()

		tap.advance(DIRECT_READ_LAG_SECONDS + 1)
		await vi.waitFor(() => {
			expect(cues.map(cue => cue.text)).toEqual(["a", "b", "c", "d"])
		})
		expect(direct).toHaveBeenCalledTimes(1)
		expect(direct).toHaveBeenCalledWith(10_000, 10_000 + bytes.length)

		tap.advance(Number.POSITIVE_INFINITY)
		tap.advance(100)
		expect(direct).toHaveBeenCalledTimes(1)
	})

	it("reads nothing before the position a seek lands at", async () => {
		const { samples, bytes } = laidOut(["a", "b", "c", "d", "e", "f"], 0, 10)
		const { tap, cues, direct } = harness({ tracks: () => [{ number: 1, codecId: "tx3g", samples }], bytes, base: 0, blockBytes: 4096 })

		tap.seek(40)
		tap.advance(40 + DIRECT_READ_LAG_SECONDS)
		await vi.waitFor(() => {
			expect(cues.map(cue => cue.text)).toEqual(["e", "f"])
		})
		expect(direct.mock.calls[0]?.[0]).toBe(samples.offsets[4])
	})

	it("reads samples again after a read a seek called off, and gives up those of a failed read", async () => {
		const { samples, bytes } = laidOut(["a"], 0)
		let failure: Error = new BlockAbortError()
		const { tap, cues, direct } = harness({
			tracks: () => [{ number: 1, codecId: "tx3g", samples }],
			bytes,
			base: 0,
			blockBytes: 4096,
			direct: () => Promise.reject(failure)
		})

		tap.advance(DIRECT_READ_LAG_SECONDS + 1)
		await vi.waitFor(() => {
			expect(direct).toHaveBeenCalledTimes(1)
		})
		await new Promise(resolve => setTimeout(resolve, 0))
		failure = new Error("gone")
		tap.advance(DIRECT_READ_LAG_SECONDS + 2)
		await vi.waitFor(() => {
			expect(direct).toHaveBeenCalledTimes(2)
		})
		await new Promise(resolve => setTimeout(resolve, 0))
		tap.advance(DIRECT_READ_LAG_SECONDS + 3)
		expect(direct).toHaveBeenCalledTimes(2)
		expect(cues).toEqual([])
	})

	it("hands on every cue of a WebVTT sample", () => {
		const sample = concat([box("vttc", box("payl", encode("<b>One</b>"))), box("vttc", box("payl", encode("Two")))])
		const { samples, bytes } = laidOut([sample], 0)
		const { cues, land } = harness({ tracks: () => [{ number: 7, codecId: "wvtt", samples }], bytes, base: 0, blockBytes: 4096 })

		land(0)
		expect(cues.map(cue => [cue.track, cue.text])).toEqual([
			[7, "<b>One</b>"],
			[7, "Two"]
		])
	})

	it("stops at its character budget", () => {
		const { samples, bytes } = laidOut(["first cue", "second cue"], 0)
		const { tap, cues, land } = harness({
			tracks: () => [{ number: 1, codecId: "tx3g", samples }],
			bytes,
			base: 0,
			blockBytes: 4096,
			charBudget: 45
		})

		land(0)
		expect(cues.map(cue => cue.text)).toEqual(["first cue"])
		expect(tap.active).toBe(false)
	})

	it("gives up samples a crafted file declares over the same bytes, past a multiple of the bytes involved", async () => {
		const count = 65_536
		// Every sample at one offset, as overlapping tables can declare: whitespace-only text is never charged to the
		// character budget, so only the bytes involved bound the work.
		const overlapping = (base: number, size: number): Mp4TextSamples => ({
			offsets: new Float64Array(count).fill(base),
			sizes: new Uint32Array(count).fill(size),
			starts: Float64Array.from({ length: count }, (_, index) => index / 1000),
			ends: Float64Array.from({ length: count }, (_, index) => (index + 1) / 1000)
		})
		const blank = tx3g("   ")
		const decode = vi.spyOn(TextDecoder.prototype, "decode")

		try {
			const held = harness({
				tracks: () => [{ number: 1, codecId: "tx3g", samples: overlapping(0, blank.length) }],
				bytes: blank,
				base: 0,
				blockBytes: 4096
			})

			held.land(0)
			expect(held.cues).toEqual([])
			expect(decode.mock.calls.length * blank.length).toBeLessThanOrEqual(2 * 4096)

			const said = tx3g("Hi")
			const spoken = harness({
				tracks: () => [{ number: 1, codecId: "tx3g", samples: overlapping(0, said.length) }],
				bytes: said,
				base: 0,
				blockBytes: 4096
			})

			spoken.land(0)
			expect(spoken.cues.length * said.length).toBeLessThanOrEqual(2 * 4096)

			decode.mockClear()

			const direct = harness({
				tracks: () => [{ number: 1, codecId: "tx3g", samples: overlapping(10_000, blank.length) }],
				bytes: blank,
				base: 10_000,
				blockBytes: 4096
			})

			direct.tap.advance(DIRECT_READ_LAG_SECONDS + 1)
			await vi.waitFor(() => {
				expect(direct.direct).toHaveBeenCalledTimes(1)
			})
			await new Promise(resolve => setTimeout(resolve, 0))
			expect(direct.direct).toHaveBeenCalledWith(10_000, 10_000 + blank.length)
			expect(decode.mock.calls.length * blank.length).toBeLessThanOrEqual(2 * blank.length)
			expect(direct.cues).toEqual([])
		} finally {
			decode.mockRestore()
		}
	})

	it("decodes no track of another codec and nothing after close", () => {
		const { samples, bytes } = laidOut(["a"], 0)
		const other = harness({ tracks: () => [{ number: 1, codecId: "stpp", samples }], bytes, base: 0, blockBytes: 4096 })

		expect(other.tap.active).toBe(false)

		const closed = harness({ tracks: () => [{ number: 1, codecId: "tx3g", samples }], bytes, base: 0, blockBytes: 4096 })

		closed.tap.close()
		closed.land(0)
		expect(closed.cues).toEqual([])
	})
})

// An ordinary MP4 (moov, sample tables) with a picture track and a WebVTT track, as mediabunny writes it.
async function mp4WithWebVtt(): Promise<Uint8Array> {
	const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() })
	const video = new EncodedVideoPacketSource("avc")
	const subtitles = new TextSubtitleSource("webvtt")

	output.addVideoTrack(video, { frameRate: FPS })
	output.addSubtitleTrack(subtitles, { languageCode: "ger", name: "Deutsch" })
	await output.start()
	await subtitles.add("WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nErste <i>Zeile</i>\n\n00:00:04.000 --> 00:00:05.000\nZweite\n")
	subtitles.close()

	for (let frame = 0; frame < 6 * FPS; frame++) {
		await video.add(
			new EncodedPacket(videoPacket(frame), frame % GOP_FRAMES === 0 ? "key" : "delta", frame / FPS, 1 / FPS),
			frame === 0
				? { decoderConfig: { codec: "avc1.64001f", codedWidth: 1280, codedHeight: 720, description: AVC_PRIVATE } }
				: undefined
		)
	}

	await output.finalize()

	const buffer = output.target.buffer

	if (buffer === null) {
		throw new Error("no output")
	}

	return new Uint8Array(buffer)
}

describe("MP4 text tracks end to end", () => {
	it("locates a WebVTT track's tables in the moov and reads its cues by their times", async () => {
		const file = await mp4WithWebVtt()
		const read = (start: number, end: number) => Promise.resolve(file.slice(start, end))
		const parsed = await walkContainer(new BlockSource(file.length, read), "card", { keyframes: true })
		const subtitle = parsed?.tracks.find(track => track.kind === "subtitle")

		expect(subtitle?.kind === "subtitle" ? [subtitle.sub.codecId, subtitle.sub.lang] : null).toEqual(["wvtt", "ger"])

		const tables = subtitle?.kind === "subtitle" ? subtitle.tables : undefined

		expect(tables).toBeDefined()

		const samples = tables === undefined ? null : await readMp4TextSamples(tables, read)

		expect(samples).not.toBeNull()

		const cues: TextTapCue[] = []
		const tap = new Mp4TextTap({
			tracks: samples === null || subtitle?.kind !== "subtitle" ? [] : [{ number: subtitle.sub.id, codecId: "wvtt", samples }],
			peek: (start, end) => file.subarray(start, end),
			readDirect: read,
			emit: batch => {
				cues.push(...batch)
			},
			blockBytes: file.length
		})

		tap.addBlock(0, file)

		expect(cues.map(cue => [cue.start, cue.end, cue.text])).toEqual([
			[1, 2.5, "Erste <i>Zeile</i>"],
			[4, 5, "Zweite"]
		])
	})

	it("leaves the tables out of a walk not asked for keyframes", async () => {
		const file = await mp4WithWebVtt()
		const read = (start: number, end: number) => Promise.resolve(file.slice(start, end))
		const parsed = await walkContainer(new BlockSource(file.length, read), "card")
		const subtitle = parsed?.tracks.find(track => track.kind === "subtitle")

		expect(subtitle?.kind === "subtitle" ? subtitle.tables : null).toBeUndefined()
	})
})
