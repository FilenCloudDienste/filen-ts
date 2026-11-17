import { describe, expect, it } from "vitest"
import { USDCParser } from "three/examples/jsm/loaders/usd/USDCParser.js"

// The patched USDCParser (patches/three@0.187.0.patch) refuses what a crate declares before it builds it: tiny crates
// whose counts or sizes ask for far more than their bytes hold throw at the check, allocating nothing large.

const encoder = new TextEncoder()

// A crate (version 0.8.0) holding one TOKENS section: its token count, its LZ4 block's declared size, and the block.
function crate(numTokens: number, uncompressedSize: number, block: Uint8Array): ArrayBuffer {
	const section = new Uint8Array(24 + block.length)
	const view = new DataView(section.buffer)

	view.setBigUint64(0, BigInt(numTokens), true)
	view.setBigUint64(8, BigInt(uncompressedSize), true)
	view.setBigUint64(16, BigInt(block.length), true)
	section.set(block, 24)

	const tocOffset = 24 + section.length
	const bytes = new Uint8Array(tocOffset + 8 + 32)
	const out = new DataView(bytes.buffer)

	bytes.set(encoder.encode("PXR-USDC"))
	bytes.set([0, 8, 0], 8)
	out.setBigUint64(16, BigInt(tocOffset), true)
	bytes.set(section, 24)
	out.setBigUint64(tocOffset, 1n, true)
	bytes.set(encoder.encode("TOKENS"), tocOffset + 8)
	out.setBigUint64(tocOffset + 24, 24n, true)
	out.setBigUint64(tocOffset + 32, BigInt(section.length), true)

	return bytes.buffer
}

// One LZ4 chunk of ten literal bytes ("a" × 9 and a NUL): what a crate of a single token holds.
const TEN_LITERALS = Uint8Array.from([0, 0xa0, ...encoder.encode("aaaaaaaaa"), 0])

describe("the patched USDCParser", () => {
	it("reads a token block that holds together", () => {
		const parser = new USDCParser() as unknown as { parseData(buffer: ArrayBuffer): unknown; tokens: string[] }

		// The crate has no specs: the parse fails past the tokens, which it read.
		expect(() => parser.parseData(crate(1, 10, TEN_LITERALS))).toThrow()
		expect(parser.tokens).toEqual(["aaaaaaaaa"])
	})

	it("refuses an LZ4 block declaring more than its input can hold, before allocating its output", () => {
		const parser = new USDCParser()

		// 100 MB declared from two bytes: under the per-buffer cap, past LZ4's reach.
		expect(() => parser.parseData(crate(1, 100_000_000, Uint8Array.from([0, 0])))).toThrow(/LZ4 block declares more than its input/)
	})

	it("refuses a token count its data cannot hold, before building the list", () => {
		const parser = new USDCParser()

		expect(() => parser.parseData(crate(1_000_000_000, 10, TEN_LITERALS))).toThrow(/entries do not fit their data/)
	})

	it("refuses a float array of an unknown compression instead of zero-filling it", () => {
		const parser = new USDCParser() as unknown as {
			reader: { readInt8(): number }
			_readCompressedArray(type: number, size: number): unknown
		}

		parser.reader = { readInt8: () => 0x7a }

		// TypeEnum.Float.
		expect(() => parser._readCompressedArray(8, 1000)).toThrow(/unknown float compression code/)
	})
})
