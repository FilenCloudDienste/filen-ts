import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { strFromU8, unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import type { ShapeNode, SlideRef, TextBody } from "../core/presentation/model"
import { odpParts } from "../dom/presentation/engine/open/odp"
import { CORPUS_DIR } from "./corpusDir"
import { driveSession } from "./odpWriteDrive"

// A list body of a corpus deck written again after one typed character keeps what LibreOffice needs to draw its labels:
// a number level its text's size (fo:font-size), a picture level its source's size (fo:width, fo:height, centred on
// the line).

function every(shapes: readonly ShapeNode[], out: ShapeNode[] = []): ShapeNode[] {
	for (const shape of shapes) {
		out.push(shape)
		if (shape.children !== undefined) every(shape.children, out)
	}

	return out
}

// The written list style of the list holding `find`, after `find`'s paragraph got one more character.
async function writtenListStyle(file: string, slideNo: number, find: string): Promise<string> {
	const d = await driveSession(new Uint8Array(readFileSync(join(CORPUS_DIR, "odp", file))), "odp")

	await odpParts(d.session.deck)?.parseAll()

	const slide = d.session.deck.slides[slideNo - 1] as SlideRef
	const has = (paragraph: TextBody["paragraphs"][number]) => paragraph.runs.some(run => run.kind === "r" && run.text.includes(find))
	const shape = every(d.session.deck.nodes.get(slide)?.shapes ?? []).find(each => (each.text?.paragraphs ?? []).some(has)) as ShapeNode
	const text = shape.text as TextBody
	const body: TextBody = {
		...text,
		paragraphs: text.paragraphs.map(paragraph => {
			if (!has(paragraph)) return paragraph

			const last = paragraph.runs.findLastIndex(run => run.kind === "r")

			return {
				...paragraph,
				runs: paragraph.runs.map((run, at) => (at === last && run.kind === "r" ? { ...run, text: `${run.text}x` } : run))
			}
		})
	}

	expect((await d.command({ family: "text", kind: "setText", target: { slide, id: shape.id }, body })).ok).toBe(true)

	const saved = await d.save()

	expect(saved.result).toEqual(expect.objectContaining({ kind: "written" }))

	const content = strFromU8(
		unzipSync(saved.bytes as Uint8Array, { filter: entry => entry.name === "content.xml" })["content.xml"] as Uint8Array
	)
	const at = content.indexOf(find)
	const list = content.lastIndexOf("<text:list text:style-name=", at)
	const name = /text:style-name="([^"]+)"/u.exec(content.slice(list, list + 200))?.[1] ?? ""
	const start = content.indexOf(`style:name="${name}"`)

	return content.slice(content.lastIndexOf("<", start), content.indexOf("</text:list-style>", start))
}

const has = (name: string): boolean => existsSync(join(CORPUS_DIR, "odp", name))

describe("an ODP list level written again", () => {
	it.runIf(has("govuk__Workshop_in_a_box_slides_ODP.odp"))("a number level carries its text's size", { timeout: 120_000 }, async () => {
		const style = await writtenListStyle("govuk__Workshop_in_a_box_slides_ODP.odp", 15, "Why PIP is important")

		expect(style).toMatch(/<text:list-level-style-number[^>]*>(?:(?!<\/text:list-level-style-number>).)*fo:font-size="100%"/u)
	})

	it.runIf(has("odftk__Presentation3.odp"))(
		"a picture level carries its source's size, centred on the line",
		{ timeout: 120_000 },
		async () => {
			const style = await writtenListStyle("odftk__Presentation3.odp", 1, "do a comparison")
			const level = /<text:list-level-style-image[^>]*>(?:(?!<\/text:list-level-style-image>).)*/u.exec(style)?.[0] ?? ""

			expect(level).toMatch(/fo:width="0\.794cm"/u)
			expect(level).toMatch(/fo:height="0\.794cm"/u)
			expect(level).toContain('style:vertical-pos="middle"')
			expect(level).toContain('style:vertical-rel="line"')
		}
	)
})

// A LibreOffice outline whose level-2 paragraphs take their indents from the outline style (margin-left 1.6 cm,
// text-indent -1 cm) over a level of space-before 0.6 cm and min-label-width 1 cm: LibreOffice puts the label at
// 0.6 cm and the text at 1.6 cm (the paragraph's indents place the line, the label width keeps the text past the
// label). Read so, and written so after Ensure fit (both scaled by the content's scale).
describe("an ODP outline's level-2 paragraphs", () => {
	it.runIf(has("lo__tdf169524.odp"))(
		"read at LibreOffice's place, and written there scaled after Ensure fit",
		{ timeout: 120_000 },
		async () => {
			const d = await driveSession(new Uint8Array(readFileSync(join(CORPUS_DIR, "odp", "lo__tdf169524.odp"))), "odp")

			await odpParts(d.session.deck)?.parseAll()

			const slide = d.session.deck.slides[0] as SlideRef
			const level2 = (shapes: readonly ShapeNode[]) =>
				every(shapes)
					.flatMap(shape => shape.text?.paragraphs ?? [])
					.find(paragraph => paragraph.runs.some(run => run.kind === "r" && run.text === "LLLLLLLLLL"))?.pPr

			expect(level2(d.session.deck.nodes.get(slide)?.shapes ?? [])).toMatchObject({ marL: 576_000, indent: -360_000 })

			const size = {
				family: "design",
				kind: "setSize",
				cx: (d.session.deck.size.cx * 3) / 4,
				cy: (d.session.deck.size.cy * 3) / 4,
				scale: "ensureFit"
			}

			expect((await d.command(size as never)).ok).toBe(true)

			const model = level2(d.session.deck.nodes.get(slide)?.shapes ?? [])
			const saved = await d.save()

			expect(saved.result).toEqual(expect.objectContaining({ kind: "written" }))

			const again = await driveSession(saved.bytes as Uint8Array, "odp")

			await odpParts(again.session.deck)?.parseAll()

			const read = level2(again.session.deck.nodes.get(again.session.deck.slides[0] as SlideRef)?.shapes ?? [])

			expect(Math.abs((model?.marL ?? 0) - 432_000)).toBeLessThan(400)
			expect(read?.marL).toBe(model?.marL)
			expect(read?.indent).toBe(model?.indent)
		}
	)
})
