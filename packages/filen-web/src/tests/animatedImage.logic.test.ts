import { describe, expect, it } from "vitest"
import { pngChunk } from "@/features/preview/imageEdit/lib/pngMeta"
import {
	animatedImageType,
	animationKeyCommand,
	frameDelayMs,
	nextFramePosition,
	SHORT_FRAME_DELAY_MS,
	stepFrameIndex
} from "@/features/preview/lib/animatedImage.logic"

// Which heads say "animation", and the frame clock's rules.

function concat(...parts: (Uint8Array | readonly number[])[]): Uint8Array {
	return Uint8Array.from(parts.flatMap(part => [...part]))
}

function ascii(text: string): Uint8Array {
	return new TextEncoder().encode(text)
}

function u32be(value: number): number[] {
	return [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
}

function u32le(value: number): number[] {
	return u32be(value).toReversed()
}

// ── GIF ──────────────────────────────────────────────────────────────────────

function gif(frames: number, loop = false): Uint8Array {
	const header = concat(ascii("GIF89a"), [10, 0, 8, 0, 0x80, 0, 0], new Uint8Array(6))
	const netscape = loop ? concat([0x21, 0xff, 11], ascii("NETSCAPE2.0"), [3, 1, 0, 0, 0]) : new Uint8Array()
	const frame = concat([0x21, 0xf9, 4, 0, 0, 0, 0, 0], [0x2c, 0, 0, 0, 0, 10, 0, 8, 0, 0], [2, 2, 0x4c, 0x01, 0])

	return concat(header, netscape, ...Array.from({ length: frames }, () => frame), [0x3b])
}

// ── PNG / APNG ───────────────────────────────────────────────────────────────

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const IHDR = pngChunk("IHDR", Uint8Array.from([...u32be(4), ...u32be(3), 8, 6, 0, 0, 0]))
const ACTL = pngChunk("acTL", Uint8Array.from([...u32be(2), ...u32be(0)]))
const IDAT = pngChunk("IDAT", Uint8Array.from([0x78, 0x9c, 0x63, 0, 0, 0, 1, 0, 1]))
const IEND = pngChunk("IEND", new Uint8Array())

// ── WebP ─────────────────────────────────────────────────────────────────────

function riffChunk(type: string, data: readonly number[]): Uint8Array {
	return concat(ascii(type), u32le(data.length), data, data.length % 2 === 1 ? [0] : [])
}

function webp(...chunks: Uint8Array[]): Uint8Array {
	const body = concat(ascii("WEBP"), ...chunks)

	return concat(ascii("RIFF"), u32le(body.length), body)
}

function vp8x(flags: number): Uint8Array {
	return riffChunk("VP8X", [flags, 0, 0, 0, 2, 0, 0, 2, 0, 0])
}

const VP8L = riffChunk("VP8L", [0x2f, ...u32le((2 | (2 << 14)) >>> 0), 0])

// ── AVIF ─────────────────────────────────────────────────────────────────────

function ftyp(major: string, ...compatible: string[]): Uint8Array {
	const brands = concat(ascii(major), u32be(0), ...compatible.map(ascii))

	return concat(u32be(8 + brands.length), ascii("ftyp"), brands)
}

describe("animatedImageType", () => {
	it("takes a GIF with a second image, not a single one", () => {
		const two = gif(2)
		const one = gif(1)

		expect(animatedImageType(two, two.length)).toBe("image/gif")
		expect(animatedImageType(one, one.length)).toBeNull()
	})

	it("takes a looping GIF whose head ends before a second image", () => {
		const head = gif(1, true).subarray(0, -1)

		expect(animatedImageType(head, 1_000_000)).toBe("image/gif")
		// The whole file read: one image, looping block or not, is a still.
		expect(animatedImageType(gif(1, true), gif(1, true).length)).toBeNull()
	})

	it("takes a PNG with acTL before its first IDAT only", () => {
		const apng = concat(PNG_SIGNATURE, IHDR, ACTL, IDAT, IEND)
		const late = concat(PNG_SIGNATURE, IHDR, IDAT, ACTL, IEND)
		const still = concat(PNG_SIGNATURE, IHDR, IDAT, IEND)

		expect(animatedImageType(apng, apng.length)).toBe("image/png")
		expect(animatedImageType(late, late.length)).toBeNull()
		expect(animatedImageType(still, still.length)).toBeNull()
	})

	it("takes a WebP with the VP8X animation flag, not a still", () => {
		const animated = webp(vp8x(0x02), riffChunk("ANIM", [0, 0, 0, 0, 0, 0]))
		const extendedStill = webp(vp8x(0), VP8L)
		const simple = webp(VP8L)

		expect(animatedImageType(animated, animated.length)).toBe("image/webp")
		expect(animatedImageType(extendedStill, extendedStill.length)).toBeNull()
		expect(animatedImageType(simple, simple.length)).toBeNull()
	})

	it("takes an AVIF image sequence by its brand, not a still AVIF", () => {
		const sequence = concat(ftyp("avis", "avis", "msf1", "iso8", "mif1"), u32be(8), ascii("moov"))
		const still = concat(ftyp("avif", "avif", "mif1"), u32be(8), ascii("mdat"))

		expect(animatedImageType(sequence, sequence.length)).toBe("image/avif")
		expect(animatedImageType(still, still.length)).toBeNull()
	})

	it("takes nothing else", () => {
		expect(animatedImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), 6)).toBeNull()
		expect(animatedImageType(new Uint8Array(), 0)).toBeNull()
	})
})

