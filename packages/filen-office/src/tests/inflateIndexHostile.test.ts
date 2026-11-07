import { describe, expect, it } from "vitest"
import { crc32, ZipError } from "@filen/office/core/opc"
import { deflateBound, InflateIndex, type InflateInput } from "../core/opc/inflateIndex"
import { budget, cpuMs } from "./timing"

// Deflate streams built to cost time without output: an entry whose compressed bytes pass what its size can need is
// refused before a byte is read, and within that bound a run of empty blocks is decoded in slices the clock bounds,
// with checkpoints by input so a read after it never decodes it again.

function counted(compressed: Uint8Array, reads: { bytes: number }): InflateInput {
	return {
		size: compressed.length,
		read: (offset, length) => {
			reads.bytes += length

			return Promise.resolve(compressed.slice(offset, offset + length))
		}
	}
}

class Bits {
	private readonly bytes: number[] = []
	private acc = 0
	private n = 0

	put(value: number, count: number): void {
		for (let k = 0; k < count; k++) {
			this.acc |= ((value >>> k) & 1) << this.n
			this.n++

			if (this.n === 8) {
				this.bytes.push(this.acc)
				this.acc = 0
				this.n = 0
			}
		}
	}

	// A Huffman code, most significant bit first.
	code(value: number, length: number): void {
		for (let k = length - 1; k >= 0; k--) this.put((value >>> k) & 1, 1)
	}

	get length(): number {
		return this.bytes.length
	}

	done(): Uint8Array {
		if (this.n > 0) this.bytes.push(this.acc)

		return Uint8Array.from(this.bytes)
	}
}

// An empty fixed-code block: its header and the end-of-block code (RFC 1951 §3.2.6: 256 is 0000000).
function emptyFixedBlock(bits: Bits): void {
	bits.put(0, 1)
	bits.put(1, 2)
	bits.code(0, 7)
}

// A final fixed-code block of `count` zero bytes: a literal 0 then matches of 258 at distance 1.
function zeros(bits: Bits, count: number): void {
	bits.put(1, 1)
	bits.put(1, 2)
	bits.code(0x30, 8)

	let left = count - 1

	while (left >= 258) {
		// Length 258: symbol 285, an 8-bit code (280..287 → 11000000 + n); distance 1: code 0 of 5 bits.
		bits.code(0xc0 + 5, 8)
		bits.code(0, 5)
		left -= 258
	}

	for (; left > 0; left--) bits.code(0x30, 8)

	bits.code(0, 7)
}

const SIZE = 4 * 1024 * 1024

// Empty blocks up to the bound's slack, then SIZE zero bytes.
function padded(): Uint8Array {
	const bits = new Bits()

	while (bits.length < SIZE - 64 * 1024) emptyFixedBlock(bits)

	zeros(bits, SIZE)

	return bits.done()
}

describe("hostile deflate streams", () => {
	it("refuses an entry whose compressed bytes pass what its size can need, before reading any", async () => {
		const reads = { bytes: 0 }
		const compressed = new Uint8Array(deflateBound(1000) + 1)

		await expect(InflateIndex.build(counted(compressed, reads), { size: 1000, crc32: 0 })).rejects.toBeInstanceOf(ZipError)
		expect(reads.bytes).toBe(0)
	})

	it("decodes empty blocks in slices the clock bounds, and reads after them start past them", async () => {
		const compressed = padded()
		const raw = new Uint8Array(SIZE)

		expect(compressed.length).toBeLessThanOrEqual(deflateBound(SIZE))

		// The longest slice in this thread's CPU time: what a slice computed between two yields, not the wall time a
		// busy machine adds while the thread waits.
		let longest = 0
		let last = cpuMs()
		const slicing = {
			sliceMs: 8,
			now: () => performance.now(),
			pause: () => {
				longest = Math.max(longest, cpuMs() - last)

				return new Promise<void>(resolve => {
					setImmediate(() => {
						last = cpuMs()
						resolve()
					})
				})
			}
		}
		const reads = { bytes: 0 }
		const start = cpuMs()
		const index = await InflateIndex.build(counted(compressed, reads), { size: SIZE, crc32: crc32(raw), slicing })
		const spent = cpuMs() - start
		const perMiB = spent / (compressed.length / 1_048_576)

		process.stdout.write(
			`empty fixed blocks: ${String(compressed.length)} B → ${String(SIZE)} B, ${spent.toFixed(0)} ms CPU (${perMiB.toFixed(0)} ms/MiB), longest slice ${longest.toFixed(1)} ms, ${String(index.checkpoints.length)} checkpoints\n`
		)
		expect(perMiB).toBeLessThan(budget(200))
		expect(longest).toBeLessThan(budget(50))

		// The first byte's checkpoint is past the empty blocks: the read takes the zeros' block only.
		reads.bytes = 0

		expect(Array.from(await index.read(0, 4))).toEqual([0, 0, 0, 0])
		expect(reads.bytes).toBeLessThanOrEqual(3 * 1024 * 1024)
	}, 60_000)
})
