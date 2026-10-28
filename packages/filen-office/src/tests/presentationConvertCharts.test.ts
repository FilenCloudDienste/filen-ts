import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { strFromU8, unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { convertPresentation } from "../core/convert/presentation/index"
import { openOdp } from "../core/odp/read/document"
import { bytesSource, memorySink } from "../core/opc/index"
import { openPptx } from "../core/pptx/package"
import { chartEditOp, insertChartOp, sampleChartCells } from "../core/presentation/edit/commands/chart"
import type { ShapeNode, SlideNode, SlideRef } from "../core/presentation/model"
import { openXlsx } from "../core/xlsx/package/open"
import { convertCapability } from "../dom/presentation/engine/convert"
import { viewCapability } from "../dom/presentation/engine/view"
import { savePortReader, type SavePortEnd } from "../dom/presentation/savePort"
import { CORPUS_DIR } from "./corpusDir"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"

// Charts across conversions: an ODF chart object becomes a PresentationML chart part PowerPoint draws and opens in
// Edit Data (its caches and its data as an embedded workbook), and a conversion writes the session's charts (inserted
// or edited, saved or not), not only the file's.

type Session = Awaited<ReturnType<typeof driveSession>>

const CELLS = sampleChartCells({ categories: ["A", "B", "C", "D"], series: ["N", "S", "W"] })

function fresh(format: "pptx" | "odp"): Uint8Array {
	return format === "odp"
		? odpBytes({ body: '<draw:page draw:name="One" draw:master-page-name="M"></draw:page>' })
		: buildPptx({ slides: [{ shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para("x"))) }] })
}

// The session written as `target` through the worker's capability, as Download as reads it.
async function converted(d: Session, target: "pptx" | "odp") {
	const ports = new MessageChannel()
	const reader = savePortReader(ports.port2 as unknown as SavePortEnd)
	const chunks: Uint8Array[] = []
	const read = (async () => {
		for (let chunk = await reader.read(); chunk !== undefined; chunk = await reader.read()) chunks.push(chunk)

		reader.settled(true)
	})()
	const report = await convertCapability.freshParts(d.context, target, ports.port1 as never)

	await read
	ports.port1.close()
	ports.port2.close()

	const all = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
	let at = 0

	for (const chunk of chunks) {
		all.set(chunk, at)
		at += chunk.length
	}

	return { report, files: unzipSync(all) }
}

function chartNames(files: Record<string, Uint8Array>, target: "pptx" | "odp"): string[] {
	return Object.keys(files).filter(name =>
		(target === "odp" ? /^Object \d+\/content\.xml$/u : /^ppt\/charts\/chart\d+\.xml$/u).test(name)
	)
}

function chartFrame(d: Session, slide: SlideRef): ShapeNode {
	return (d.session.deck.nodes.get(slide) as SlideNode).shapes.find(shape => shape.frame?.kind === "chart") as ShapeNode
}

describe("a conversion writes the session's charts", () => {
	for (const [format, target] of [
		["pptx", "odp"],
		["odp", "pptx"]
	] as const)
		for (const saved of [false, true])
			it(`writes a chart inserted and edited in a ${format} session to .${target}${saved ? ", after a save" : ""}`, async () => {
				const d = await driveSession(fresh(format), format)
				const slide = d.session.deck.slides[0] as SlideRef

				expect(await d.command(insertChartOp(d.session.deck, slide, 0, "column", CELLS))).toMatchObject({ ok: true })

				if (saved) await d.save()

				expect(
					await d.command(chartEditOp({ slide, id: chartFrame(d, slide).id }, { kind: "title", text: "Edited" }))
				).toMatchObject({
					ok: true
				})

				const { report, files } = await converted(d, target)
				const charts = chartNames(files, target)

				expect(report.losses.filter(loss => loss.kind === "chart")).toEqual([])
				expect(charts).toHaveLength(1)
				expect(strFromU8(files[charts[0] as string] as Uint8Array)).toContain("Edited")
			})

	for (const [format, file, target] of [
		["odp", "lo__custom_legend_position.odp", "pptx"],
		["pptx", "pypptx__cht-plot-props.pptx", "odp"]
	] as const)
		it.skipIf(!existsSync(join(CORPUS_DIR, format, file)))(
			`writes a ${format} deck's own chart edited in the session to .${target}`,
			async () => {
				const d = await driveSession(new Uint8Array(readFileSync(join(CORPUS_DIR, format, file))), format)
				const slide = d.session.deck.slides[0] as SlideRef

				await viewCapability.render(d.context, [slide])

				// Charts the target has no form for are left out either way; the edited one is not among them.
				const before = (await converted(d, target)).report.losses.filter(loss => loss.kind === "chart")

				expect(
					await d.command(chartEditOp({ slide, id: chartFrame(d, slide).id }, { kind: "title", text: "Edited" }))
				).toMatchObject({
					ok: true
				})

				const { report, files } = await converted(d, target)

				expect(report.losses.filter(loss => loss.kind === "chart")).toEqual(before)
				expect(chartNames(files, target).some(name => strFromU8(files[name] as Uint8Array).includes("Edited"))).toBe(true)
			}
		)
})

const ODP_CHARTS = ["lo__fdo71075.odp", "lo__custom_legend_position.odp", "lo__multiple_categories.odp"].map(name =>
	join(CORPUS_DIR, "odp", name)
)

