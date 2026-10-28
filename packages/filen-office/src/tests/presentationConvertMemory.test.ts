import { describe, expect, it } from "vitest"
import { convertPresentation } from "../core/convert/presentation/index"
import { openOdp } from "../core/odp/read/document"
import { bytesSource, type ByteSink } from "../core/opc/index"
import { liveHeap, liveHeapNow } from "./liveHeap"
import { odpBytes } from "./odpFixtures"

// A conversion to PresentationML streams what it copies from the source (a medium, a picture) from its zip entry into
// the package and the package into the sink: its memory does not grow with what the source declares, and a part
// declaring more than its class may hold (core/opc/mediaPolicy.ts) is refused, typed, before it is read.

const MB = 1024 * 1024

function deck(name: string, size: number, frame: string, mediaType: string): Uint8Array {
	let data: Uint8Array | undefined = new Uint8Array(size)

	// An MP4 file type box, so the medium sniffs as one.
	data.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])

	const file = odpBytes({
		body: `<draw:page draw:name="One" draw:master-page-name="M"><draw:frame draw:name="Clip" svg:x="6cm" svg:y="1cm" svg:width="8cm" svg:height="4.5cm">${frame}</draw:frame></draw:page>`,
		extra: [{ name, data, mediaType }]
	})

	data = undefined

	return file
}

describe("conversions to PresentationML in bounded memory", () => {
	it("streams a 256 MiB medium into the .pptx within 64 MiB of live heap", { timeout: 600_000 }, async () => {
		const file = deck(
			"Media/clip.mp4",
			256 * MB,
			'<draw:plugin xlink:href="Media/clip.mp4" xlink:type="simple" draw:mime-type="video/mp4"/>',
			"video/mp4"
		)
		const opened = await openOdp(bytesSource(file))

		if (opened.kind !== "opened") throw new Error(opened.reason)

		const before = await liveHeap()
		let peak = 0
		let written = 0
		const sink: ByteSink = {
			write: chunk => {
				written += chunk.length
				// Sampled every 16 MiB: each sample collects twice.
				if (written % (16 * MB) < chunk.length) peak = Math.max(peak, liveHeapNow() - before)

				return Promise.resolve()
			},
			close: () => Promise.resolve()
		}
		const converted = await convertPresentation(opened.deck, { format: "odp", parts: opened.parts }, "pptx", sink)

		expect("kind" in converted ? converted : converted.bytes).toBe(written)
		expect(written).toBeGreaterThan(256 * MB)
		expect(peak).toBeGreaterThan(0)
		expect(peak).toBeLessThan(64 * MB)
	})

	it("refuses, typed, a picture declaring more than a picture may hold", { timeout: 600_000 }, async () => {
		const file = deck("Pictures/big.png", 257 * MB, '<draw:image xlink:href="Pictures/big.png" xlink:type="simple"/>', "image/png")
		const opened = await openOdp(bytesSource(file))

		if (opened.kind !== "opened") throw new Error(opened.reason)

		let written = 0
		const sink: ByteSink = {
			write: chunk => {
				written += chunk.length

				return Promise.resolve()
			},
			close: () => Promise.resolve()
		}

		expect(await convertPresentation(opened.deck, { format: "odp", parts: opened.parts }, "pptx", sink)).toMatchObject({
			kind: "refused",
			reason: "tooLarge"
		})
		expect(written).toBeLessThan(MB)
	})
})
