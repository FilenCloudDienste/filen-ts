import { describe, expect, it } from "vitest"
import { emitPptx } from "../core/pptx/write/emit"
import { actionOp, altOp } from "../core/presentation/edit/commands/shape"
import { presentationHref, xmlSafeText } from "../core/presentation/edit/xmlText"
import { sessionEdits } from "../dom/presentation/engine/edit"
import { isPresentationUrl } from "../react/presentation/links"
import type { DeckOp } from "../core/presentation/edit/ops"
import { editDeck, editHarness, shapeById } from "./presentationEditFixtures"
import { saveEdits } from "./pptxWriteFixtures"

const EDIT = { emit: emitPptx } as never

describe("text and links the editor sets", () => {
	it("takes out what XML cannot carry and keeps everything else, the same string when nothing changes", () => {
		const plain = "tab\there\nline\r and 😀"

		expect(xmlSafeText(plain)).toBe(plain)
		expect(xmlSafeText("line one\u000bline two")).toBe("line one line two")
		expect(xmlSafeText("a\u000cb\u0001c\u001fd")).toBe("a bcd")
		expect(xmlSafeText("x\ud800y\udc00z￾￿")).toBe("xyz")
	})

	it("stores a link with spaces percent-encoded, as the save reads it back, and refuses what is no link", () => {
		expect(presentationHref(" https://example.com/my file.pdf ")).toBe("https://example.com/my%20file.pdf")
		expect(presentationHref("mailto:a@b.com?subject=Hello world")).toBe("mailto:a@b.com?subject=Hello%20world")
		expect(presentationHref("https://exa mple.com/")).toBeUndefined()
		expect(presentationHref("javascript:alert(1)")).toBeUndefined()
		expect(presentationHref("file:///etc/passwd")).toBeUndefined()
		expect(presentationHref("HTTPS://A.EXAMPLE")).toBe("HTTPS://A.EXAMPLE")
	})

	it("judges a link at the click by the reader's rule: one with a space is no link", () => {
		expect(isPresentationUrl("https://example.com/my file.pdf")).toBe(false)
		expect(isPresentationUrl("https://example.com/my%20file.pdf")).toBe(true)
	})

	it("a url action typed with spaces saves, and reads back as the same url", async () => {
		const h = await editHarness(editDeck(), EDIT)
		const slide = await h.slide(0)
		const op = actionOp({ slide: slide.ref, id: 9 }, "click", { kind: "url", href: "https://example.com/my file.pdf" })

		expect(op).toMatchObject({ action: { kind: "url", href: "https://example.com/my%20file.pdf" } })
		expect(await h.command(op as DeckOp)).toMatchObject({ ok: true })
		await expect(saveEdits(h, sessionEdits(h.session).history.revision)).resolves.toBeInstanceOf(Uint8Array)
		h.close()
	})

	it("alt text pasted with PowerPoint's soft line break saves", async () => {
		const h = await editHarness(editDeck(), EDIT)
		const slide = await h.slide(0)

		expect(await h.command(altOp({ slide: slide.ref, id: 3 }, { descr: "line one\u000bline two\u0001" }))).toMatchObject({ ok: true })
		expect(shapeById(slide.shapes, 3)?.alt).toEqual({ descr: "line one line two" })
		await expect(saveEdits(h, sessionEdits(h.session).history.revision)).resolves.toBeInstanceOf(Uint8Array)
		h.close()
	})

	it("the worker refuses alt text and links the deck could not carry, so a save is never blocked by them", async () => {
		const h = await editHarness(editDeck(), EDIT)
		const slide = await h.slide(0)

		expect(
			await h.command({ family: "shape", kind: "setAlt", target: { slide: slide.ref, id: 3 }, alt: { descr: "a\u000bb" } })
		).toEqual({ ok: false, refusal: "malformed" })
		expect(
			await h.command({
				family: "shape",
				kind: "setAction",
				target: { slide: slide.ref, id: 9 },
				trigger: "click",
				action: { kind: "url", href: "https://example.com/my file.pdf" }
			})
		).toEqual({ ok: false, refusal: "malformed" })
		h.close()
	})
})
