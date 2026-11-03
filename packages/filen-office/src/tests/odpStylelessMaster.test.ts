import { describe, expect, it } from "vitest"
import { strFromU8, unzipSync } from "fflate"
import { odpBytes, openOdpFixture, slideOf } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { review } from "../dom/presentation/engine/review"
import type { SlideNode, SlideRef, TextBody } from "../core/presentation/model"

// A master page that defines no presentation styles of its own: LibreOffice 7.5 gives its presentation objects its
// built-in ones (measured: saved again, it writes them as "<master>-title" 44 pt centred, "-outline1".."-outline9"
// 32/28/24/20 pt in Liberation Sans with its default bullets), not another master's.

const MASTERS =
	'<style:master-page style:name="Styled" style:page-layout-name="PM1" draw:style-name="Mdp"/>' +
	'<style:master-page style:name="Bare" style:page-layout-name="PM1" draw:style-name="Mdp"/>'

const STYLED =
	'<style:style style:name="Styled-title" style:family="presentation"><style:text-properties fo:font-size="20pt"/></style:style>' +
	'<style:style style:name="Styled-outline1" style:family="presentation"><style:text-properties fo:font-size="16pt"/></style:style>' +
	'<style:style style:name="Styled-outline2" style:family="presentation" style:parent-style-name="Styled-outline1"><style:text-properties fo:font-size="14pt"/></style:style>'

const OBJECTS =
	'<draw:frame presentation:class="title" svg:x="1cm" svg:y="1cm" svg:width="20cm" svg:height="3cm"><draw:text-box><text:p>Title</text:p></draw:text-box></draw:frame>' +
	'<draw:frame presentation:class="outline" svg:x="1cm" svg:y="5cm" svg:width="20cm" svg:height="10cm"><draw:text-box><text:list><text:list-item><text:p>One</text:p>' +
	"<text:list><text:list-item><text:p>Two</text:p></text:list-item></text:list></text:list-item></text:list></draw:text-box></draw:frame>"

// Each paragraph's text size as its shape's level gives it.
function sizes(slide: SlideNode): (number | undefined)[] {
	return slide.shapes.flatMap(shape =>
		(shape.text?.paragraphs ?? []).map(paragraph => shape.text?.lstStyle?.levels[paragraph.pPr.lvl ?? 0]?.defRPr?.sz)
	)
}

const FIXTURE = {
	styles: STYLED,
	stylesAutomatic:
		'<style:page-layout style:name="PM1"><style:page-layout-properties fo:page-width="28cm" fo:page-height="21cm"/></style:page-layout>' +
		'<style:style style:name="Mdp" style:family="drawing-page"/>',
	masters: MASTERS,
	body:
		`<draw:page draw:name="A" draw:master-page-name="Styled">${OBJECTS}</draw:page>` +
		`<draw:page draw:name="B" draw:master-page-name="Bare">${OBJECTS}</draw:page>`
}

describe("presentation objects on a master without presentation styles", () => {
	it("take LibreOffice's built-in styles; a styled master's keep its own", async () => {
		const opened = await openOdpFixture(FIXTURE)
		const styled = await slideOf(opened, 0)
		const bare = await slideOf(opened, 1)
		expect(sizes(styled)).toEqual([2000, 1600, 1400])
		expect(sizes(bare)).toEqual([4400, 3200, 2800])
	})

	it("are read so, and a save writes no styles for that master", async () => {
		const source = odpBytes(FIXTURE)
		const d = await driveSession(source, "odp")
		const slide = d.session.deck.slides[1] as SlideRef

		await review(d.context, slide)

		const shape = d.session.deck.nodes.get(slide)?.shapes[0]
		const text = shape?.text as TextBody
		const body: TextBody = {
			...text,
			paragraphs: text.paragraphs.map(p => ({ ...p, runs: p.runs.map(r => (r.kind === "r" ? { ...r, text: `${r.text}!` } : r)) }))
		}

		expect((await d.command({ family: "text", kind: "setText", target: { slide, id: shape?.id as number }, body })).ok).toBe(true)

		const saved = await d.save()
		const styles = (bytes: Uint8Array) =>
			strFromU8(unzipSync(bytes, { filter: entry => entry.name === "styles.xml" })["styles.xml"] as Uint8Array)

		expect(saved.result).toEqual(expect.objectContaining({ kind: "written" }))
		expect(styles(saved.bytes as Uint8Array)).toBe(styles(source))
		expect(strFromU8(unzipSync(saved.bytes as Uint8Array)["content.xml"] as Uint8Array)).not.toContain("Bare-")
	})
})
