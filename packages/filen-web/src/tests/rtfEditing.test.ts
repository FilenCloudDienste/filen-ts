import { TextSelection } from "prosemirror-state"
import { describe, expect, it } from "vitest"
import { OpcPackage, bytesSource } from "@filen/office/core/opc"
import { buildDocxModel, openDocxPackage } from "@filen/office/core/docx"
import { DocxEditorSession, openDocxEditContext } from "@filen/office/core/docx/edit"
import { DocxSaveError } from "@filen/office/core/docx/write"
import { readRtf } from "@filen/office/core/rtf"
import { DocxRtfRefusal, type RtfLockedBlock } from "@filen/office/dom/docx/rtf"
import { inThreadDocxRtf } from "@filen/office/dom/docx/rtfWorker"
import { FormatSaveError, rtfEditingBackend } from "@/features/preview/lib/rtfEditing"

// An RTF document saved through the docx editor's save path: Gate 1 from both writers, the docx writer's parts
// written back as RTF (prepare writes, the zipper hands out), refusals as the docx writer's own.

function latin1(text: string): Uint8Array {
	return Uint8Array.from(text, character => character.charCodeAt(0) & 0xff)
}

const RTF = latin1(
	"{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0 Times New Roman;}}" +
		"\\pard\\plain\\f0\\fs24 First paragraph\\par\n\\pard\\plain\\f0\\fs24 Second {\\b bold} paragraph\\par\n}"
)

async function editing(bytes: Uint8Array) {
	// Engine sessions are not opened here: no services.
	const opened = await inThreadDocxRtf(() => {
		throw new Error("no engine in this test")
	}).open(bytes)

	if (opened.kind !== "opened") throw new Error(opened.kind)

	const document = opened.document
	const backend = rtfEditingBackend(document, document.prove())
	const pkg = await openDocxPackage(bytesSource(await document.take()))

	if (!pkg.ok) throw new Error(pkg.reason)

	const context = await openDocxEditContext(pkg.package, await buildDocxModel(pkg.package))
	const made = backend.proof(context)
	const session = new DocxEditorSession(context, { proof: "later" in made ? (await made.later).full : made })
	const save = async (): Promise<Uint8Array> => {
		const prepared = await backend.writer.prepare({ pkg: pkg.package, context, sessions: [session] }, {})
		const zipper = backend.writer.zipper?.(pkg.package.opc)

		if (zipper === undefined) throw new Error("no zipper")

		return (await zipper.zip(prepared)).bytes
	}

	return { session, save, document, context }
}

async function body(rtf: Uint8Array): Promise<string> {
	const read = await readRtf(rtf)

	if (!read.ok) throw new Error(read.reason)

	const xml = new TextDecoder().decode(await (await OpcPackage.open(bytesSource(read.docx))).read("word/document.xml"))

	return [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/gu)].map(match => match[1]).join("")
}

