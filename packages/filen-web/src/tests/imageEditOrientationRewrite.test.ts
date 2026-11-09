import { describe, expect, it } from "vitest"
import { jpegScanStart, orientationRewriteStream, ORIENTATION_REWRITE_UNAVAILABLE } from "@/features/preview/imageEdit/orientationRewrite"

// SOI, an APP1 of `app1` payload bytes, a DQT, then SOS and scan bytes.
function jpeg(app1: number, scan: number[]): Uint8Array {
	const segment = (marker: number, payload: number): number[] => [
		0xff,
		marker,
		((payload + 2) >> 8) & 0xff,
		(payload + 2) & 0xff,
		...new Array<number>(payload).fill(7)
	]

	return new Uint8Array([0xff, 0xd8, ...segment(0xe1, app1), ...segment(0xdb, 3), 0xff, 0xda, ...scan])
}

async function pipe(chunks: Uint8Array[], rewrite: (head: Uint8Array) => Uint8Array | null, max: number) {
	const stream = orientationRewriteStream(rewrite, max)
	const writing = (async () => {
		const writer = stream.writable.getWriter()

		for (const chunk of chunks) {
			await writer.write(chunk)
		}

		await writer.close()
	})()
	const out: number[] = []
	const reader = stream.readable.getReader()
	const reading = (async () => {
		for (;;) {
			const { done, value } = await reader.read()

			if (done) {
				return
			}

			out.push(...value)
		}
	})()
	const settled = await Promise.allSettled([writing, reading])

	return { out, refused: stream.refused(), failed: settled.some(result => result.status === "rejected"), settled }
}

describe("jpegScanStart", () => {
	it("finds the first SOS past every segment", () => {
		const bytes = jpeg(10, [1, 2, 3])

		expect(jpegScanStart(bytes, bytes.length)).toBe(2 + 14 + 7)
	})

	it("asks for more while a segment runs past what arrived", () => {
		const bytes = jpeg(10, [1])

		expect(jpegScanStart(bytes, 1)).toBe("more")
		expect(jpegScanStart(bytes, 8)).toBe("more")
		expect(jpegScanStart(bytes, 22)).toBe("more")
	})

	it("skips fill bytes and standalone markers", () => {
		const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xff, 0xd0, 0xff, 0xda, 9])

		expect(jpegScanStart(bytes, bytes.length)).toBe(5)
	})

	it("refuses what is not a JPEG it can walk", () => {
		expect(jpegScanStart(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 4)).toBe("invalid")
		expect(jpegScanStart(new Uint8Array([0xff, 0xd8, 0x00, 0x00]), 4)).toBe("invalid")
		expect(jpegScanStart(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x01]), 6)).toBe("invalid")
	})
})

describe("orientationRewriteStream", () => {
	it("sends the rewritten head, then every byte from the scan on untouched, across chunk boundaries", async () => {
		const bytes = jpeg(10, [1, 2, 3, 4])
		const scanAt = jpegScanStart(bytes, bytes.length) as number
		const heads: Uint8Array[] = []
		const result = await pipe(
			[bytes.subarray(0, 5), bytes.subarray(5, 20), bytes.subarray(20)],
			head => {
				heads.push(head.slice())

				return new Uint8Array([0xff, 0xd8, 0xaa])
			},
			1024
		)

		expect(result.failed).toBe(false)
		expect(heads).toEqual([bytes.slice(0, scanAt)])
		expect(result.out).toEqual([0xff, 0xd8, 0xaa, ...bytes.slice(scanAt)])
	})

	it("refuses a head past its limit, never holding more", async () => {
		const result = await pipe([jpeg(100, [1])], head => head, 32)

		expect(result.failed).toBe(true)
		expect(result.refused).toBe(true)
	})

	it("refuses when the rewriter cannot rewrite the head, and when the file ends before a scan", async () => {
		const refusedByRewriter = await pipe([jpeg(4, [1])], () => null, 1024)

		expect(refusedByRewriter.refused).toBe(true)

		const truncated = await pipe([jpeg(4, [1]).subarray(0, 12)], head => head, 1024)

		expect(truncated.refused).toBe(true)

		const reason = truncated.settled.find(settled => settled.status === "rejected")

		expect(reason?.status === "rejected" ? String(reason.reason) : "").toContain(ORIENTATION_REWRITE_UNAVAILABLE)
	})
})
