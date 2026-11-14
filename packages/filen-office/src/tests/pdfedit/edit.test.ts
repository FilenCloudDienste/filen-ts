import { MessageChannel } from "node:worker_threads"
import { afterEach, describe, expect, it } from "vitest"
import * as mupdf from "mupdf"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
import { savePortReader, type SavePortEnd } from "@filen/shared/savePort"
import { PDF_DESKTOP_MEMORY } from "../../core/pdfedit"
import type { PdfEngineClient } from "../../dom/pdfedit/client"
import { createSyncRangeBuffer, type SyncRangePort } from "../../dom/pdfedit/syncRange"
import type { PdfSaveCheck, PdfSaveExpectation } from "../../dom/pdfedit/protocol"
import { makeFormPdf } from "./fixtures"
import { spawnEngine, startEngine, stopEngines } from "./harness"
import { signedFixture } from "../pdfSignFixtures"
import { pdfSignatureFields } from "../../dom/pdf/signatureFields"
import { budget } from "../timing"

afterEach(stopEngines)

const TIMEOUT = budget(30_000)

async function widgetsByField(client: PdfEngineClient) {
	const pages = await client.call("widgets", { pages: [0, 1] })

	return new Map(pages.flatMap(page => page.widgets).map(widget => [widget.field + (widget.onState ?? ""), widget]))
}

// The first text field.
async function textField(client: PdfEngineClient) {
	const pages = await client.call("widgets", { pages: [0] })
	const found = pages.flatMap(page => page.widgets).find(entry => entry.type === "text")

	if (found === undefined) throw new Error("no text field")

	return found
}

async function widget(client: PdfEngineClient, key: string) {
	const found = (await widgetsByField(client)).get(key)

	if (found === undefined) throw new Error(`no widget ${key}`)

	return found
}

// The written file checked by a second engine reading it from the first one's heap.
async function checkInVerifier(client: PdfEngineClient, size: number, expected: PdfSaveExpectation): Promise<PdfSaveCheck> {
	const buffer = createSyncRangeBuffer(8, 64 * 1024)
	const channel = new MessageChannel()

	await client.call("serveOutput", { buffer, port: channel.port1 as unknown as SyncRangePort }, [channel.port1])

	const verifier = spawnEngine({})
	const opened = await verifier.call(
		"open",
		{ channel: { buffer, port: channel.port2 as unknown as SyncRangePort, length: size }, role: "verify" },
		[channel.port2]
	)

	expect(opened.status).toBe("open")

	const check = await verifier.call("checkSaved", expected)

	verifier.terminate()

	return check
}

// The held output streamed over a save port, read here as an upload would; `fail` aborts it halfway.
async function upload(client: PdfEngineClient, fail = false): Promise<{ readonly uploaded: boolean; readonly bytes: Uint8Array }> {
	const channel = new MessageChannel()
	const reader = savePortReader(channel.port2 as unknown as SavePortEnd)
	const written = client.call("writeOutput", { port: channel.port1 }, [channel.port1])
	const chunks: Uint8Array[] = []

	for (let chunk = await reader.read(); chunk !== undefined; chunk = await reader.read()) {
		chunks.push(chunk)

		if (fail) {
			reader.abort("upload")

			break
		}
	}

	if (!fail) reader.settled(true)

	const { uploaded } = await written
	const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
	let at = 0

	for (const chunk of chunks) {
		bytes.set(chunk, at)
		at += chunk.length
	}

	return { uploaded, bytes }
}

async function pdfjsFieldValues(bytes: Uint8Array): Promise<Record<string, unknown>> {
	const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 })
	const document = await task.promise
	const annotations = (await (await document.getPage(1)).getAnnotations()) as { fieldName?: string; fieldValue?: unknown }[]
	const values: Record<string, unknown> = {}

	for (const annotation of annotations) if (annotation.fieldName !== undefined) values[annotation.fieldName] = annotation.fieldValue

	await task.destroy()

	return values
}

