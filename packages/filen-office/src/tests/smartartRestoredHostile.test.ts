import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { unzipSync, zipSync } from "fflate"
import { describe, expect, it } from "vitest"
import type { ShapeNode, SlideNode, SlideRef } from "../core/presentation/model"
import { pptxParts } from "../dom/presentation/engine/open/pptx"
import { review } from "../dom/presentation/engine/review"
import { smartArtRenderer } from "../dom/presentation/engine/smartart"
import { CORPUS_DIR } from "./corpusDir"
import { driveSession } from "./odpWriteDrive"
import { danglingReferences } from "./pptxWriteFixtures"

// A diagram's slide deleted and saved (the package loses its diagram parts), then restored by undo: a diagram op on
// it reads the parts its restore held. Held markup that does not read is refused as malformed (the file's fault, not
// a missing part), and the file still writes whole.

const PIE = join(CORPUS_DIR, "pptx", "lo__tdf149551_SmartArt_Pie.pptx")
const encoder = new TextEncoder()

function variant(part: string, mutate: (xml: string) => string): Uint8Array {
	const files = unzipSync(new Uint8Array(readFileSync(PIE)))
	const file = files[part]

	if (file === undefined) throw new Error(`no ${part}`)

	files[part] = new Uint8Array(encoder.encode(mutate(new TextDecoder().decode(file))))

	return zipSync(files, { level: 6 })
}

function frameIn(shapes: readonly ShapeNode[]): ShapeNode | undefined {
	for (const shape of shapes) {
		if (shape.frame?.kind === "smartart") return shape

		const child = shape.children === undefined ? undefined : frameIn(shape.children)

		if (child !== undefined) return child
	}

	return undefined
}

const VARIANTS: readonly [string, () => Uint8Array][] = [
	["colours cut short", () => variant("ppt/diagrams/colors1.xml", xml => xml.slice(0, xml.length / 2))],
	["style unterminated", () => variant("ppt/diagrams/quickStyle1.xml", xml => xml.replace(/<\/dgm:styleDef>\s*$/u, "<oops"))],
	[
		"layout with a DOCTYPE",
		() =>
			variant("ppt/diagrams/layout1.xml", xml =>
				xml.replace(/^(<\?xml[^>]*\?>)?/u, '$1<!DOCTYPE l [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;">]>')
			)
	]
]

describe.skipIf(!existsSync(PIE))("held diagram markup that does not read, on a restored slide", () => {
	for (const [label, make] of VARIANTS)
		it(`${label}: the diagram op is refused malformed and the file writes`, async () => {
			const d = await driveSession(make(), "pptx")

			smartArtRenderer(d.session, {
				services: {
					xml: part => pptxParts(d.session.deck)?.document(part),
					relationship: () => undefined,
					contentType: () => undefined
				}
			})

			const slide = d.session.deck.slides[0] as SlideRef

			await review(d.context, slide)

			const layout = (d.session.deck.nodes.get(slide) as SlideNode).parent

			if (layout === undefined) throw new Error("no layout")

			expect((await d.command({ family: "slide", kind: "add", layout, at: 1 })).ok).toBe(true)
			expect((await d.command({ family: "slide", kind: "delete", slides: [slide] })).ok).toBe(true)
			expect((await d.save()).result.kind).toBe("written")
			expect((await d.undo()).ok).toBe(true)

			const frame = frameIn((d.session.deck.nodes.get(slide) as SlideNode).shapes)

			if (frame === undefined) throw new Error("no diagram")

			const answer = await d.command({
				family: "smartart",
				kind: "setColors",
				target: { slide, id: frame.id },
				def: { uniqueId: "urn:filen:smartart:colors:colorful", source: "gallery" }
			})

			expect(answer).toEqual({ ok: false, refusal: "malformed" })

			const saved = await d.save()

			expect(saved.result.kind).toBe("written")

			if (saved.bytes === undefined) throw new Error("not saved")

			expect(await danglingReferences(saved.bytes)).toEqual([])
		})
})