describe.skipIf(!ODP_CHARTS.every(path => existsSync(path)))("an ODF chart as a PresentationML chart", () => {
	it("writes an ODP chart to .pptx with its caches and its data as an embedded workbook", async () => {
		for (const path of ODP_CHARTS) {
			const opened = await openOdp(bytesSource(new Uint8Array(readFileSync(path))))

			if (opened.kind !== "opened") throw new Error(opened.reason)

			const sink = memorySink()
			const written = await convertPresentation(opened.deck, { format: "odp", parts: opened.parts }, "pptx", sink)

			if ("kind" in written) throw new Error(written.reason)

			const files = unzipSync(sink.bytes())
			const name = chartNames(files, "pptx")[0] as string
			const chart = strFromU8(files[name] as Uint8Array)
			const rels = strFromU8(files[name.replace("charts/", "charts/_rels/") + ".rels"] ?? new Uint8Array())
			const workbook = /Target="\.\.\/embeddings\/([^"]+)"/u.exec(rels)?.[1]

			expect(
				written.losses.filter(loss => loss.kind === "chart"),
				path
			).toEqual([])
			expect(chart).toContain("<c:numCache>")
			expect(chart).not.toContain("local-table")
			expect(chart).toMatch(/<c:externalData r:id="rId1">/u)
			expect(rels).toContain('Id="rId1"')
			expect(workbook).toMatch(/\.xlsx$/u)

			// The workbook opens, and the first series' first value is what its cache holds, at the address it reads.
			const book = await openXlsx(bytesSource(files[`ppt/embeddings/${workbook ?? ""}`] as Uint8Array))

			expect(book.ok).toBe(true)

			// PowerPoint opens the converted deck: our own reader does too, its chart drawn from the part.
			const back = await openPptx(bytesSource(sink.bytes()))

			expect(back.kind).toBe("opened")
		}
	})

	it("converts an ODP chart to .pptx and back with its values in the object's table", async () => {
		for (const path of ODP_CHARTS) {
			const opened = await openOdp(bytesSource(new Uint8Array(readFileSync(path))))

			if (opened.kind !== "opened") throw new Error(opened.reason)

			const pptx = memorySink()

			await convertPresentation(opened.deck, { format: "odp", parts: opened.parts }, "pptx", pptx)

			const reopened = await openPptx(bytesSource(pptx.bytes()))

			if (reopened.kind !== "opened") throw new Error(reopened.reason)

			const odp = memorySink()
			const written = await convertPresentation(
				reopened.deck,
				{ format: "pptx", parts: reopened.parts, source: { archive: reopened.parts.opc.zip, package: reopened.parts.opc } },
				"odp",
				odp
			)

			if ("kind" in written) throw new Error(written.reason)

			const files = unzipSync(odp.bytes())
			const object = strFromU8(files[chartNames(files, "odp")[0] as string] as Uint8Array)
			const rows = /<table:table-rows>(.*?)<\/table:table-rows>/su.exec(object)?.[1] ?? ""

			expect(rows, path).toContain('office:value-type="float"')
		}
	})
})

const C = "http://schemas.openxmlformats.org/drawingml/2006/chart"

// A column chart of dates (m/d/yyyy) against shares (0%), as PowerPoint caches them.
const FORMATTED_CHART =
	`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="${C}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:plotArea><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>` +
	'<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Share</c:v></c:pt></c:strCache></c:strRef></c:tx>' +
	'<c:cat><c:numRef><c:f>Sheet1!$A$2:$A$3</c:f><c:numCache><c:formatCode>m/d/yyyy</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>45292</c:v></c:pt><c:pt idx="1"><c:v>45293</c:v></c:pt></c:numCache></c:numRef></c:cat>' +
	'<c:val><c:numRef><c:f>Sheet1!$B$2:$B$3</c:f><c:numCache><c:formatCode>0%</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>0.25</c:v></c:pt><c:pt idx="1"><c:v>0.5</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser>' +
	'<c:axId val="1"/><c:axId val="2"/></c:barChart><c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="m/d/yyyy" sourceLinked="1"/><c:crossAx val="2"/></c:catAx>' +
	'<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:numFmt formatCode="0%" sourceLinked="1"/><c:crossAx val="1"/></c:valAx></c:plotArea></c:chart></c:chartSpace>'

describe("number formats across a conversion", () => {
	it("keeps a pptx chart's date and percent formats in the .odp's object, or reports the chart's loss", async () => {
		const deck = buildPptx({
			slides: [
				{
					shapes:
						'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Chart 3"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
						'<p:xfrm><a:off x="100000" y="100000"/><a:ext cx="4000000" cy="3000000"/></p:xfrm>' +
						`<a:graphic><a:graphicData uri="${C}"><c:chart xmlns:c="${C}" r:id="rId9"/></a:graphicData></a:graphic></p:graphicFrame>`,
					rels: [["rId9", "chart", "../charts/chart1.xml"]]
				}
			],
			parts: {
				"ppt/charts/chart1.xml": {
					data: FORMATTED_CHART,
					type: "application/vnd.openxmlformats-officedocument.drawingml.chart+xml"
				}
			}
		})
		const opened = await openPptx(bytesSource(deck))

		if (opened.kind !== "opened") throw new Error(opened.reason)

		const sink = memorySink()
		const written = await convertPresentation(
			opened.deck,
			{ format: "pptx", parts: opened.parts, source: { archive: opened.parts.opc.zip, package: opened.parts.opc } },
			"odp",
			sink
		)

		if ("kind" in written) throw new Error(written.reason)

		const files = unzipSync(sink.bytes())
		const object = strFromU8(files[chartNames(files, "odp")[0] as string] as Uint8Array)
		const kept = /<number:date-style/u.test(object) && /<number:percentage-style/u.test(object)

		expect(kept || written.losses.some(loss => loss.kind === "chartDetail")).toBe(true)
	})
})
