import { describe, expect, it } from "vitest"
import { openOdp } from "../core/odp/read/document"
import { writeFreshOdp } from "../core/odp/write/fresh"
import { bytesSource, memorySink } from "@filen/office/core/opc"
import { slideRef, type FillProps, type LineProps, type ShapeNode } from "../core/presentation/model"
import { FIXTURE_FIRST_SLIDE, fixtureDeck } from "./fixtures/presentation/deck"
import { entriesOf, text } from "./odpWriteFixtures"

// Gradients, patterns, picture fills, group fills, dashes and line ends of a converted deck written as ODF's drawing
// resources (ODF 1.3 Part 3 §16.40–§16.45) in office:styles, and read back as the fills and lines they were.

const BOX = { x: 914_400, y: 914_400, cx: 2_000_000, cy: 1_000_000, rot: 0, flipH: false, flipV: false }
const RED = { kind: "srgb", rgb: "FF0000" } as const
const BLUE = { kind: "srgb", rgb: "0000FF" } as const
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function rect(id: number, name: string, fill?: FillProps, ln?: LineProps): ShapeNode {
	return {
		id,
		name,
		hidden: false,
		kind: "sp",
		xfrm: BOX,
		props: {
			geometry: { kind: "preset", preset: "ellipse", guides: [] },
			...(fill === undefined ? {} : { fill }),
			...(ln === undefined ? {} : { ln })
		}
	}
}

async function convert(shapes: ShapeNode[]) {
	const deck = fixtureDeck(1)
	const slide = deck.nodes.get(slideRef(FIXTURE_FIRST_SLIDE))

	if (slide === undefined) throw new Error("fixture slide missing")

	slide.shapes.push(...shapes)

	const sink = memorySink()
	const written = await writeFreshOdp(
		deck,
		{
			theme: () => undefined,
			picture: part => Promise.resolve(part === "/ppt/media/image1.png" ? { bytes: PNG, mediaType: "image/png" } : undefined)
		},
		sink
	)

	if ("kind" in written) throw new Error(`refused ${written.reason}`)

	const entries = await entriesOf(sink.bytes())
	const opened = await openOdp(bytesSource(sink.bytes()))

	if (opened.kind !== "opened") throw new Error(opened.reason)

	await opened.parts.parseAll()

	const page = opened.deck.nodes.get(opened.deck.slides[0] ?? slideRef(0))
	const shape = (name: string): ShapeNode | undefined => {
		const find = (list: readonly ShapeNode[]): ShapeNode | undefined => {
			for (const each of list) {
				if (each.name === name) return each

				const inner = each.children === undefined ? undefined : find(each.children)

				if (inner !== undefined) return inner
			}

			return undefined
		}

		return find(page?.shapes ?? [])
	}

	return { report: written.report, styles: text(entries.get("styles.xml")), entries, shape }
}

describe("fresh ODP drawing resources", () => {
	it("writes a two-stop linear gradient as draw:gradient and reads it back", async () => {
		const gradient: FillProps = {
			kind: "gradient",
			stops: [
				{ pos: 0, color: RED },
				{ pos: 100_000, color: BLUE }
			],
			linear: { angle: 5_400_000, scaled: false }
		}
		const { styles, shape, report } = await convert([rect(60, "Gradient", gradient)])

		expect(styles).toMatch(
			/<draw:gradient draw:name="[^"]+" draw:style="linear" draw:angle="0deg" draw:start-color="#ff0000" draw:end-color="#0000ff"/u
		)
		expect(shape("Gradient")?.props?.fill).toMatchObject({
			kind: "gradient",
			stops: [
				{ pos: 0, color: RED },
				{ pos: 100_000, color: BLUE }
			]
		})
		expect(report.approximated["gradient fill"]).toBeUndefined()
	})

	it("writes a mirrored three-stop gradient as axial and a circle path as radial", async () => {
		const axial: FillProps = {
			kind: "gradient",
			stops: [
				{ pos: 0, color: RED },
				{ pos: 50_000, color: BLUE },
				{ pos: 100_000, color: RED }
			],
			linear: { angle: 0, scaled: false }
		}
		const radial: FillProps = {
			kind: "gradient",
			stops: [
				{ pos: 0, color: BLUE },
				{ pos: 100_000, color: RED }
			],
			path: { shape: "circle", fillTo: { l: 50_000, t: 50_000, r: 50_000, b: 50_000 } }
		}
		const { styles, report } = await convert([rect(61, "Axial", axial), rect(62, "Radial", radial)])

		expect(styles).toMatch(/draw:style="axial" draw:angle="90deg" draw:start-color="#ff0000" draw:end-color="#0000ff"/u)
		expect(styles).toMatch(/draw:style="radial" draw:cx="50%" draw:cy="50%" draw:start-color="#ff0000" draw:end-color="#0000ff"/u)
		expect(report.approximated["gradient of more than two stops"]).toBeUndefined()
	})

	it("writes a preset pattern as its 8 × 8 tile, repeated", async () => {
		const { styles, entries, shape } = await convert([rect(63, "Pattern", { kind: "pattern", preset: "dkDnDiag", fg: RED, bg: BLUE })])
		const href = /<draw:fill-image draw:name="[^"]+" xlink:href="([^"]+)"/u.exec(styles)?.[1] ?? ""

		expect(entries.has(href)).toBe(true)
		expect(shape("Pattern")?.props?.fill).toMatchObject({ kind: "picture", part: `/${href}` })
	})

	it("writes a picture fill with the picture copied, and a member's group fill as its group's", async () => {
		const group: ShapeNode = {
			id: 64,
			name: "Group",
			hidden: false,
			kind: "grpSp",
			xfrm: { ...BOX, chX: 0, chY: 0, chCx: BOX.cx, chCy: BOX.cy },
			props: { fill: { kind: "solid", color: BLUE } },
			children: [{ ...rect(65, "Member", { kind: "group" }), xfrm: { ...BOX, x: 0, y: 0 } }]
		}
		const { shape, report } = await convert([rect(66, "Picture", { kind: "picture", part: "/ppt/media/image1.png" }), group])

		expect(shape("Picture")?.props?.fill).toMatchObject({ kind: "picture" })
		expect(shape("Member")?.props?.fill).toMatchObject({ kind: "solid", color: BLUE })
		expect(report.omitted["picture fill"]).toBeUndefined()
		expect(report.omitted["group fill"]).toBeUndefined()
	})

	it("writes a dashed line with ends as draw:stroke-dash and draw:marker, read back as its ends", async () => {
		const ln: LineProps = {
			w: 25_400,
			fill: { kind: "solid", color: RED },
			dash: "dashDot",
			head: { type: "oval", w: "sm", len: "sm" },
			tail: { type: "triangle", w: "lg", len: "lg" }
		}
		const { styles, shape, report } = await convert([rect(67, "Dashed", undefined, ln)])
		const read = shape("Dashed")?.props?.ln

		expect(styles).toMatch(
			/<draw:stroke-dash draw:name="[^"]+" draw:style="rect" draw:dots1="1" draw:dots1-length="400%" draw:dots2="1" draw:dots2-length="100%" draw:distance="300%"/u
		)
		expect(read).toMatchObject({ head: { type: "oval", w: "sm" }, tail: { type: "triangle", w: "lg" } })
		expect(read === "none" ? undefined : read?.custDash?.length).toBe(4)
		expect(report.omitted["line end"]).toBeUndefined()
		expect(report.approximated["dashed line"]).toBeUndefined()
	})
})
