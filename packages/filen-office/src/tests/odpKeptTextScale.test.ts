import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { strFromU8, unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { ShapeNode, SlideRef } from "../core/presentation/model"
import { review } from "../dom/presentation/engine/review"
import { CORPUS_DIR } from "./corpusDir"
import { odpBytes } from "./odpFixtures"
import { reopened } from "./modelVsFile"
import { driveSession } from "./odpWriteDrive"

// A scaled slide size change on an ODP deck scales the indents of styles.xml's presentation styles with their text
// (an outline level's fo:margin-left and fo:text-indent, which LibreOffice places a list label by), and the text of a
// shape kept as written (a locked frame or group): its automatic text styles are written again at the text scale under
// new names, and the references inside the kept markup renamed, the rest of it as the source has it.

const HALF = { family: "design", kind: "setSize", scale: "ensureFit" } as const

function entry(bytes: Uint8Array | undefined, name: string): string {
	return strFromU8(unzipSync(bytes ?? new Uint8Array())[name] ?? new Uint8Array())
}

function styleOf(markup: string, name: string): string {
	return new RegExp(`<style:style[^>]*style:name="${name}"[^>]*>.*?</style:style>`, "su").exec(markup)?.[0] ?? ""
}

const OUTLINE = join(CORPUS_DIR, "odp/lo__tdf169524.odp")

describe("an ODP outline style after Ensure fit", () => {
	it.skipIf(!existsSync(OUTLINE))("has its indents scaled with its text", async () => {
		const d = await driveSession(new Uint8Array(readFileSync(OUTLINE)))
		// 28 × 21 cm to 21 × 15.75 cm: the text at 0.75.
		const applied = await d.command({ ...HALF, cx: 7_560_000, cy: 5_670_000 } as DeckOp)

		expect(applied.ok).toBe(true)

		const saved = await d.save()

		expect(saved.result.kind).toBe("written")

		const style = styleOf(entry(saved.bytes, "styles.xml"), "Standard-outline2")

		expect(style).toContain('fo:margin-left="1.2cm"')
		expect(style).toContain('fo:text-indent="-0.75cm"')
	})
})

const KEPT = odpBytes({
	automatic:
		'<style:style style:name="P9" style:family="paragraph"><style:paragraph-properties fo:margin-left="1in" fo:text-indent="-0.5in" fo:margin-top="12pt"/><style:text-properties fo:font-size="24pt"/></style:style>' +
		'<style:style style:name="T9" style:family="text"><style:text-properties fo:font-size="20pt"/></style:style>',
	body:
		'<draw:page draw:name="P" draw:master-page-name="M"><draw:frame draw:name="Kept" svg:x="2cm" svg:y="2cm" svg:width="20cm" svg:height="6cm">' +
		'<draw:text-box><text:p text:style-name="P9">One <text:span text:style-name="T9">two</text:span></text:p></draw:text-box></draw:frame></draw:page>'
})

function kept(shapes: readonly ShapeNode[]): ShapeNode {
	return shapes.find(shape => shape.name === "Kept") as ShapeNode
}

describe("a kept ODP text frame after Ensure fit", () => {
	it("is written with its text styles scaled under new names, reads back scaled, and an undo writes it as it was", async () => {
		const d = await driveSession(KEPT)
		const slide = d.session.deck.slides[0] as SlideRef

		await review(d.context, slide)

		const frame = kept(d.session.deck.nodes.get(slide)?.shapes ?? [])

		// Kept as written, its box still written by attributes.
		frame.lock = "proofFailed"

		const half = { ...HALF, cx: d.session.deck.size.cx / 2, cy: d.session.deck.size.cy / 2 } as DeckOp

		expect((await d.command(half)).ok).toBe(true)

		const saved = await d.save()

		expect(saved.result.kind).toBe("written")

		const content = entry(saved.bytes, "content.xml")
		const paragraph = /<text:p text:style-name="([^"]+)">One <text:span text:style-name="([^"]+)">two<\/text:span><\/text:p>/u.exec(
			content
		)

		expect(paragraph?.[1]).toBeDefined()
		expect(paragraph?.[1]).not.toBe("P9")
		expect(paragraph?.[2]).not.toBe("T9")

		const scaledParagraph = styleOf(content, paragraph?.[1] ?? "")
		const scaledSpan = styleOf(content, paragraph?.[2] ?? "")

		expect(scaledParagraph).toContain('fo:font-size="12pt"')
		expect(scaledParagraph).toContain('fo:margin-left="0.5in"')
		expect(scaledParagraph).toContain('fo:text-indent="-0.25in"')
		expect(scaledParagraph).toContain('fo:margin-top="6pt"')
		expect(scaledSpan).toContain('fo:font-size="10pt"')

		const again = await reopened(saved.bytes as Uint8Array, "odp")
		const first = again.session.deck.slides[0] as SlideRef

		await review(again.context, first)

		const runs = kept(again.session.deck.nodes.get(first)?.shapes ?? []).text?.paragraphs[0]?.runs ?? []

		expect(runs.map(run => (run.kind === "opaque" ? undefined : run.rPr.sz))).toEqual([1200, 1000])

		expect((await d.undo()).ok).toBe(true)

		const back = await d.save()

		expect(entry(back.bytes, "content.xml")).toBe(entry(KEPT, "content.xml"))
	})
})

const KEPT_LIST = odpBytes({
	automatic:
		'<text:list-style style:name="L9"><text:list-level-style-bullet text:level="1" text:bullet-char="•">' +
		'<style:list-level-properties text:space-before="1in" text:min-label-width="0.5in"/>' +
		'<style:text-properties fo:font-size="20pt"/></text:list-level-style-bullet></text:list-style>' +
		'<text:list-style style:name="L8"><text:list-level-style-bullet text:level="1" text:bullet-char="■">' +
		'<style:list-level-properties text:list-level-position-and-space-mode="label-alignment">' +
		'<style:list-level-label-alignment text:label-followed-by="listtab" fo:margin-left="2cm" fo:text-indent="-1cm"/></style:list-level-properties>' +
		"</text:list-level-style-bullet></text:list-style>" +
		'<style:style style:name="P8" style:family="paragraph" style:list-style-name="L8"><style:text-properties fo:font-size="24pt"/></style:style>',
	body:
		'<draw:page draw:name="P" draw:master-page-name="M"><draw:frame draw:name="Kept" svg:x="2cm" svg:y="2cm" svg:width="20cm" svg:height="6cm">' +
		'<draw:text-box><text:list text:style-name="L9"><text:list-item><text:p>One</text:p></text:list-item></text:list>' +
		'<text:list><text:list-item><text:p text:style-name="P8">Two</text:p></text:list-item></text:list></draw:text-box></draw:frame></draw:page>'
})

function listOf(markup: string, name: string): string {
	return new RegExp(`<text:list-style[^>]*style:name="${name}"[^>]*>.*?</text:list-style>`, "su").exec(markup)?.[0] ?? ""
}

describe("a kept ODP text frame's lists after Ensure fit", () => {
	it("are written with their list styles scaled under new names, and an undo writes them as they were", async () => {
		const d = await driveSession(KEPT_LIST)
		const slide = d.session.deck.slides[0] as SlideRef

		await review(d.context, slide)

		kept(d.session.deck.nodes.get(slide)?.shapes ?? []).lock = "proofFailed"

		expect((await d.command({ ...HALF, cx: d.session.deck.size.cx / 2, cy: d.session.deck.size.cy / 2 } as DeckOp)).ok).toBe(true)

		const saved = await d.save()

		expect(saved.result.kind).toBe("written")

		const content = entry(saved.bytes, "content.xml")
		const list = /<text:list text:style-name="([^"]+)"><text:list-item><text:p>One/u.exec(content)?.[1] ?? ""

		expect(list).not.toBe("")
		expect(list).not.toBe("L9")
		expect(listOf(content, list)).toMatch(/text:space-before="(1\.27cm|0\.5in)"/u)
		expect(listOf(content, list)).toMatch(/text:min-label-width="(0\.635cm|0\.25in)"/u)
		expect(listOf(content, list)).toContain('fo:font-size="10pt"')

		// A paragraph style naming a list style: its copy names the list style's scaled copy.
		const paragraph = /<text:p text:style-name="([^"]+)">Two/u.exec(content)?.[1] ?? ""
		const named = /style:list-style-name="([^"]+)"/u.exec(styleOf(content, paragraph))?.[1] ?? ""

		expect(paragraph).not.toBe("P8")
		expect(named).not.toBe("L8")
		expect(listOf(content, named)).toContain('fo:margin-left="1cm"')
		expect(listOf(content, named)).toContain('fo:text-indent="-0.5cm"')

		expect((await d.undo()).ok).toBe(true)

		const back = await d.save()

		expect(entry(back.bytes, "content.xml")).toBe(entry(KEPT_LIST, "content.xml"))
	})
})

const SHAPING = join(CORPUS_DIR, "odp/govuk__Shaping_the_Qualifications_Landscape.odp")

describe("govuk Shaping after Ensure fit", () => {
	it.skipIf(!existsSync(SHAPING))("writes its kept groups' labels at the scaled size", async () => {
		const d = await driveSession(new Uint8Array(readFileSync(SHAPING)))
		const applied = await d.command({ ...HALF, cx: 9_144_000, cy: 6_858_000, type: "screen4x3" } as DeckOp)

		expect(applied.ok).toBe(true)

		const saved = await d.save()

		expect(saved.result.kind).toBe("written")

		const content = entry(saved.bytes, "content.xml")
		// Page 65: a group the open-time proof kept as written (a picture whose fill does not read back) labelled "EPAO".
		const page = [...content.matchAll(/<draw:page\b.*?<\/draw:page>/gsu)][64]?.[0] ?? ""
		const name = /text:style-name="([^"]+)"[^>]*>EPAO</u.exec(page)?.[1] ?? ""

		expect(name).not.toBe("")
		expect(name).not.toBe("a4899")
		// 0.14583in (10.5 pt) × 0.75.
		expect(styleOf(content, name)).toContain('fo:font-size="7.88pt"')
	})
})
