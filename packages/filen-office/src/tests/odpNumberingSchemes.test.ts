import { describe, expect, it } from "vitest"
import { bytesSource, memorySink, ZipArchive } from "@filen/office/core/opc"
import { convertPresentation } from "../core/convert/presentation/index"
import { openPptx } from "../core/pptx/package"
import type { SlideRef } from "../core/presentation/model"
import { review } from "../dom/presentation/engine/review"
import { driveSession } from "./odpWriteDrive"
import { body, buildPptx, sp, xfrm } from "./pptxFixtures"

// A pptx numbering converted to ODP: each ST_TextAutonumberScheme LibreOffice 7.5 holds is written as the
// style:num-format, prefix and suffix LibreOffice writes for it (measured: its own conversion of the same deck) and
// reads back as that scheme, its label the size of its text (fo:font-size, as LibreOffice Impress reads it); one ODF has no format for is written as Arabic numbers and reported as a numbering loss.

const WRITTEN: readonly (readonly [string, string, string, string])[] = [
	["hebrew2Minus", "א, ב, ג, ...", "", "-"],
	["circleNumDbPlain", "①, ②, ③, ...", "", ""],
	["ea1ChsPeriod", "壹, 贰, 叁, ...", "", "."],
	["ea1ChtPlain", "壹, 貳, 參, ...", "", ""],
	["thaiAlphaParenBoth", "ก, ข, ค, ...", "(", ")"],
	["romanUcParenR", "I", "", ")"]
]

async function converted(schemes: readonly string[]) {
	const slides = schemes.map((scheme, at) => ({
		shapes: sp(
			2,
			`S${String(at)}`,
			undefined,
			`${xfrm(100_000, 100_000, 5_000_000, 1_000_000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`,
			body(
				`<a:p><a:pPr marL="342900" indent="-342900"><a:buAutoNum type="${scheme}"/></a:pPr><a:r><a:rPr lang="en-US"/><a:t>${scheme}</a:t></a:r></a:p>`
			)
		)
	}))
	const bytes = buildPptx({ slides })
	const open = await openPptx(bytesSource(bytes))

	if (open.kind !== "opened") throw new Error(open.reason)

	await open.parts.parseAll()

	const sink = memorySink()
	const result = await convertPresentation(
		open.deck,
		{ format: "pptx", parts: open.parts, source: { archive: await ZipArchive.open(bytesSource(bytes)), package: open.parts.opc } },
		"odp",
		sink,
		{}
	)

	if ("kind" in result) throw new Error(result.reason)

	const odp = sink.bytes()
	const archive = await ZipArchive.open(bytesSource(odp))
	const entry = archive.get("content.xml")

	if (entry === undefined) throw new Error("no content.xml")

	return { odp, losses: result.losses, content: new TextDecoder().decode(await archive.read(entry)) }
}

describe("a pptx numbering converted to ODP", () => {
	it("is written in LibreOffice's num-format for its scheme and read back as that scheme, with no loss", async () => {
		const out = await converted(WRITTEN.map(([scheme]) => scheme))

		for (const [, format, prefix, suffix] of WRITTEN) {
			const level = new RegExp(
				`<text:list-level-style-number text:level="1"[^>]*style:num-format="${format.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"[^>]*>`,
				"u"
			).exec(out.content)?.[0]

			expect(level, format).toBeDefined()
			expect(level).toContain(prefix === "" ? "" : `style:num-prefix="${prefix}"`)
			expect(level).toContain(suffix === "" ? "" : `style:num-suffix="${suffix}"`)
			expect(
				out.content.slice(
					out.content.indexOf(level ?? ""),
					out.content.indexOf("</text:list-level-style-number>", out.content.indexOf(level ?? ""))
				)
			).toContain('fo:font-size="100%"')
		}

		expect(out.losses.filter(loss => loss.kind === "text" || loss.kind === "numbering")).toEqual([])

		const d = await driveSession(out.odp, "odp")
		const read: string[] = []

		for (const slide of d.session.deck.slides) {
			await review(d.context, slide as SlideRef)

			const bullet = d.session.deck.nodes.get(slide)?.shapes[0]?.text?.paragraphs[0]?.pPr.bullet

			read.push(bullet?.kind === "autoNum" ? bullet.scheme : String(bullet?.kind))
		}

		expect(read).toEqual(WRITTEN.map(([scheme]) => scheme))
	})

	it("one ODF has no format for: Arabic numbers, reported as a numbering loss", async () => {
		const out = await converted(["arabic2Minus", "hindiAlphaPeriod"])

		expect(out.content).toContain('style:num-format="1"')
		expect(out.losses).toContainEqual(expect.objectContaining({ kind: "numbering", count: 2 }))
	})
})
