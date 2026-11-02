import { describe, expect, it } from "vitest"
import type { SlideNode, SlideRef, TextBody } from "../core/presentation/model"
import { editCapability, sessionEdits } from "../dom/presentation/engine/edit"
import { review } from "../dom/presentation/engine/review"
import { textCapability } from "../dom/presentation/engine/text"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"

// Notes started and not typed in are left out of a save (it takes them back first), while the page's editor stays on
// them: the first keystroke, sent as the save runs or after it, brings them back with its text. Nothing typed is lost.

const lines = (...texts: string[]): TextBody => ({
	bodyPr: {},
	paragraphs: texts.map(text => ({ pPr: {}, runs: [{ kind: "r" as const, text, rPr: {} }] }))
})

function deckBytes(format: "pptx" | "odp"): Uint8Array {
	return format === "pptx"
		? buildPptx({
				slides: [0, 1].map(k => ({
					shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para(`S${String(k)}`)))
				}))
			})
		: odpBytes({
				body: [0, 1]
					.map(
						k =>
							`<draw:page draw:name="P${String(k)}" draw:master-page-name="M"><draw:frame draw:name="T" svg:x="1cm" svg:y="1cm" svg:width="5cm" svg:height="2cm"><draw:text-box><text:p>T${String(k)}</text:p></draw:text-box></draw:frame></draw:page>`
					)
					.join("")
			})
}

async function started(format: "pptx" | "odp") {
	const d = await driveSession(deckBytes(format), format)
	const [slide, other] = d.session.deck.slides as SlideRef[]

	if (slide === undefined || other === undefined) throw new Error("two slides")

	// Another edit, so the save writes.
	expect((await d.command({ family: "slide", kind: "hide", slides: [other], hidden: true })).ok).toBe(true)

	const made = await d.command({ family: "notes", kind: "setNotes", slide, body: lines() })

	if (!made.ok) throw new Error("setNotes refused")

	const target = (await review(d.context, slide, { comments: false })).notes

	if (target === undefined) throw new Error("no notes body")

	return { d, slide, target, revision: made.revision, history: sessionEdits(d.session).history }
}

async function reopenedNotes(bytes: Uint8Array | undefined, format: "pptx" | "odp", slide: number): Promise<string | undefined> {
	if (bytes === undefined) throw new Error("not saved")

	const re = await driveSession(bytes, format)
	const answer = await review(re.context, re.session.deck.slides[slide] as SlideRef, { comments: false })

	return answer.notes === undefined ? undefined : answer.notesText
}

describe("a save while notes just started are open", () => {
	for (const format of ["pptx", "odp"] as const) {
		it(`${format}: a keystroke sent with the save lands, and the next save writes it`, async () => {
			const { d, slide, target } = await started(format)
			const [saved, typed] = await Promise.all([
				d.save(),
				d.command({ family: "text", kind: "setText", target, body: lines("Hello") })
			])

			expect(saved.result.kind).toBe("written")
			expect(typed.ok).toBe(true)
			expect((await review(d.context, slide, { comments: false })).notesText).toBe("Hello")

			const again = await d.save()

			expect(again.result.kind).toBe("written")
			expect(await reopenedNotes(again.bytes, format, 0)).toBe("Hello")
		})

		it(`${format}: a keystroke after the save brings the notes back, laid out first as the editor does`, async () => {
			const { d, slide, target, history } = await started(format)
			const saved = await d.save()

			expect(saved.result.kind).toBe("written")
			expect(await reopenedNotes(saved.bytes, format, 0)).toBeUndefined()
			// The page's editor still names the body, and the review still answers it (empty).
			expect((await review(d.context, slide, { comments: false })).notes).toEqual(target)
			expect(history.dirty).toBe(false)

			// The editor's layout of a keystroke makes them again first (this session has no measuring services, so the
			// layout itself is refused after that).
			await textCapability.layoutText(d.context, target, lines("H")).catch(() => undefined)
			expect((d.session.deck.nodes.get(slide) as SlideNode).notes).toBe(target.slide)
			expect((await d.command({ family: "text", kind: "setText", target, body: lines("Hi") })).ok).toBe(true)
			expect((await review(d.context, slide, { comments: false })).notesText).toBe("Hi")
			expect(history.dirty).toBe(true)

			// One undo takes the notes away with their text.
			expect((await d.undo()).ok).toBe(true)
			expect((await review(d.context, slide, { comments: false })).notes).toBeUndefined()
		})

		it(`${format}: left untyped after the save, the page's retract drops them for good`, async () => {
			const { d, slide, revision, history } = await started(format)

			expect((await d.save()).result.kind).toBe("written")

			const depth = history.depth

			expect((await editCapability.retract(d.context, revision)).ok).toBe(true)
			expect((await review(d.context, slide, { comments: false })).notes).toBeUndefined()
			expect(history.depth).toEqual(depth)
			expect(history.dirty).toBe(false)
		})
	}
	it("an undo from the open notes editor that takes the notes away answers ok, with no seed (nothing to refuse)", async () => {
		const { d, slide, target } = await started("pptx")

		expect((await d.command({ family: "text", kind: "setText", target, body: lines("Gone") })).ok).toBe(true)

		// A session that measures text (the page's): the seed for the open body is asked for after the undo.
		Object.assign(d.session, { services: { ...d.session.services, text: {} } })

		const undone = await editCapability.undo(d.context, target)

		expect(undone.ok).toBe(true)
		expect(undone.ok && undone.seed).toBeUndefined()
		expect((await review(d.context, slide, { comments: false })).notes).toBeUndefined()
	})

	it("an undo from an editor still on notes a save took back (dormant) answers, never waits on itself", async () => {
		const { d, target } = await started("pptx")

		expect((await d.save()).result.kind).toBe("written")

		const undone = await Promise.race([
			editCapability.undo(d.context, target),
			new Promise<"stuck">(resolve => setTimeout(() => resolve("stuck"), 2000))
		])

		expect(undone).not.toBe("stuck")
	})
})