describe("editing a form in the engine", () => {
	it(
		"reports the form's widgets, text and links",
		async () => {
			const engine = startEngine(makeFormPdf())

			await engine.open()

			const state = await engine.client.call("state", {})

			expect(state).toMatchObject({ pageCount: 2, dirty: false, canUndo: false, canRedo: false, tagged: false })
			expect(state.form).toEqual({ fields: 5, scripts: false, xfa: "none" })
			expect(state.tools.formFill).toBeNull()

			const name = await widget(engine.client, "name")

			expect(name).toMatchObject({ type: "text", page: 0, maxLength: 20, readOnly: false, value: "" })
			// Bottom-left user space, as the file's /Rect.
			expect(name.rect).toEqual([72, 680, 300, 700])
			expect(await widget(engine.client, "fixed")).toMatchObject({ readOnly: true, value: "Locked" })
			expect(await widget(engine.client, "colour")).toMatchObject({
				type: "combobox",
				options: ["Red", "Green", "Blue"],
				value: "Red"
			})
			expect(await widget(engine.client, "choiceB")).toMatchObject({ type: "radio", page: 1 })

			const text = await engine.client.call("text", { page: 0 })

			expect(text.lines.map(line => line.str)).toContain("Form page 1")

			const title = text.lines.find(line => line.str === "Form page 1")

			expect(title).toMatchObject({ x: 72, y: 760, size: 18, dx: 1, dy: 0 })
			expect(title?.width).toBeGreaterThan(100)
			expect(text.links).toEqual([
				{ rect: [72, 450, 200, 470], url: "https://filen.io/" },
				{ rect: [72, 420, 200, 440], page: 1, left: 0, top: 800 }
			])
		},
		TIMEOUT
	)

	it(
		"runs each change as one undoable step and refuses what the form does not allow",
		async () => {
			const engine = startEngine(makeFormPdf())

			await engine.open()

			const name = await widget(engine.client, "name")
			const typed = await engine.client.call("dispatch", {
				command: "forms.setText",
				args: { page: 0, widget: name.id, value: "Ada Lovelace, Countess of Lovelace" }
			})

			expect(typed.pages).toEqual([0])
			expect(typed.state).toMatchObject({ dirty: true, canUndo: true, undoLabel: "forms.setText", changes: ["formFill"] })
			// The field's /MaxLen.
			expect(typed.widgets[0]?.widgets.find(entry => entry.id === name.id)?.value).toBe("Ada Lovelace, Counte")

			const radio = await widget(engine.client, "choiceA")
			const toggled = await engine.client.call("dispatch", { command: "forms.toggle", args: { page: 0, widget: radio.id } })

			// The group's other button is on page 2.
			expect(toggled.pages).toEqual([0, 1])

			const colour = await widget(engine.client, "colour")

			await engine.client.call("dispatch", { command: "forms.setChoice", args: { page: 0, widget: colour.id, value: "Blue" } })
			await expect(
				engine.client.call("dispatch", { command: "forms.setChoice", args: { page: 0, widget: colour.id, value: "Purple" } })
			).rejects.toMatchObject({ failure: "badRequest" })

			const fixed = await widget(engine.client, "fixed")

			await expect(
				engine.client.call("dispatch", { command: "forms.setText", args: { page: 0, widget: fixed.id, value: "x" } })
			).rejects.toMatchObject({ failure: "notAllowed" })
			await expect(engine.client.call("dispatch", { command: "forms.setText", args: { page: 0 } })).rejects.toMatchObject({
				failure: "badRequest"
			})
			await expect(engine.client.call("dispatch", { command: "nope", args: {} })).rejects.toMatchObject({ failure: "badRequest" })

			// A refused command left no step behind.
			expect((await engine.client.call("state", {})).undoLabel).toBe("forms.setChoice")

			const undone = await engine.client.call("undo", {})

			expect(undone.state).toMatchObject({ canRedo: true, redoLabel: "forms.setChoice" })
			expect((await widget(engine.client, "colour")).value).toBe("Red")

			await engine.client.call("undo", {})
			await engine.client.call("undo", {})

			const clean = await engine.client.call("state", {})

			expect(clean).toMatchObject({ dirty: false, canUndo: false, canRedo: true })
			expect((await widget(engine.client, "name")).value).toBe("")

			await engine.client.call("redo", {})
			expect((await widget(engine.client, "name")).value).toBe("Ada Lovelace, Counte")
		},
		TIMEOUT
	)

	it(
		"coalesces a gesture's steps into one operation",
		async () => {
			const engine = startEngine(makeFormPdf())

			await engine.open()

			const name = await widget(engine.client, "name")

			for (const [index, value] of ["A", "Ab", "Abc"].entries()) {
				await engine.client.call("dispatch", {
					command: "forms.setText",
					args: { page: 0, widget: name.id, value },
					op: { id: "typing", final: index === 2 }
				})
			}

			await engine.client.call("undo", {})

			const state = await engine.client.call("state", {})

			expect(state).toMatchObject({ canUndo: false, dirty: false })
			expect((await widget(engine.client, "name")).value).toBe("")
		},
		TIMEOUT
	)
})

