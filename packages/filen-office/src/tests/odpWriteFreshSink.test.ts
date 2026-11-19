import { describe, expect, it, vi } from "vitest"
import { bytesSource, memorySink, writeZip, ZipArchive, type ByteSink, type ByteSource } from "@filen/office/core/opc"
import { newOdfPlan } from "../core/odf/index"
import { freshOdp, writeFreshOdp } from "../core/odp/write/fresh"
import { openPptx } from "../core/pptx/package"
import { pptxServices } from "./odpWriteFreshFixtures"
import { pictureDeck } from "./presentationObjectsFixtures"

// The fresh ODP package is read back from its XML parts alone before anything reaches the sink, then streamed to the
// sink: the pictures are never held a second time as a zip in memory, a refused read-back leaves the sink untouched
// and open, and the package written is the one the parts make.

const read = vi.hoisted(() => ({ entries: [] as string[][], refuse: false }))

vi.mock("../core/odp/read/document", async importOriginal => {
	const original = await importOriginal<typeof import("../core/odp/read/document")>()

	return {
		...original,
		openOdp: async (source: ByteSource, ...rest: unknown[]) => {
			read.entries.push((await ZipArchive.open(source)).entries.map(entry => entry.name))

			if (read.refuse) return { kind: "refused", reason: "malformed", detail: "refused by the test" }

			return (original.openOdp as (source: ByteSource, ...rest: unknown[]) => unknown)(source, ...rest)
		}
	}
})

async function converting() {
	const opened = await openPptx(bytesSource(pictureDeck()))

	if (opened.kind !== "opened") throw new Error(opened.reason)

	await opened.parts.parseAll()

	const services = pptxServices(opened.deck, opened.parts)

	await services.preload()

	return { deck: opened.deck, services }
}

function recordingSink(): ByteSink & { readonly writes: number; readonly closed: boolean; bytes(): Uint8Array } {
	const memory = memorySink()
	let writes = 0
	let closed = false

	return {
		get writes() {
			return writes
		},
		get closed() {
			return closed
		},
		write: chunk => {
			writes++

			return memory.write(chunk)
		},
		close: () => {
			closed = true

			return memory.close()
		},
		bytes: () => memory.bytes()
	}
}

describe("the fresh ODP package written to a sink", () => {
	it("is read back without its pictures, then written whole as its parts make it", async () => {
		const { deck, services } = await converting()
		const sink = recordingSink()

		read.entries.length = 0
		read.refuse = false

		const written = await writeFreshOdp(deck, services, sink)

		expect("kind" in written).toBe(false)
		expect(read.entries).toHaveLength(1)
		expect(read.entries[0]).toContain("content.xml")
		expect(read.entries[0]?.some(name => name.startsWith("Pictures/"))).toBe(false)
		expect(sink.closed).toBe(true)

		const fresh = await freshOdp(deck, services)

		if ("kind" in fresh) throw new Error(fresh.reason)

		const expected = memorySink()

		await writeZip(newOdfPlan({ mediaType: fresh.mediaType, parts: fresh.parts }), null, expected)

		const out = await ZipArchive.open(bytesSource(sink.bytes()))

		expect(out.entries.some(entry => entry.name.startsWith("Pictures/"))).toBe(true)
		expect(Buffer.from(sink.bytes()).equals(Buffer.from(expected.bytes()))).toBe(true)
	})

	it("is refused before the sink is written or closed when its read-back fails", async () => {
		const { deck, services } = await converting()
		const sink = recordingSink()

		read.refuse = true

		try {
			expect(await writeFreshOdp(deck, services, sink)).toMatchObject({ kind: "refused", reason: "proofFailed" })
		} finally {
			read.refuse = false
		}

		expect(sink.writes).toBe(0)
		expect(sink.closed).toBe(false)
	})
})
