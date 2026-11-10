import type { Node as ProseMirrorNode } from "prosemirror-model"
import { TextSelection } from "prosemirror-state"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { bytesSource, OpcPackage } from "@filen/office/core/opc"
import { commandInfo, docxSchema, shortcutFor } from "@filen/office/core/docx/edit"
import { saveDocx } from "@filen/office/core/docx/write"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import type { KeyLike } from "../core/docx/paged/keys"
import { commandForKey } from "./docxKeyHelpers"
import { buildDocx, p } from "./docxSynthetic"
import { pagedEditor, settleAll } from "./pagedFixtures"

const nodes = docxSchema.nodes
const decoder = new TextDecoder()

beforeEach(() => {
	vi.stubEnv("TZ", "UTC")
})

function key(init: Partial<KeyLike> & { key: string; code: string }): KeyLike {
	return { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...init }
}

async function open(body: string): Promise<Awaited<ReturnType<typeof pagedEditor>>> {
	const opened = await pagedEditor(buildDocx({ body }))

	opened.context.identity.now = () => Date.UTC(2026, 9, 12, 14, 5, 9)
	await settleAll(opened.editor)

	return opened
}

function select(editor: PagedEditor, from: number, to: number = from): void {
	const session = editor.session

	session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, from, to)))
}

function fieldCount(doc: ProseMirrorNode): number {
	let count = 0

	doc.descendants(node => {
		if (node.type === nodes.field) count++

		return true
	})

	return count
}

function text(editor: PagedEditor): string {
	const doc = editor.session.state.doc

	return doc.textBetween(0, doc.content.size, "\n", leaf => (leaf.type === nodes.tab ? "\t" : leaf.type === nodes.field ? "[F]" : ""))
}

async function documentXml(opened: Awaited<ReturnType<typeof pagedEditor>>): Promise<string> {
	const saved = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: opened.editor.sessions })
	const pkg = await OpcPackage.open(bytesSource(saved.bytes as Uint8Array))

	return decoder.decode(await pkg.read("word/document.xml"))
}

function complex(instruction: string, result: string, rPr = ""): string {
	return (
		`<w:r>${rPr}<w:fldChar w:fldCharType="begin"/></w:r><w:r>${rPr}<w:instrText xml:space="preserve">${instruction}</w:instrText></w:r>` +
		`<w:r>${rPr}<w:fldChar w:fldCharType="separate"/></w:r><w:r>${rPr}<w:t>${result}</w:t></w:r><w:r>${rPr}<w:fldChar w:fldCharType="end"/></w:r>`
	)
}

