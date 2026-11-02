import { describe, expect, it } from "vitest"
import type { SlideRef } from "../core/presentation/model"
import { review } from "../dom/presentation/engine/review"
import { driveSession } from "./odpWriteDrive"
import { buildPptx } from "./pptxFixtures"
import { editDeckOptions } from "./presentationEditFixtures"
import { budget, cpuMs } from "./timing"

// A slide with 1,000 modern comments: reading them for the Comments pane, and one comment added and saved (the part
// spliced in place: 999 comments copied as their bytes). The least CPU of three runs, each on a fresh session.

const P188_NS =
	'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p188="http://schemas.microsoft.com/office/powerpoint/2018/8/main"'
const AUTHOR = "{11111111-1111-4111-8111-111111111111}"

function guid(n: number): string {
	return `{AAAAAAAA-0000-4000-8000-${n.toString(16).padStart(12, "0")}}`
}

function thousandComments(): Uint8Array {
	let comments = ""

	for (let k = 0; k < 1000; k++) {
		comments += `<p188:cm id="${guid(k)}" authorId="${AUTHOR}" created="2024-03-01T09:00:00.000"><pc:sldMkLst xmlns:pc="http://schemas.microsoft.com/office/powerpoint/2013/main/command"><pc:docMk/><pc:sldMk cId="1" sldId="256"/></pc:sldMkLst><p188:pos x="100" y="200"/><p188:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Comment ${String(k)} on the figure and its source</a:t></a:r></a:p></p188:txBody></p188:cm>`
	}

	const base = editDeckOptions()

	return buildPptx({
		...base,
		slides: base.slides.map((slide, index) =>
			index === 0
				? {
						...slide,
						rels: [
							...(slide.rels ?? []),
							[
								"rId80",
								"http://schemas.microsoft.com/office/2018/10/relationships/comments",
								"../comments/modernComment_100_1.xml"
							] as const
						]
					}
				: slide
		),
		presentationRels: [["rId81", "http://schemas.microsoft.com/office/2018/10/relationships/authors", "authors.xml"]],
		parts: {
			"ppt/comments/modernComment_100_1.xml": {
				type: "application/vnd.ms-powerpoint.comments+xml",
				data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<p188:cmLst ${P188_NS}>${comments}</p188:cmLst>`
			},
			"ppt/authors.xml": {
				type: "application/vnd.ms-powerpoint.authors+xml",
				data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<p188:authorLst ${P188_NS}><p188:author id="${AUTHOR}" name="Ann Lee" initials="AL" userId="Ann Lee" providerId="None"/></p188:authorLst>`
			}
		}
	})
}

describe("presentationCommentsPerf", () => {
	it(
		"reads 1,000 comments in at most 40 ms CPU and saves one more in at most 120 ms CPU",
		{ timeout: budget(120_000) },
		async ({ task }) => {
			const bytes = thousandComments()
			let read = Number.POSITIVE_INFINITY
			let saved = Number.POSITIVE_INFINITY

			for (let run = 0; run < 3; run++) {
				const s = await driveSession(bytes, "pptx")
				const slide = s.session.deck.slides[0] as SlideRef

				await s.session.deck.nodes.get(slide)

				let start = cpuMs()
				const reviewed = await review(s.context, slide)

				read = Math.min(read, cpuMs() - start)
				expect(reviewed.comments).toHaveLength(1000)

				await s.command({
					family: "comment",
					kind: "add",
					slide,
					comment: { id: guid(5000), author: AUTHOR, text: "One more", created: "2026-10-28T08:00:00.000Z" }
				})
				start = cpuMs()

				const result = await s.save()

				saved = Math.min(saved, cpuMs() - start)
				expect(result.result.kind).toBe("written")
			}

			Object.assign(task.meta, {
				perf: {
					presentationCommentsReadCpuMs: { value: read, budget: 40 },
					presentationCommentsSaveCpuMs: { value: saved, budget: 120 }
				}
			})
			expect(read).toBeLessThanOrEqual(budget(40))
			expect(saved).toBeLessThanOrEqual(budget(120))
		}
	)
})
