import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { strFromU8, unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import type { ShapeNode, SlideRef } from "../core/presentation/model"
import { review } from "../dom/presentation/engine/review"
import { CORPUS_DIR } from "./corpusDir"
import { driveSession } from "./odpWriteDrive"

// A shape moved, saved, moved back and saved again: the second save writes its box as the source wrote it, in the
// source's own units (a deck in inches stays in inches), whatever the save in between wrote.

function walk(shapes: readonly ShapeNode[], out: ShapeNode[] = []): ShapeNode[] {
	for (const shape of shapes) {
		out.push(shape)
		if (shape.children !== undefined) walk(shape.children, out)
	}

	return out
}

const content = (bytes: Uint8Array): string =>
	strFromU8(unzipSync(bytes, { filter: file => file.name === "content.xml" })["content.xml"] as Uint8Array)

describe("a shape moved and moved back across saves", () => {
	for (const name of [
		"govuk__Management_Information_Introduction_Supplier_presentation.odp",
		"govuk__Shaping_the_Qualifications_Landscape.odp",
		"lo__media_embedding.odp"
	])
		it.runIf(existsSync(join(CORPUS_DIR, "odp", name)))(
			`${name}: the second save writes the source's content again`,
			{ timeout: 120_000 },
			async () => {
				const source = new Uint8Array(readFileSync(join(CORPUS_DIR, "odp", name)))
				const d = await driveSession(source, "odp")
				const slide = d.session.deck.slides[0] as SlideRef

				await review(d.context, slide)

				const shape = walk(d.session.deck.nodes.get(slide)?.shapes ?? []).find(
					each => each.xfrm !== undefined && each.lock === undefined
				) as ShapeNode
				const xfrm = shape.xfrm as NonNullable<ShapeNode["xfrm"]>
				const move = async (x: number) =>
					d.command({ family: "shape", kind: "setXfrm", target: { slide, id: shape.id }, xfrm: { ...xfrm, x } })

				expect((await move(xfrm.x + 25_400)).ok).toBe(true)
				expect((await d.save()).result).toEqual(expect.objectContaining({ kind: "written" }))
				expect((await move(xfrm.x)).ok).toBe(true)

				const back = await d.save()

				expect(back.result).toEqual(expect.objectContaining({ kind: "written" }))

				const [was, now] = [content(source), content(back.bytes as Uint8Array)]
				let at = 0

				while (at < was.length && was[at] === now[at]) at++

				expect(now.slice(Math.max(0, at - 80), at + 80)).toBe(was.slice(Math.max(0, at - 80), at + 80))
				expect(now === was).toBe(true)
			}
		)
})
