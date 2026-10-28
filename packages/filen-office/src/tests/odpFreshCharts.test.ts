import { describe, expect, it } from "vitest"
import { drawingTheme } from "../core/drawingml/color"
import { presentationChartObject } from "../core/odp/write/chartObject"
import { freshOdp } from "../core/odp/write/fresh"
import { slideRef, type ShapeNode } from "../core/presentation/model"
import { decodeUtf8, encodeUtf8, parseXml } from "../core/xml/index"
import { FIXTURE_FIRST_SLIDE, fixtureDeck } from "./fixtures/presentation/deck"

// A converted deck's chart is an ODF chart object (ODF 1.3 Part 3 §11) reading a table of its own that holds the
// part's cached data (a presentation has no sheet the object could read), embedded as draw:object.

const C = 'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'

function series(index: number, name: string, values: readonly number[]): string {
	const points = (list: readonly (string | number)[]) =>
		`<c:ptCount val="${String(list.length)}"/>${list.map((value, k) => `<c:pt idx="${String(k)}"><c:v>${String(value)}</c:v></c:pt>`).join("")}`

	return (
		`<c:ser><c:idx val="${String(index)}"/><c:order val="${String(index)}"/>` +
		`<c:tx><c:strRef><c:f>Sheet1!$${"BC"[index] ?? "B"}$1</c:f><c:strCache>${points([name])}</c:strCache></c:strRef></c:tx>` +
		`<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$4</c:f><c:strCache>${points(["North", "South", "West"])}</c:strCache></c:strRef></c:cat>` +
		`<c:val><c:numRef><c:f>Sheet1!$${"BC"[index] ?? "B"}$2:$${"BC"[index] ?? "B"}$4</c:f><c:numCache>${points(values)}</c:numCache></c:numRef></c:val></c:ser>`
	)
}

const CHART =
	`<c:chartSpace ${C}><c:chart><c:plotArea><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>` +
	`${series(0, "Sales", [4.5, 2, 3])}${series(1, "Costs", [1, 1.5, 2])}<c:axId val="1"/><c:axId val="2"/></c:barChart>` +
	'<c:catAx><c:axId val="1"/><c:crossAx val="2"/></c:catAx><c:valAx><c:axId val="2"/><c:crossAx val="1"/></c:valAx></c:plotArea></c:chart></c:chartSpace>'

describe("fresh ODP charts", () => {
	it("writes a chart part as an object reading its own table of the part's cached data", () => {
		const object = presentationChartObject(
			parseXml(encodeUtf8(CHART)),
			drawingTheme(undefined, () => undefined),
			"10cm",
			"6cm"
		)

		if (object === undefined) throw new Error("no object")

		const content = decodeUtf8(object.content)

		expect(content).toContain('chart:class="chart:bar"')
		expect(content).toMatch(/<table:table table:name="local-table">/u)
		// The header row names the series, the first column the categories, a column per series.
		expect(content).toMatch(
			/<table:table-header-rows><table:table-row><table:table-cell\/><table:table-cell office:value-type="string"><text:p>Sales<\/text:p>/u
		)
		expect(content).toContain('office:value="4.5"')
		expect(content).toContain("<text:p>West</text:p>")
		expect(content).toMatch(/chart:values-cell-range-address="&apos;local-table&apos;\.B2:&apos;local-table&apos;\.B4"/u)
		expect(content).toMatch(/chart:values-cell-range-address="&apos;local-table&apos;\.C2:&apos;local-table&apos;\.C4"/u)
	})

	it("puts a series' own name into the table, read by reference (no foreign attribute)", () => {
		const literal = CHART.replace(
			/<c:tx><c:strRef><c:f>Sheet1!\$B\$1<\/c:f><c:strCache>.*?<\/c:strCache><\/c:strRef><\/c:tx>/u,
			"<c:tx><c:v>Own name</c:v></c:tx>"
		)
		const object = presentationChartObject(
			parseXml(encodeUtf8(literal)),
			drawingTheme(undefined, () => undefined),
			"10cm",
			"6cm"
		)
		const content = object === undefined ? "" : decodeUtf8(object.content)

		expect(literal).toContain("Own name")
		expect(content).toContain("<text:p>Own name</text:p>")
		expect(content).not.toContain("loext:label-string")
		expect(content).toMatch(/chart:label-cell-address="&apos;local-table&apos;\.B1"/u)
	})

	it("embeds the object as draw:object with its manifest entry, and names a chart it cannot write", async () => {
		const deck = fixtureDeck(1)
		const slide = deck.nodes.get(slideRef(FIXTURE_FIRST_SLIDE))

		if (slide === undefined) throw new Error("fixture slide missing")

		const frame = (id: number, part: string): ShapeNode => ({
			id,
			name: `Chart ${String(id)}`,
			hidden: false,
			kind: "frame",
			xfrm: { x: 914_400, y: 914_400, cx: 3_600_000, cy: 2_160_000, rot: 0, flipH: false, flipV: false },
			frame: { kind: "chart", part }
		})

		slide.shapes.push(frame(70, "/ppt/charts/chart1.xml"), frame(71, "/ppt/charts/missing.xml"))

		const document = parseXml(encodeUtf8(CHART))
		const fresh = await freshOdp(deck, {
			theme: () => undefined,
			picture: () => Promise.resolve(undefined),
			chart: shape =>
				shape.frame?.kind === "chart" && shape.frame.part === "/ppt/charts/chart1.xml"
					? presentationChartObject(
							document,
							drawingTheme(undefined, () => undefined),
							"10cm",
							"6cm"
						)
					: undefined
		})

		if ("kind" in fresh) throw new Error(`refused ${fresh.reason}`)

		const part = (name: string) => {
			const change = fresh.parts.find(entry => entry.name === name)

			return change === undefined ? "" : decodeUtf8(change.bytes as Uint8Array)
		}

		expect(part("content.xml")).toMatch(/<draw:frame draw:name="Chart 70"[^>]*><draw:object xlink:href="\.\/Object 1"/u)
		expect(part("Object 1/content.xml")).toContain("<office:chart>")
		expect(part("META-INF/manifest.xml")).toContain(
			'manifest:full-path="Object 1/" manifest:media-type="application/vnd.oasis.opendocument.chart"'
		)
		expect(fresh.report.omitted["chart frame"]).toBe(1)
	})
})
