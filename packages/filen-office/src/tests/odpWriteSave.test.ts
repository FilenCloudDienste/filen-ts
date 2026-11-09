import { describe, expect, it } from "vitest"
import { bytesSource, ZipArchive } from "@filen/office/core/opc"
import { odpSnapshot, saveOdp } from "../core/odp/write/save"
import { isRefused } from "../core/presentation/refusal"
import { decodeUtf8 } from "../core/xml/index"
import { odpBytes } from "./odpFixtures"
import { changes, ODP_DECK, odpDeck, openOdpDeck, saveDeck, shapeNamed, slideAt, touched } from "./odpWriteFixtures"

// Gate 2 of an ODP save: the written pages read back by the reader and compared with the session's slides.

describe("ODP save gate 2", () => {
	it("refuses as proofFailed, naming the model part of a page that reads back differently, and never closes the sink", async () => {
		const opened = await openOdpDeck(odpDeck())
		const slide = touched(slideAt(opened, 0))
		const box = shapeNamed(slide, "Box")

		// A link on an empty paragraph's mark: ODF links text (text:a), never a paragraph's end.
		box.text = {
			bodyPr: box.text?.bodyPr ?? {},
			paragraphs: [
				{
					pPr: {},
					runs: [],
					endRPr: { hlinkClick: { kind: "url", href: "https://example.org/" } }
				}
			]
		}

		let closed = false
		let written = 0
		const sink = {
			write: (chunk: Uint8Array) => {
				written += chunk.length

				return Promise.resolve()
			},
			close: () => {
				closed = true

				return Promise.resolve()
			}
		}
		const outcome = await saveOdp({ deck: opened.deck, source: { parts: opened.parts }, changes: changes(), revision: 1 }, sink)

		expect(outcome).toMatchObject({ kind: "refused", reason: "proofFailed" })
		expect(outcome.kind === "refused" ? outcome.detail : "").toMatch(
			/^page 1 \(\/content\.xml#\d+[^)]*\) reads back differently: shape \d+ \(Box\) paragraph 0 endRPr$/u
		)
		expect(outcome.kind === "refused" ? outcome.detail : "").toContain(`(${slide.part}`)
		expect(written).toBe(0)
		expect(closed).toBe(false)
	})

	it("hands the written package to the sink in chunks and closes it once", async () => {
		const opened = await openOdpDeck(odpDeck())
		const slide = touched(slideAt(opened, 0))

		shapeNamed(slide, "Box").hidden = true

		const chunks: number[] = []
		let closes = 0
		const outcome = await saveOdp(
			{ deck: opened.deck, source: { parts: opened.parts }, changes: changes(), revision: 7 },
			{
				write: chunk => {
					chunks.push(chunk.length)

					return Promise.resolve()
				},
				close: () => {
					closes++

					return Promise.resolve()
				}
			}
		)

		expect(outcome).toMatchObject({ kind: "written", revision: 7 })
		expect(closes).toBe(1)
		expect(Math.max(...chunks)).toBeLessThanOrEqual(1024 * 1024)
	})

	it("streams a package above the in-memory limit, its pages checked first and every copy checked on arrival", async () => {
		const opened = await openOdpDeck(odpDeck())
		const slide = touched(slideAt(opened, 1))

		shapeNamed(slide, "Title2").name = "Streamed"

		const chunks: Uint8Array[] = []
		const outcome = await saveOdp(
			{ deck: opened.deck, source: { parts: opened.parts }, changes: changes(), revision: 2 },
			{
				write: chunk => {
					chunks.push(chunk.slice())

					return Promise.resolve()
				},
				close: () => Promise.resolve()
			},
			{ inMemoryLimit: 0 }
		)

		expect(outcome).toMatchObject({ kind: "written", revision: 2 })

		const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
		let at = 0

		for (const chunk of chunks) {
			bytes.set(chunk, at)
			at += chunk.length
		}

		expect(shapeNamed(slideAt(await openOdpDeck(bytes), 1), "Streamed").kind).toBe("sp")
	})
})

describe("ODP writer: the streamed check's package", () => {
	const PNG = new Uint8Array([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0x90,
		0x77, 0x53, 0xde, 0, 0, 0, 12, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0, 0, 3, 1, 1, 0, 0x18, 0xdd, 0x8d, 0xb0,
		0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
	])

	for (const quote of ['"', "'"])
		it(`reads a written page's picture named by an href quoted ${quote} on both paths`, async () => {
			const kinds: string[] = []

			for (const inMemoryLimit of [Number.POSITIVE_INFINITY, 0]) {
				const body =
					'<draw:page draw:name="P" draw:master-page-name="M">' +
					`<draw:frame draw:name="Pic" svg:x="1cm" svg:y="1cm" svg:width="4cm" svg:height="4cm"><draw:image xlink:href=${quote}Pictures/a.png${quote} xlink:type="simple"/></draw:frame>` +
					'<draw:frame draw:name="T" svg:x="6cm" svg:y="1cm" svg:width="4cm" svg:height="4cm"><draw:text-box><text:p>t</text:p></draw:text-box></draw:frame>' +
					"</draw:page>"
				const opened = await openOdpDeck(odpBytes({ body, extra: [{ name: "Pictures/a.png", data: PNG, mediaType: "image/png" }] }))

				shapeNamed(touched(slideAt(opened, 0)), "T").name = "T2"
				kinds.push((await saveDeck(opened, changes(), { inMemoryLimit })).outcome.kind)
			}

			expect(kinds).toEqual(["written", "written"])
		})
})

// ODF 1.3 Part 2 §3.8: the preview shows the first page; a save that rewrites the pages drops a stale one.
describe("ODP writer: the package's preview image", () => {
	const THUMBNAIL = "Thumbnails/thumbnail.png"
	const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

	async function entryText(bytes: Uint8Array, name: string): Promise<string> {
		const archive = await ZipArchive.open(bytesSource(bytes))
		const entry = archive.get(name)

		return entry === undefined ? "" : decodeUtf8(await archive.read(entry))
	}

	it("drops the thumbnail and its manifest entry on an edit, on both paths", async () => {
		for (const inMemoryLimit of [Number.POSITIVE_INFINITY, 0]) {
			const opened = await openOdpDeck(odpBytes({ ...ODP_DECK, extra: [{ name: THUMBNAIL, data: PNG, mediaType: "image/png" }] }))

			shapeNamed(touched(slideAt(opened, 0)), "Box").hidden = true

			const { outcome, bytes } = await saveDeck(opened, changes(), { inMemoryLimit })

			expect(outcome).toMatchObject({ kind: "written" })

			const archive = await ZipArchive.open(bytesSource(bytes))

			expect(archive.get(THUMBNAIL)).toBeUndefined()
			expect(await entryText(bytes, "META-INF/manifest.xml")).not.toContain("Thumbnails")
			expect(await entryText(bytes, "META-INF/manifest.xml")).toContain('full-path="content.xml"')
		}
	})

	it("keeps the thumbnail on a save that rewrites nothing", async () => {
		const opened = await openOdpDeck(odpBytes({ ...ODP_DECK, extra: [{ name: THUMBNAIL, data: PNG, mediaType: "image/png" }] }))
		const snapshot = await odpSnapshot({ deck: opened.deck, source: { parts: opened.parts }, changes: changes(), revision: 1 })

		expect(isRefused(snapshot)).toBe(false)

		if (isRefused(snapshot)) return

		expect(snapshot.splice.content).toBeUndefined()
		expect(snapshot.changes.remove ?? []).not.toContain(THUMBNAIL)
	})
})
