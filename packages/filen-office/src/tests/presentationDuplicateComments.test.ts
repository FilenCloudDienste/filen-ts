import { describe, expect, it } from "vitest"
import type { CommentOp } from "../core/presentation/edit/ops"
import type { SlideRef } from "../core/presentation/model"
import { review } from "../dom/presentation/engine/review"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { buildPptx } from "./pptxFixtures"
import { editDeckOptions } from "./presentationEditFixtures"

// A duplicate brings its source's comments as the session holds them now (edited, added to, replied to since the
// last save), never as the saved file had them; the file then holds what the deck shows.

type Drive = Awaited<ReturnType<typeof driveSession>>

const AUTHOR = "{22222222-2222-4222-8222-222222222222}"
const FIRST = "{33333333-3333-4333-8333-333333333333}"
const MORE = "{44444444-4444-4444-8444-444444444444}"
const REPLY = "{55555555-5555-4555-8555-555555555555}"

function deckOf(format: "pptx" | "odp"): Uint8Array {
	return format === "pptx"
		? buildPptx(editDeckOptions())
		: odpBytes({
				body: [0, 1, 2]
					.map(
						k =>
							`<draw:page draw:name="P${String(k)}" draw:master-page-name="M"><draw:frame draw:name="T" svg:x="1cm" svg:y="1cm" svg:width="5cm" svg:height="2cm"><draw:text-box><text:p>T${String(k)}</text:p></draw:text-box></draw:frame></draw:page>`
					)
					.join("")
			})
}

function add(slide: SlideRef, id: string, text: string): CommentOp {
	return {
		family: "comment",
		kind: "add",
		slide,
		comment: { id, author: AUTHOR, text, created: "2026-10-28T08:00:00.000Z", anchor: { x: 12_700, y: 25_400 } },
		authorName: "Cy Doe"
	}
}

async function comments(d: Drive): Promise<string[]> {
	const out: string[] = []

	for (const slide of d.session.deck.slides)
		out.push(((await review(d.context, slide)).comments ?? []).map(comment => comment.text).join("+") || "-")

	return out
}

describe("a duplicate of a slide whose comments changed since the last save", () => {
	const changes: Record<string, (d: Drive, slide: SlideRef) => Promise<void>> = {
		edited: async (d, slide) => {
			expect((await d.command({ family: "comment", kind: "edit", slide, id: FIRST, text: "NEW" })).ok).toBe(true)
		},
		"added to": async (d, slide) => {
			expect((await d.command(add(slide, MORE, "MORE"))).ok).toBe(true)
		},
		"replied to": async (d, slide) => {
			expect(
				(
					await d.command({
						family: "comment",
						kind: "reply",
						slide,
						parent: FIRST,
						comment: { id: REPLY, author: AUTHOR, text: "REPLY", created: "2026-10-28T09:00:00.000Z" },
						authorName: "Cy Doe"
					})
				).ok
			).toBe(true)
		}
	}

	for (const format of ["pptx", "odp"] as const)
		for (const [what, change] of Object.entries(changes))
			for (const saved of [true, false])
				it(`${format}: comments ${what}${saved ? " after a save" : ", never saved"}: the copy has them as they are, and so has the file`, async () => {
					const d = await driveSession(deckOf(format), format)
					const slide = d.session.deck.slides[format === "pptx" ? 0 : 1] as SlideRef

					await review(d.context, slide)
					expect((await d.command(add(slide, FIRST, "OLD"))).ok).toBe(true)

					if (saved) expect((await d.save()).result.kind).toBe("written")

					await change(d, slide)
					expect((await d.command({ family: "slide", kind: "duplicate", slide })).ok).toBe(true)

					const model = await comments(d)
					const at = d.session.deck.slides.indexOf(slide)

					expect(model[at + 1]).toBe(model[at])

					const next = await d.save()

					expect(next.result.kind).toBe("written")
					expect(await comments(await driveSession(next.bytes as Uint8Array, format))).toEqual(model)
					expect((await d.save()).result.kind).toBe("unchanged")
				})

	for (const format of ["pptx", "odp"] as const)
		it(`${format}: the copy's own comment edited after a save is written`, async () => {
			const d = await driveSession(deckOf(format), format)
			const slide = d.session.deck.slides[format === "pptx" ? 0 : 1] as SlideRef

			await review(d.context, slide)
			expect((await d.command(add(slide, FIRST, "OLD"))).ok).toBe(true)
			expect((await d.save()).result.kind).toBe("written")
			expect((await d.command({ family: "slide", kind: "duplicate", slide })).ok).toBe(true)

			const copy = d.session.deck.slides[d.session.deck.slides.indexOf(slide) + 1] as SlideRef

			await review(d.context, copy)
			expect((await d.command({ family: "comment", kind: "edit", slide: copy, id: FIRST, text: "COPY" })).ok).toBe(true)

			const model = await comments(d)
			const next = await d.save()

			expect(next.result.kind).toBe("written")
			expect(await comments(await driveSession(next.bytes as Uint8Array, format))).toEqual(model)
		})
})