describe("Unlink Fields (Ctrl+Shift+F9)", () => {
	it("binds Ctrl+Shift+F9 and Cmd+Shift+F9", () => {
		expect(commandForKey(key({ key: "F9", code: "F9", ctrlKey: true, shiftKey: true }), false)).toEqual({ type: "field.unlink" })
		expect(commandForKey(key({ key: "F9", code: "F9", metaKey: true, shiftKey: true }), true)).toEqual({ type: "field.unlink" })
		expect(commandForKey(key({ key: "F9", code: "F9", shiftKey: true }), false)).toEqual({ type: "view.fieldCode" })
	})

	it("turns the field at the caret into its result with the field's formatting, saved as a plain run, and undoes", async () => {
		const opened = await open(
			`<w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r>${complex(" PAGE ", "4", "<w:rPr><w:b/></w:rPr>")}</w:p>`
		)
		const editor = opened.editor
		const before = editor.session.state.doc

		select(editor, 6)
		expect(editor.canExecute("field.unlink")).toBe(true)
		expect(editor.execute({ type: "field.unlink" })).toBe(true)
		expect(fieldCount(editor.session.state.doc)).toBe(0)
		expect(text(editor)).toBe("Page 4")

		const four = editor.session.state.doc.nodeAt(6)

		expect(four?.text).toBe("4")
		expect(docxSchema.marks.bold.isInSet(four?.marks ?? [])).toBeDefined()

		const xml = await documentXml(opened)

		expect(xml).not.toContain("fldChar")
		expect(xml).not.toContain("instrText")
		expect(xml).toMatch(/<w:r><w:rPr><w:b\/><\/w:rPr><w:t>4<\/w:t><\/w:r>/)

		expect(await editor.execute({ type: "history.undo" })).toBe(true)
		expect(editor.session.state.doc.eq(before)).toBe(true)
	})

	it("unlinks every field of the selection, tabs in a result kept as tabs", async () => {
		const result = "<w:r><w:t>a</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>b</w:t></w:r>"
		const tabbed =
			'<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> REF x </w:instrText></w:r>' +
			`<w:r><w:fldChar w:fldCharType="separate"/></w:r>${result}<w:r><w:fldChar w:fldCharType="end"/></w:r>`
		const opened = await open(`<w:p>${complex(" PAGE ", "1")}<w:r><w:t xml:space="preserve"> of </w:t></w:r>${tabbed}</w:p>`)
		const editor = opened.editor

		select(editor, 1, editor.session.state.doc.content.size - 1)
		expect(editor.execute({ type: "field.unlink" })).toBe(true)
		expect(fieldCount(editor.session.state.doc)).toBe(0)
		expect(text(editor)).toBe("1 of a\tb")
	})

	it("keeps a bookmark inside the field's result", async () => {
		const opened = await open(
			'<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>' +
				'<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:bookmarkStart w:id="3" w:name="inside"/><w:r><w:t>7</w:t></w:r><w:bookmarkEnd w:id="3"/>' +
				'<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
		)

		select(opened.editor, 1)
		expect(opened.editor.execute({ type: "field.unlink" })).toBe(true)

		const paragraph = opened.editor.session.state.doc.child(0)
		const shown: string[] = []

		paragraph.forEach(child => shown.push(child.isText ? (child.text ?? "") : `${child.type.name}:${child.attrs["kind"] as string}`))
		expect(shown).toEqual(["marker:bookmarkStart", "marker:bookmarkEnd", "7"])
	})

	it("is off with no field at the caret", async () => {
		const opened = await open(p("Plain text"))

		select(opened.editor, 3)
		expect(opened.editor.canExecute("field.unlink")).toBe(false)
		expect(opened.editor.execute({ type: "field.unlink" })).toBe(false)
	})

	it("records the unlink while tracking as the field deleted and its result inserted", async () => {
		const opened = await open(`<w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r>${complex(" PAGE ", "4")}</w:p>`)
		const editor = opened.editor

		opened.context.identity.author = "Ann Lee"
		opened.context.review.tracking = true
		select(editor, 6)
		expect(editor.execute({ type: "field.unlink" })).toBe(true)

		const xml = await documentXml(opened)

		expect(xml).toMatch(/<w:del\b[^>]*w:author="Ann Lee"[^>]*>.*fldChar.*<\/w:del>/)
		expect(xml).toMatch(/<w:ins\b[^>]*w:author="Ann Lee"[^>]*><w:r><w:t>4<\/w:t><\/w:r><\/w:ins>/)
	})
})

describe("Insert PAGE, DATE and TIME fields (Alt+Shift+P, D, T)", () => {
	it("binds Alt+Shift+P/D/T, and Control+Shift+P/D/T on a Mac", () => {
		const page = commandInfo("insert.pageNumber")

		expect(page === undefined ? undefined : shortcutFor(page, false)).toBe("alt+shift+p")
		expect(page === undefined ? undefined : shortcutFor(page, true)).toBe("ctrl+shift+p")

		for (const apple of [false, true]) {
			const mods = apple ? { ctrlKey: true, shiftKey: true } : { altKey: true, shiftKey: true }

			expect(commandForKey(key({ key: "P", code: "KeyP", ...mods }), apple)).toEqual({ type: "insert.pageNumber" })
			expect(commandForKey(key({ key: "D", code: "KeyD", ...mods }), apple)).toEqual({
				type: "insert.field",
				instruction: ' DATE \\@ "M/d/yyyy" '
			})
			expect(commandForKey(key({ key: "T", code: "KeyT", ...mods }), apple)).toEqual({
				type: "insert.field",
				instruction: ' TIME \\@ "h:mm am/pm" '
			})
		}

		// Option+Shift composes a character on a Mac; Ctrl+Shift+D stays double underline elsewhere.
		expect(commandForKey(key({ key: "Î", code: "KeyD", altKey: true, shiftKey: true }), true)).toBeUndefined()
		expect(commandForKey(key({ key: "D", code: "KeyD", ctrlKey: true, shiftKey: true }), false)).toEqual({
			type: "format.doubleUnderline"
		})
	})

	it("inserts the fields the keys run with their results", async () => {
		const opened = await open(p("At "))
		const editor = opened.editor

		select(editor, 4)

		for (const event of [
			key({ key: "P", code: "KeyP", altKey: true, shiftKey: true }),
			key({ key: "D", code: "KeyD", altKey: true, shiftKey: true }),
			key({ key: "T", code: "KeyT", altKey: true, shiftKey: true })
		]) {
			const command = commandForKey(event, false)

			expect(command === undefined ? false : editor.execute(command)).toBe(true)
		}

		const results: string[] = []

		editor.session.state.doc.descendants(node => {
			if (node.type === nodes.field) results.push(`${node.attrs["type"] as string}=${node.attrs["result"] as string}`)

			return true
		})
		expect(results).toEqual(["PAGE=1", "DATE=10/12/2026", "TIME=2:05 PM"])
	})
})
