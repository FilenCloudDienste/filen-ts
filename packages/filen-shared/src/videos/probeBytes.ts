import type { BlockSource } from "./blockSource"

// Byte-level helpers shared by the container walkers. Every reader tolerates an index past the end
// (reading zeros) so a hostile length can only ever produce a wrong value, never an exception.

// A structure the walkers refuse: a size past its parent, an impossible field, a cap exceeded.
export class MalformedError extends Error {
	public constructor(what: string) {
		super(`malformed container: ${what}`)
		this.name = "MalformedError"
	}
}

export async function readBytes(source: BlockSource, start: number, length: number): Promise<Uint8Array> {
	if (!Number.isSafeInteger(length) || length < 0) {
		throw new MalformedError("impossible read length")
	}

	const bytes = new Uint8Array(length)

	await source.read(bytes, start, length)

	return bytes
}

// Fixed-width unsigned integer readers for the container and file-format parsers. Each reads a missing byte past the
// end as zero, so a hostile length can only produce a wrong value, never an exception, and none can come out negative.

export function uint16le(bytes: Uint8Array, at: number): number {
	return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8)
}

export function uint16be(bytes: Uint8Array, at: number): number {
	return ((bytes[at] ?? 0) << 8) + (bytes[at + 1] ?? 0)
}

export function uint24be(bytes: Uint8Array, at: number): number {
	return ((bytes[at] ?? 0) << 16) + ((bytes[at + 1] ?? 0) << 8) + (bytes[at + 2] ?? 0)
}

export function uint32le(bytes: Uint8Array, at: number): number {
	return uint16le(bytes, at) + uint16le(bytes, at + 2) * 0x10000
}

export function uint32be(bytes: Uint8Array, at: number): number {
	return (bytes[at] ?? 0) * 0x1000000 + uint24be(bytes, at + 1)
}

// The four bytes at `at` as Latin-1 text: a FourCC or chunk id.
export function fourCC(bytes: Uint8Array, at: number): string {
	return String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0)
}

// The walkers' names for the big-endian readers.
export { uint16be as uint16, uint32be as uint32 }

export function int32(bytes: Uint8Array, at: number): number {
	const value = uint32be(bytes, at)

	return value >= 0x80000000 ? value - 0x100000000 : value
}

// Null past 2^53, where a JS number stops being exact.
export function uint64(bytes: Uint8Array, at: number): number | null {
	const high = uint32be(bytes, at)

	return high >= 0x200000 ? null : high * 0x100000000 + uint32be(bytes, at + 4)
}

export function ascii(bytes: Uint8Array, start: number, end: number): string {
	let text = ""

	for (let i = start; i < end; i++) {
		text += String.fromCharCode(bytes[i] ?? 0)
	}

	return text
}

interface Utf8Decoder {
	decode(input: Uint8Array): string
}

// Built on first use, so evaluating this module has no side effects (on Hermes, TextDecoder is a global Expo
// installs lazily).
let utf8Decoder: Utf8Decoder | null = null

// Text with trailing NULs dropped; null when empty.
export function utf8(bytes: Uint8Array, start: number, end: number): string | null {
	utf8Decoder ??= new (globalThis as unknown as { TextDecoder: new () => Utf8Decoder }).TextDecoder()

	const text = utf8Decoder.decode(bytes.subarray(start, Math.max(start, end))).replace(/\0+$/, "")

	return text === "" ? null : text
}

export function fourcc(value: number): string {
	return String.fromCharCode((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
}

// Rounds away float noise from scaled timestamps (30037 × 1e6 / 1e9).
export function seconds(value: number): number {
	return Math.round(value * 1e6) / 1e6
}

export interface DolbyVisionConfig {
	profile: number
	level: number
	// dv_bl_signal_compatibility_id: 0 when no base layer plays without Dolby Vision.
	compat: number
}

// DOVIDecoderConfigurationRecord (MP4 dvcC/dvvC/dvwC, Matroska BlockAddIDExtraData): version (2 bytes),
// dv_profile (7 bits), dv_level (6), three layer flags, then the compatibility ID (4).
export function parseDolbyVision(bytes: Uint8Array): DolbyVisionConfig | null {
	const packed = bytes[2]
	const levelLow = bytes[3]
	const flags = bytes[4]

	if (packed === undefined || levelLow === undefined || flags === undefined) {
		return null
	}

	return { profile: packed >> 1, level: ((packed & 1) << 5) | (levelLow >> 3), compat: flags >> 4 }
}

// ISO/IEC 23091-2 TransferCharacteristics: 16 is SMPTE ST 2084, 18 is ARIB STD-B67.
export function transferKind(transfer: number | null): "sdr" | "pq" | "hlg" {
	return transfer === 16 ? "pq" : transfer === 18 ? "hlg" : "sdr"
}

// The four-byte prefixes of the cover image formats a container may hold.
export function sniffImageMime(bytes: Uint8Array): string | null {
	if (bytes[0] === 0xff && bytes[1] === 0xd8) {
		return "image/jpeg"
	}

	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
		return "image/png"
	}

	if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") {
		return "image/webp"
	}

	if (ascii(bytes, 0, 3) === "GIF") {
		return "image/gif"
	}

	if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
		return "image/bmp"
	}

	return null
}

// The file is not a container the probe reads (or not a video one); final for the file.
export class UnsupportedContainerError extends Error {
	public constructor() {
		super("unsupported container")
		this.name = "UnsupportedContainerError"
	}
}

// The most downloads any probe may grow to, however large a header claims to be: a ten-hour film's
// `moov` is about 15 MiB, so past this the file is not one worth walking.
export const MAX_PROBE_BLOCK_READS = 32

// Lets the walk make `extra` more downloads than it has made so far, within the overall cap.
export function raiseBudget(source: BlockSource, extra: number): void {
	source.allowBlockReads(Math.min(MAX_PROBE_BLOCK_READS, source.blockReads + extra))
}
