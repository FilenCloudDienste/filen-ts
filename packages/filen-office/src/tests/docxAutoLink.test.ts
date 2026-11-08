import type { Node } from "prosemirror-model"
import { TextSelection } from "prosemirror-state"
import { describe, expect, it } from "vitest"
import type { DocxEditorSession } from "@filen/office/core/docx/edit"
import { autoLink } from "../core/docx/edit/handlers/insert"
import { sessionOf } from "./docxEditFixtures"
import { p } from "./docxSynthetic"

// Word's AutoFormat As You Type turns a web or e-mail address into a link when Space, Tab or Enter ends it:
// punctuation around it stays text, www. goes to http://, a bare address to mailto:, and one undo right after
// the key takes back only the link.

// The linked texts of `doc` and where they go.
function links(doc: Node): { text: string; target: unknown }[] {
	const out: { text: string; target: unknown }[] = []

	doc.descendants(node => {
		const link = node.marks.find(mark => mark.type.name === "link")

		if (node.isText && link !== undefined) {
			const last = out[out.length - 1]

			if (last !== undefined && last.target === link.attrs["target"]) last.text += node.text ?? ""
			else out.push({ text: node.text ?? "", target: link.attrs["target"] })
		}

		return true
	})

	return out
}

// `text` typed at the end of the first paragraph, the caret after it.
async function typed(text: string, body = p("")): Promise<DocxEditorSession> {
	const session = await sessionOf({ body })
	const end = session.state.doc.child(0).nodeSize - 1

	session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, end)))
	session.dispatch(session.state.tr.insertText(text))

	return session
}

// Space after the word: the space typed, then the link, as the input layer does.
function space(session: DocxEditorSession): void {
	const pos = session.state.selection.from

	session.dispatch(session.state.tr.insertText(" "))

	const tr = autoLink(session, pos)

	if (tr !== null) session.dispatch(tr)
}