describe("frameDelayMs", () => {
	it("keeps a frame's own delay, divided by the rate", () => {
		expect(frameDelayMs(70_000, 1)).toBe(70)
		expect(frameDelayMs(70_000, 2)).toBe(35)
		expect(frameDelayMs(20_000, 1)).toBe(20)
	})

	it("shows a frame of 10 ms or less, or of no duration, for 100 ms as browsers do", () => {
		expect(frameDelayMs(0, 1)).toBe(SHORT_FRAME_DELAY_MS)
		expect(frameDelayMs(10_000, 1)).toBe(SHORT_FRAME_DELAY_MS)
		expect(frameDelayMs(null, 1)).toBe(SHORT_FRAME_DELAY_MS)
		expect(frameDelayMs(11_000, 1)).toBe(11)
		expect(frameDelayMs(0, 0.5)).toBe(200)
	})
})

describe("nextFramePosition", () => {
	it("steps through the frames, then loops as often as the file says", () => {
		expect(nextFramePosition({ index: 0, plays: 0 }, 3, true, 0)).toEqual({ index: 1, plays: 0 })
		// Played once, no repeats: the end.
		expect(nextFramePosition({ index: 2, plays: 0 }, 3, true, 0)).toBeNull()
		// One repeat: back to the start once.
		expect(nextFramePosition({ index: 2, plays: 0 }, 3, true, 1)).toEqual({ index: 0, plays: 1 })
		expect(nextFramePosition({ index: 2, plays: 1 }, 3, true, 1)).toBeNull()
		expect(nextFramePosition({ index: 2, plays: 1_000 }, 3, true, Number.POSITIVE_INFINITY)).toEqual({ index: 0, plays: 1_001 })
	})

	it("waits for a frame past the known ones while bytes still arrive", () => {
		expect(nextFramePosition({ index: 2, plays: 0 }, 3, false, 0)).toEqual({ index: 3, plays: 0 })
	})
})

describe("stepFrameIndex", () => {
	it("stays within the frames known", () => {
		expect(stepFrameIndex(0, -1, 4, true)).toBe(0)
		expect(stepFrameIndex(3, 1, 4, true)).toBe(3)
		expect(stepFrameIndex(3, 1, 4, false)).toBe(4)
		expect(stepFrameIndex(2, -1, 4, true)).toBe(1)
	})
})

describe("animationKeyCommand", () => {
	it("steps a frame on the seek and frame keys", () => {
		expect(animationKeyCommand("media.seekBack", 1)).toEqual({ type: "step", direction: -1 })
		expect(animationKeyCommand("media.frameForward", 1)).toEqual({ type: "step", direction: 1 })
		expect(animationKeyCommand("media.playPause", 1)).toEqual({ type: "toggle" })
		expect(animationKeyCommand("media.faster", 1)).toEqual({ type: "rate", rate: 1.25 })
		expect(animationKeyCommand("media.mute", 1)).toBeNull()
	})
})
