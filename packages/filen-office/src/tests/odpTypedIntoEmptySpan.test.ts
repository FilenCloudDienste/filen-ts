import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { SlideRef, TextBody } from "../core/presentation/model"
import { review } from "../dom/presentation/engine/review"
import { CORPUS_DIR } from "./corpusDir"
import { modelVsFile } from "./modelVsFile"
import { driveSession } from "./odpWriteDrive"

// Text typed into a shape whose paragraph holds only an empty styled span (Microsoft's ODP export writes
// <text:p><text:span text:style-name="…"/></text:p> for an empty shape): the save writes it, and the file reads back
// as the session shows it.

const CASES: readonly (readonly [string, string])[] = [
	["govuk__bbfa-11-business-lifecycle.odp", "Rectangle 4"],
	["govuk__Workshop_in_a_box_slides_ODP.odp", "Title 1"],
	["odftk__SlideTest2.odp", "Title text1"],
	["lo__textbox-link-javascript.odp", "Title 1"]
]

describe("text typed into an ODP shape", () => {
	for (const [file, name] of CASES)
		for (const how of ["as a new run", "into its run"] as const)
			it.runIf(existsSync(join(CORPUS_DIR, "odp", file)))(
				`${file} "${name}", ${how}: written as typed`,
				{ timeout: 120_000 },
				async () => {
					const d = await driveSession(new Uint8Array(readFileSync(join(CORPUS_DIR, "odp", file))), "odp")
					let target: { slide: SlideRef; id: number } | undefined
					let body: TextBody | undefined

					for (const slide of d.session.deck.slides.slice(0, 3)) {
						await review(d.context, slide)

						const shape = d.session.deck.nodes
							.get(slide)
							?.shapes.find(each => each.name === name && each.text !== undefined && each.kind === "sp")

						if (shape?.text !== undefined) {
							target = { slide, id: shape.id }
							body = structuredClone(shape.text)
							break
						}
					}

					const paragraph = body?.paragraphs[0]
					const run = paragraph?.runs.find(each => each.kind === "r")

					if (paragraph === undefined || target === undefined || body === undefined) throw new Error(`no shape ${name}`)
					if (how === "as a new run" || run?.kind !== "r")
						paragraph.runs.push({ kind: "r", text: "typed", rPr: run?.kind === "r" ? structuredClone(run.rPr) : {} })
					else paragraph.runs[paragraph.runs.indexOf(run)] = { ...run, text: `${run.text}typed` }

					expect((await d.command({ family: "text", kind: "setText", target, body })).ok).toBe(true)

					const saved = await d.save()

					expect(saved.result).toEqual(expect.objectContaining({ kind: "written" }))
					expect(await modelVsFile(d, saved.bytes as Uint8Array, "odp")).toBe("")
				}
			)
})