describe("saving an edited document", () => {
	it(
		"writes, checks in a second engine, uploads, and keeps the undo history",
		async () => {
			const source = makeFormPdf()
			const engine = startEngine(source)

			await engine.open()

			const name = await widget(engine.client, "name")
			const agree = await widget(engine.client, "agreeYes")

			await engine.client.call("dispatch", { command: "forms.setText", args: { page: 0, widget: name.id, value: "Hello" } })
			await engine.client.call("dispatch", { command: "forms.toggle", args: { page: 0, widget: agree.id } })

			const begun = await engine.client.call("saveBegin", {
				inputBytes: source.length,
				memory: PDF_DESKTOP_MEMORY,
				invalidateConfirmed: false
			})

			if (begun.status !== "written") throw new Error("refused")

			expect(begun.plan.mode).toBe("full")
			// No edits while a save is held.
			await expect(
				engine.client.call("dispatch", { command: "forms.setText", args: { page: 0, widget: name.id, value: "x" } })
			).rejects.toMatchObject({ failure: "badRequest" })

			const check = await checkInVerifier(engine.client, begun.size, {
				pageCount: 2,
				versions: begun.versions,
				encryption: "None"
			})

			expect(check).toEqual({ ok: true })
			expect(await checkInVerifier(engine.client, begun.size, { pageCount: 3, versions: 1, encryption: "None" })).toMatchObject({
				ok: false
			})

			const { uploaded, bytes } = await upload(engine.client)

			expect(uploaded).toBe(true)
			expect(bytes.length).toBe(begun.size)
			expect(await pdfjsFieldValues(bytes)).toMatchObject({ name: "Hello", agree: "Yes" })

			const reopened = mupdf.Document.openDocument(bytes, "application/pdf").asPDF()

			const reopenedPage = reopened?.loadPage(0)

			expect(reopened?.countVersions()).toBe(1)
			expect(reopenedPage instanceof mupdf.PDFPage ? reopenedPage.getWidgets().map(entry => entry.getValue()) : []).toContain("Hello")

			const ended = await engine.client.call("saveEnd", { outcome: "saved", next: "continue" })

			expect(ended.history).toBe("kept")
			expect(ended.state).toMatchObject({ dirty: false, canUndo: true, undoLabel: "forms.toggle" })

			const undone = await engine.client.call("undo", {})

			expect(undone.state).toMatchObject({ dirty: true, undoLabel: "forms.setText" })
			expect((await widget(engine.client, "agreeYes")).value).toBe("Off")

			// Past the save: the document as opened, its earlier steps run again.
			const first = await engine.client.call("undo", {})

			expect(first.state).toMatchObject({ dirty: true, canUndo: false, canRedo: true })
			expect((await widget(engine.client, "name")).value).toBe("")

			await engine.client.call("redo", {})
			expect((await widget(engine.client, "name")).value).toBe("Hello")
			await engine.client.call("redo", {})
			expect((await engine.client.call("state", {})).dirty).toBe(false)
			expect((await widget(engine.client, "agreeYes")).value).toBe("Yes")

			// The rebuilt document undoes through its journal again.
			await engine.client.call("undo", {})
			expect((await widget(engine.client, "agreeYes")).value).toBe("Off")
		},
		TIMEOUT
	)

	it(
		"leaves the document dirty when the upload fails, and after a copy",
		async () => {
			const source = makeFormPdf()
			const engine = startEngine(source)

			await engine.open()

			const name = await widget(engine.client, "name")

			await engine.client.call("dispatch", { command: "forms.setText", args: { page: 0, widget: name.id, value: "Hello" } })

			const save = () =>
				engine.client.call("saveBegin", { inputBytes: source.length, memory: PDF_DESKTOP_MEMORY, invalidateConfirmed: false })

			await save()
			expect((await upload(engine.client, true)).uploaded).toBe(false)
			expect((await engine.client.call("saveEnd", { outcome: "failed", next: "continue" })).state.dirty).toBe(true)

			await save()
			expect((await upload(engine.client)).uploaded).toBe(true)
			expect((await engine.client.call("saveEnd", { outcome: "copied", next: "continue" })).state.dirty).toBe(true)
		},
		TIMEOUT
	)

	it(
		"goes on on the written file opened in place, with a new history",
		async () => {
			const source = makeFormPdf()
			const engine = startEngine(source)

			await engine.open()

			const name = await widget(engine.client, "name")

			await engine.client.call("dispatch", { command: "forms.setText", args: { page: 0, widget: name.id, value: "Kept" } })
			await engine.client.call("saveBegin", { inputBytes: source.length, memory: PDF_DESKTOP_MEMORY, invalidateConfirmed: false })
			await upload(engine.client)

			const ended = await engine.client.call("saveEnd", { outcome: "saved", next: "adopt" })

			expect(ended.history).toBe("reset")
			expect(ended.state).toMatchObject({ dirty: false, canUndo: false, versions: 1 })

			const adopted = await widget(engine.client, "name")

			expect(adopted.value).toBe("Kept")

			// Edits and renders go on on the adopted document.
			await engine.client.call("dispatch", { command: "forms.setText", args: { page: 0, widget: adopted.id, value: "Again" } })
			await engine.client.call("render", { page: 0, scale: 0.25, rotation: 0, tile: [0, 0, 100, 100], priority: "visible" })
			expect((await engine.client.call("state", {})).dirty).toBe(true)
		},
		TIMEOUT
	)

	it(
		"saves a signed document incrementally, adding one revision",
		async () => {
			const source = signedFixture("approval-rsa.pdf")
			const engine = startEngine(source)
			const opened = await engine.open()
			const versions = opened.status === "open" ? opened.document.versions : 0

			expect(versions).toBe(2)

			const state = await engine.client.call("state", {})

			expect(state.signatures.fields.length).toBe(1)
			expect(state.tools).toMatchObject({ formFill: null, pages: "signed" })

			const begun = await engine.client.call("saveBegin", {
				inputBytes: source.length,
				memory: PDF_DESKTOP_MEMORY,
				invalidateConfirmed: false
			})

			if (begun.status !== "written") throw new Error("refused")

			expect(begun.plan.mode).toBe("incremental")
			// Nothing changed: nothing appended.
			expect(begun.versions).toBe(versions)

			const { bytes } = await upload(engine.client)

			// The signed bytes are kept as they are.
			expect(bytes.subarray(0, source.length)).toEqual(source)
			expect(
				await checkInVerifier(engine.client, begun.size, { pageCount: 1, versions: begun.versions, encryption: "None" })
			).toEqual({
				ok: true
			})
		},
		TIMEOUT
	)

	it(
		"appends each incremental save of a signed document to the one before, keeping the signature and the history",
		async () => {
			const source = signedFixture("approval-rsa.pdf")
			const engine = startEngine(source)

			await engine.open()

			const save = async (value: string): Promise<Uint8Array> => {
				const field = await textField(engine.client)

				await engine.client.call("dispatch", { command: "forms.setText", args: { page: 0, widget: field.id, value } })

				const begun = await engine.client.call("saveBegin", {
					inputBytes: source.length,
					memory: PDF_DESKTOP_MEMORY,
					invalidateConfirmed: false
				})

				if (begun.status !== "written") throw new Error("refused")

				expect(begun.plan.mode).toBe("incremental")
				expect(
					await checkInVerifier(engine.client, begun.size, { pageCount: 1, versions: begun.versions, encryption: "None" })
				).toEqual({
					ok: true
				})

				const { bytes } = await upload(engine.client)
				const ended = await engine.client.call("saveEnd", { outcome: "saved", next: "continue" })

				expect(ended.history).toBe("kept")

				return bytes
			}

			const first = await save("one")
			const second = await save("two")

			// The second revision follows the first save's bytes, which follow the signed file's.
			expect(first.subarray(0, source.length)).toEqual(source)
			expect(second.subarray(0, first.length)).toEqual(first)
			expect(await pdfjsFieldValues(second)).toMatchObject({ [(await textField(engine.client)).field]: "two" })

			const check = startEngine(second)

			await check.open()

			const task = pdfjs.getDocument({ data: second.slice(), verbosity: 0 })
			const fields = pdfSignatureFields(await (await task.promise).getSignatures())

			await task.destroy()

			const report = await check.client.call("verifySignatures", { fields })

			expect(report.signatures.map(signature => [signature.state, signature.changes?.allowed])).toEqual([["changed", true]])

			// Undo past both saves: the signed file with the steps before run again.
			await engine.client.call("undo", {})
			expect((await textField(engine.client)).value).toBe("one")
			await engine.client.call("undo", {})
			expect((await textField(engine.client)).value).toBe("")
		},
		TIMEOUT
	)
})