describe("docx links as you type", () => {
	it("links a web address, leaving trailing sentence punctuation and an unbalanced bracket out", async () => {
		for (const [word, text, target] of [
			["https://filen.io/a?b=1", "https://filen.io/a?b=1", "https://filen.io/a?b=1"],
			["https://filen.io.", "https://filen.io", "https://filen.io"],
			['"https://filen.io/x",', "https://filen.io/x", "https://filen.io/x"],
			["(https://e.example/wiki/A_(b))", "https://e.example/wiki/A_(b)", "https://e.example/wiki/A_(b)"],
			["https://e.example/a)!?", "https://e.example/a", "https://e.example/a"]
		] as const) {
			const session = await typed(`See ${word}`)

			space(session)
			expect(links(session.state.doc), word).toEqual([{ text, target }])
			expect(session.state.doc.textContent).toBe(`See ${word} `)
		}
	})

	it("sends www. to http:// and an e-mail address to mailto:", async () => {
		const web = await typed("www.filen.io/pricing;")

		space(web)
		expect(links(web.state.doc)).toEqual([{ text: "www.filen.io/pricing", target: "http://www.filen.io/pricing" }])

		const mail = await typed("Mail support@filen.io.")

		space(mail)
		expect(links(mail.state.doc)).toEqual([{ text: "support@filen.io", target: "mailto:support@filen.io" }])

		const typedMailto = await typed("mailto:a.b@e.example")

		space(typedMailto)
		expect(links(typedMailto.state.doc)).toEqual([{ text: "mailto:a.b@e.example", target: "mailto:a.b@e.example" }])
	})

	it("gives the link Word's look for one and leaves what is typed next plain", async () => {
		const session = await typed("www.filen.io")

		space(session)

		const linked = session.state.doc.child(0).firstChild
		const after = session.state.doc.child(0).lastChild

		// Word's Hyperlink character style, added to a document without one.
		expect(linked?.marks.map(mark => mark.type.name)).toEqual(expect.arrayContaining(["link", "char_style"]))
		expect(linked?.marks.find(mark => mark.type.name === "char_style")?.attrs).toEqual({ styleId: "Hyperlink" })
		expect(after?.text).toBe(" ")
		expect(after?.marks.some(mark => ["link", "char_style", "color", "underline"].includes(mark.type.name))).toBe(false)
	})

	it("leaves words that are no address as text", async () => {
		for (const word of ["filen.io", "www.filen", "https://", "a@b", "@filen.io", "e.g.", "ftp://e.example", "www."]) {
			const session = await typed(word)

			space(session)
			expect(links(session.state.doc), word).toEqual([])
		}
	})

	it("takes back only the link with one undo right after the key, then the typing", async () => {
		const session = await typed("www.filen.io")

		space(session)
		expect(links(session.state.doc)).toHaveLength(1)

		expect(session.execute({ type: "history.undo" })).toBe(true)
		expect(links(session.state.doc)).toEqual([])
		expect(session.state.doc.textContent).toBe("www.filen.io ")

		// The key again after the undo leaves the address as it is.
		space(session)
		expect(links(session.state.doc)).toEqual([])
	})

	it("keeps what is typed after the link an undo step of its own", async () => {
		const session = await typed("www.filen.io")

		space(session)
		session.dispatch(session.state.tr.insertText("next"))

		expect(session.execute({ type: "history.undo" })).toBe(true)
		expect(session.state.doc.textContent).toBe("www.filen.io ")
		expect(links(session.state.doc)).toHaveLength(1)

		expect(session.execute({ type: "history.undo" })).toBe(true)
		expect(session.state.doc.textContent).toBe("www.filen.io ")
		expect(links(session.state.doc)).toEqual([])
	})

	it("does nothing inside a link, in deleted text or read-only", async () => {
		const linked = await typed("www.filen.io")
		const end = linked.state.selection.from

		linked.dispatch(linked.state.tr.setSelection(TextSelection.create(linked.state.doc, end - 12, end)))
		expect(linked.execute({ type: "link.set", target: "https://other.example" })).toBe(true)
		expect(autoLink(linked, end)).toBeNull()

		const tracked = await typed("www.filen.io")

		tracked.context.review.tracking = true
		tracked.context.identity.author = "Ann"
		tracked.dispatch(tracked.state.tr.delete(1, tracked.state.selection.from))
		tracked.context.review.tracking = false
		expect(autoLink(tracked, tracked.state.doc.child(0).nodeSize - 1)).toBeNull()

		const readOnly = await sessionOf({ body: p("www.filen.io") }, { readOnly: true })

		expect(autoLink(readOnly, readOnly.state.doc.child(0).nodeSize - 1)).toBeNull()
	})

	it("takes a tab before the address as a word boundary, and no other inline node", async () => {
		const tabbed = await sessionOf({ body: "<w:p><w:r><w:t>See</w:t><w:tab/><w:t>www.filen.io</w:t></w:r></w:p>" })
		const tabEnd = tabbed.state.doc.child(0).nodeSize - 1

		expect(autoLink(tabbed, tabEnd)).not.toBeNull()

		const marked = await sessionOf({
			body: '<w:p><w:r><w:t>https://filen</w:t></w:r><w:bookmarkStart w:id="0" w:name="b"/><w:r><w:t>.io/x</w:t></w:r></w:p>'
		})

		expect(autoLink(marked, marked.state.doc.child(0).nodeSize - 1)).toBeNull()
	})

	it("does nothing in a field's result", async () => {
		const field =
			'<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" </w:instrText></w:r>' +
			'<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t xml:space="preserve">See www.filen.io</w:t></w:r></w:p>' +
			'<w:p><w:r><w:t>Next</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
		const session = await sessionOf({ body: field })
		const end = session.state.doc.child(0).nodeSize - 1

		expect(session.state.doc.child(0).textContent).toContain("www.filen.io")
		expect(autoLink(session, end)).toBeNull()
	})

	it("stops looking back at a word too long to be an address", async () => {
		const session = await typed(`https://e.example/${"a".repeat(5000)}`)

		expect(autoLink(session, session.state.selection.from)).toBeNull()
	})
})
