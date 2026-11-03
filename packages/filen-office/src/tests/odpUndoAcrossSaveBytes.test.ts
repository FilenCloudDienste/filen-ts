import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { strFromU8, unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { ShapeNode, SlideNode, SlideRef } from "../core/presentation/model"
import { review } from "../dom/presentation/engine/review"
import { CORPUS_DIR } from "./corpusDir"
import { driveSession } from "./odpWriteDrive"

// An ODP edit saved, undone and saved again writes the source's content.xml back byte for byte: the automatic styles
// keep their names, attributes the source left out stay out, lengths keep their units.

type Drive = Awaited<ReturnType<typeof driveSession>>

function walk(shapes: readonly ShapeNode[], out: ShapeNode[] = []): ShapeNode[] {
	for (const shape of shapes) {
		out.push(shape)
		if (shape.children !== undefined) walk(shape.children, out)
	}

	return out
}

async function first(d: Drive): Promise<{ ref: SlideRef; node: SlideNode }> {
	const ref = d.session.deck.slides[0] as SlideRef

	await review(d.context, ref)

	return { ref, node: d.session.deck.nodes.get(ref) as SlideNode }
}

const EDITS: Readonly<Record<string, (d: Drive) => Promise<DeckOp | undefined>>> = {
	move: async d => {
		const { ref, node } = await first(d)
		const shape = walk(node.shapes).find(each => each.xfrm !== undefined && each.lock === undefined)

		return shape?.xfrm === undefined
			? undefined
			: { family: "shape", kind: "setXfrm", target: { slide: ref, id: shape.id }, xfrm: { ...shape.xfrm, x: shape.xfrm.x + 12_700 } }
	},
	fill: async d => {
		const { ref, node } = await first(d)
		const shape = walk(node.shapes).find(each => each.kind === "sp" && each.lock === undefined && each.ph === undefined)

		return shape === undefined
			? undefined
			: {
					family: "shape",
					kind: "setProps",
					target: { slide: ref, id: shape.id },
					props: { fill: { kind: "solid", color: { kind: "srgb", rgb: "FF0000" } } }
				}
	},
	hide: async d => {
		const { ref, node } = await first(d)

		return { family: "slide", kind: "hide", slides: [ref], hidden: !node.hidden }
	}
}

const content = (bytes: Uint8Array): string =>
	strFromU8(unzipSync(bytes, { filter: file => file.name === "content.xml" })["content.xml"] as Uint8Array)

function firstDifference(was: string, now: string): string {
	let at = 0

	while (at < was.length && was[at] === now[at]) at++

	return at >= was.length && at >= now.length
		? ""
		: `@${String(at)}: ${was.slice(Math.max(0, at - 60), at + 80)} || ${now.slice(Math.max(0, at - 60), at + 80)}`
}

describe("an ODP edit undone across a save", () => {
	for (const deck of ["lo__media_embedding.odp", "govuk__Workshop_in_a_box_slides_ODP.odp", "lo__slide-custom-background.odp"])
		for (const [name, edit] of Object.entries(EDITS))
			it.runIf(existsSync(join(CORPUS_DIR, "odp", deck)))(
				`${deck} ${name}: the save after the undo writes the source's content`,
				{ timeout: 120_000 },
				async () => {
					const source = new Uint8Array(readFileSync(join(CORPUS_DIR, "odp", deck)))
					const d = await driveSession(source, "odp")
					const op = await edit(d)

					if (op === undefined) return

					expect((await d.command(op)).ok).toBe(true)
					expect((await d.save()).result).toEqual(expect.objectContaining({ kind: "written" }))
					expect((await d.undo()).ok).toBe(true)

					const saved = await d.save()

					expect(saved.result).toEqual(expect.objectContaining({ kind: "written" }))
					expect(firstDifference(content(source), content(saved.bytes as Uint8Array))).toBe("")
				}
			)
})