describe("RTF editing backend", () => {
	it("carries what the file shows that its package leaves out (a drawing object), for the editor's PDF to report", async () => {
		const plain = await editing(RTF)
		const drawing = await editing(
			latin1(
				"{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Times New Roman;}}\\pard\\plain Before" +
					"{\\*\\do\\dobxcolumn\\dobypara\\dodhgt8192\\dprect\\dpx0\\dpy0\\dpxsize100\\dpysize100}\\par\n}"
			)
		)
		// An equation is in the package, as Office Math: nothing to report.
		const math = await editing(
			latin1(
				"{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Times New Roman;}}\\pard\\plain Before\\par\n" +
					"\\pard\\plain {\\mmath{\\*\\moMath{\\*\\mr a}}}\\par\n}"
			)
		)

		expect(rtfEditingBackend(plain.document, plain.document.prove()).untranslated).toBe(0)
		expect(rtfEditingBackend(drawing.document, drawing.document.prove()).untranslated).toBe(1)
		expect(rtfEditingBackend(math.document, math.document.prove()).untranslated).toBe(0)
	})

	it("saves an untouched document as its own bytes", async () => {
		const { save } = await editing(RTF)

		expect(await save()).toEqual(RTF)
	})

	it("saves an edit as RTF that reads back with it, the other paragraph's bytes kept", async () => {
		const { session, save } = await editing(RTF)

		session.dispatch(session.state.tr.insertText("Edited ", 1))

		const saved = await save()
		const text = new TextDecoder("latin1").decode(saved)

		expect(text.startsWith("{\\rtf1")).toBe(true)
		expect(text).toContain("\\pard\\plain\\f0\\fs24 Second {\\b bold} paragraph\\par\n")
		expect(await body(saved)).toBe("Edited First paragraphSecond bold paragraph")
	})

	it("refuses what RTF has no form for (a tracked row insertion) as the docx writer's own refusal", async () => {
		const { session, save, context } = await editing(RTF)

		context.identity.author = "Ann"
		context.review.tracking = true
		session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, 2)))
		expect(session.execute({ type: "table.insert", rows: 2, cols: 2 })).toBe(true)

		const refusal = await save().then(
			() => undefined,
			(error: unknown) => error
		)

		expect(refusal).toBeInstanceOf(DocxSaveError)
		expect((refusal as DocxSaveError).reason).toBe("write")
		expect((refusal as DocxSaveError).message).toMatch(/^RTF: .*RTF 1\.9\.1/u)
	})

	it("hands on what the file's writer says it wrote otherwise than the edit has it", async () => {
		const { session, document, context } = await editing(RTF)
		const notices = [{ kind: "commentPoint", count: 1 }] as const
		const noting = {
			...document,
			write: async (edits: Parameters<typeof document.write>[0]) => ({ ...(await document.write(edits)), notices })
		}
		const backend = rtfEditingBackend(noting, Promise.resolve([]))
		const pkg = await openDocxPackage(bytesSource(await document.take()))

		if (!pkg.ok) throw new Error(pkg.reason)

		session.dispatch(session.state.tr.insertText("Edited ", 1))

		const prepared = await backend.writer.prepare({ pkg: pkg.package, context, sessions: [session] }, {})
		const zipped = await backend.writer.zipper?.(pkg.package.opc).zip(prepared)

		expect(zipped?.notices).toEqual(notices)
	})

	it("refuses a reply or a resolved comment, which RTF cannot keep, with its own message", async () => {
		const { session, document, context } = await editing(RTF)
		const refusing = { ...document, write: () => Promise.reject(new DocxRtfRefusal("comment", "a resolved comment")) }
		const backend = rtfEditingBackend(refusing, Promise.resolve([]))
		const pkg = await openDocxPackage(bytesSource(await document.take()))

		if (!pkg.ok) throw new Error(pkg.reason)

		session.dispatch(session.state.tr.insertText("Edited ", 1))

		const refusal = await backend.writer.prepare({ pkg: pkg.package, context, sessions: [session] }, {}).then(
			() => undefined,
			(error: unknown) => error
		)

		expect(refusal).toBeInstanceOf(FormatSaveError)
		expect(refusal).toBeInstanceOf(DocxSaveError)
		expect((refusal as FormatSaveError).messageKey).toBe("previewDocxSaveRefusedRtfComments")
		expect((refusal as FormatSaveError).message).toBe("RTF: a resolved comment")
	})

	it("checks the docx writer's Gate 1 at once and the RTF writer's once its locks arrive", async () => {
		// The second paragraph holds source the reader keeps only as bytes: the RTF writer locks it.
		const opened = await inThreadDocxRtf(() => {
			throw new Error("no engine in this test")
		}).open(
			latin1(
				"{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Times New Roman;}}\\pard\\plain Plain paragraph\\par\n" +
					"\\pard\\plain Before {\\*\\unknowndest kept bytes} after\\par\n}"
			)
		)

		if (opened.kind !== "opened") throw new Error(opened.kind)

		const document = opened.document
		let arrive: (locked: readonly RtfLockedBlock[]) => void = () => undefined
		const backend = rtfEditingBackend(
			document,
			new Promise(resolve => {
				arrive = resolve
			})
		)
		const pkg = await openDocxPackage(bytesSource(await document.take()))

		if (!pkg.ok) throw new Error(pkg.reason)

		const context = await openDocxEditContext(pkg.package, await buildDocxModel(pkg.package))
		const made = backend.proof(context)

		if (!("later" in made)) throw new Error("the RTF writer's proof is not awaited")

		let arrived = false
		const later = made.later.then(proof => {
			arrived = true

			return proof
		})
		const types = (session: DocxEditorSession): string[] => {
			const out: string[] = []

			session.state.doc.forEach(node => out.push(node.type.name))

			return out
		}

		// The docx writer writes both paragraphs: only the RTF writer locks one.
		expect(types(new DocxEditorSession(context, { proof: made.first }))).toEqual(["paragraph", "paragraph"])
		await new Promise(resolve => setTimeout(resolve, 0))
		expect(arrived).toBe(false)

		arrive(await document.prove())

		const { extra, full } = await later

		expect(types(new DocxEditorSession(context, { proof: extra }))).toEqual(["paragraph", "locked_block"])
		expect(types(new DocxEditorSession(context, { proof: full }))).toEqual(["paragraph", "locked_block"])
		document.release()
	})
})
