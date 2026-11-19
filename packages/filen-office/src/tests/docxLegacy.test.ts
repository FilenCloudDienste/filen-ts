import { describe, expect, it, vi } from "vitest"
import { bytesSource, OpcPackage } from "@filen/office/core/opc"
import { buildDocxModel, openDocxPackage } from "@filen/office/core/docx"
import { decodeUtf8 } from "@filen/office/core/xml"
import {
	DocxEditorSession,
	docxSchema,
	openDocxEditContext,
	parseDocxEditorCommand,
	setDocumentProtection
} from "@filen/office/core/docx/edit"
import { TextSelection } from "prosemirror-state"
import { legacyPasswordVerifier, readProtectionHash } from "../core/docx/protection/hash"
import { verifyProtectionPassword } from "../dom/protection"
import type { DocxEvent } from "@filen/office/dom/docx"
import type { DocxConvertedDocument, DocxLegacyOpen } from "../dom/docx/legacy"
import { buildDoc, prl } from "./docFixtures"
import { buildDocx, p } from "./docxSynthetic"
import { encryptedDoc } from "./docDecryptFixtures"
import { workerHarness } from "./docxEncryptedFixtures"

// Word binary documents through the docx worker, as the web opens them: the worker reads the file once and holds the
// package it converted it to; the viewer's engine reads the worker's copy; Save as takes a copy to the page.

function events(host: (listener: (event: DocxEvent) => void) => { close(): void }): Promise<DocxEvent[]> {
	return new Promise(resolve => {
		const seen: DocxEvent[] = []
		const session = host(event => {
			seen.push(event)

			if (event.type === "error" || (event.type === "pages" && event.final)) {
				session.close()
				resolve(seen)
			}
		})
	})
}

function converted(opened: DocxLegacyOpen): DocxConvertedDocument {
	if (opened.kind !== "converted") throw new Error(`not converted: ${opened.kind}`)

	return opened.document
}

describe("Word binary documents in the docx worker", () => {
	it("converts once, lays the package out from the worker, and hands Save as a copy", { timeout: 30_000 }, async () => {
		const harness = workerHarness()

		try {
			const file = await buildDoc({
				pieces: [{ text: "From Word 97\r" }],
				runs: [{ start: 5, end: 9, grpprl: prl.toggle(0x0835, 1) }]
			})
			let reads = 0
			const source = bytesSource(file)
			const counted = {
				size: source.size,
				read: (offset: number, length: number) => {
					reads++

					return source.read(offset, length)
				}
			}
			const document = converted(await harness.pool.legacy.open(counted))
			const readsAfterConversion = reads

			expect(document.notConverted).toEqual([])
			await expect(document.bytes.read(0, 4)).rejects.toThrow()

			const laidOut = await events(listener => document.host(document.bytes, listener, {}))

			expect(laidOut.some(event => event.type === "opened")).toBe(true)
			expect(laidOut.some(event => event.type === "error")).toBe(false)
			// The engine read the held package, not the page's file.
			expect(reads).toBe(readsAfterConversion)

			const copy = await document.take()
			const opened = await openDocxPackage(bytesSource(copy))

			expect(opened.ok).toBe(true)
			expect(copy.length).toBe(document.bytes.size)

			document.release()
			await expect(document.take()).rejects.toThrow()
		} finally {
			harness.dispose()
		}
	})

	it("hashes an editing-restriction password only when Save as takes a copy", { timeout: 30_000 }, async () => {
		const harness = workerHarness()
		const dop = new Uint8Array(88)

		// fProtEnabled (bit 25 of the flags at 4); lKeyProtDoc at 78.
		new DataView(dop.buffer).setUint32(4, 1 << 25, true)
		new DataView(dop.buffer).setUint32(78, legacyPasswordVerifier(Uint8Array.from("Example", c => c.charCodeAt(0))), true)

		const digest = vi.spyOn(globalThis.crypto.subtle, "digest")

		try {
			const file = await buildDoc({ pieces: [{ text: "form\r" }], structures: { dop } })
			const document = converted(await harness.pool.legacy.open(bytesSource(file)))
			const laidOut = await events(listener => document.host(document.bytes, listener, {}))

			// Opening it, and laying it out, spins nothing; the password is not reported lost.
			expect(laidOut.some(event => event.type === "error")).toBe(false)
			expect(digest).not.toHaveBeenCalled()
			expect(document.notConverted).toEqual([])

			const copy = await document.take()
			const settings = decodeUtf8(await (await OpcPackage.open(bytesSource(copy))).read("word/settings.xml"))

			expect(digest.mock.calls.length).toBeGreaterThan(100_000)
			expect(settings).toMatch(/<w:documentProtection w:edit="forms" w:enforcement="1" w:cryptProviderType="rsaFull"/u)

			const opened = await openDocxPackage(bytesSource(copy))

			if (!opened.ok) throw new Error("the copy does not open")

			const hash = readProtectionHash(opened.package.settings, "documentProtection")

			if (hash === undefined || hash === "unsupported") throw new Error("no hash read back")

			digest.mockRestore()
			expect(await verifyProtectionPassword(hash, "Example")).toBe("correct")
			expect(await verifyProtectionPassword(hash, "example")).toBe("wrong")
			document.release()
		} finally {
			digest.mockRestore()
			harness.dispose()
		}
	})

	it("refuses a file it cannot convert with the reader's reason", { timeout: 30_000 }, async () => {
		const harness = workerHarness()

		try {
			const legacy = await buildDoc({ pieces: [{ text: "old\r" }], nFib: 0x65, wIdent: 0xa5dc })
			const encrypted = (await encryptedDoc({ pieces: [{ text: "x\r" }] }, { scheme: "cryptoApiRc4", password: "pw" })).bytes

			expect(await harness.pool.legacy.open(bytesSource(legacy))).toEqual({
				kind: "refused",
				refusal: { reason: "legacyVersion", nFib: 0x65 }
			})
			expect(await harness.pool.legacy.open(bytesSource(encrypted))).toEqual({
				kind: "refused",
				refusal: { reason: "encrypted", encryption: "cryptoApiRc4" }
			})
			expect(await harness.pool.legacy.open(bytesSource(new Uint8Array(32)))).toEqual({
				kind: "refused",
				refusal: { reason: "notWordBinary" }
			})
		} finally {
			harness.dispose()
		}
	})

	it("stops when aborted", async () => {
		const harness = workerHarness()

		try {
			const controller = new AbortController()

			controller.abort()

			expect(
				await harness.pool.legacy.open(bytesSource(await buildDoc({ pieces: [{ text: "x\r" }] })), { signal: controller.signal })
			).toEqual({
				kind: "aborted"
			})
		} finally {
			harness.dispose()
		}
	})
})

// Legacy form fields (w:ffData) in an editor session.
const TEXT_FIELD = (input: string): string =>
	'<w:p><w:r><w:fldChar w:fldCharType="begin"><w:ffData><w:name w:val="Text1"/><w:enabled/><w:calcOnExit w:val="0"/>' +
	`<w:textInput>${input}</w:textInput></w:ffData></w:fldChar></w:r><w:r><w:instrText xml:space="preserve"> FORMTEXT </w:instrText></w:r>` +
	'<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>12</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'

async function fieldSession(input: string) {
	const opened = await openDocxPackage(bytesSource(buildDocx({ body: p("x") + TEXT_FIELD(input) })))

	if (!opened.ok) throw new Error(opened.reason)

	const context = await openDocxEditContext(opened.package, await buildDocxModel(opened.package), {})
	const session = new DocxEditorSession(context)
	let pos = -1

	session.state.doc.descendants((node, at) => {
		if (node.type === docxSchema.nodes.field) pos = at
	})
	session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, pos)))

	return { context, session }
}

function fieldResult(session: DocxEditorSession): string {
	let shown = ""

	session.state.doc.descendants(node => {
		if (node.type === docxSchema.nodes.field) shown = String(node.attrs["result"])
	})

	return shown
}

function typeInto(session: DocxEditorSession, text: string): boolean {
	const command = parseDocxEditorCommand({ type: "control.text", text })

	if (command === undefined) throw new Error("invalid command")

	return session.execute(command)
}

describe("legacy form fields", () => {
	it("follows document protection in the field's context, keeping its identity while nothing changes", async () => {
		const { context, session } = await fieldSession("")
		const before = session.snapshot().context.control

		expect(before?.kind).toBe("field")
		expect(session.snapshot().context.control).toBe(before)

		setDocumentProtection(context, [session], { edit: "forms", formatting: false })

		const protectedControl = session.snapshot().context.control

		expect(protectedControl?.protection).not.toBe(before?.protection)
		expect(session.snapshot().context.control).toBe(protectedControl)

		setDocumentProtection(context, [session], undefined)

		expect(session.snapshot().context.control?.protection).toBe(before?.protection)
	})

	it("formats a number with more than 100 decimal places", async () => {
		const { session } = await fieldSession(`<w:type w:val="number"/><w:format w:val="0.${"0".repeat(150)}"/>`)

		expect(typeInto(session, "1.5")).toBe(true)
		expect(fieldResult(session)).toBe(`1.5${"0".repeat(149)}`)

		for (const [decimals, expected] of [
			[0, "2"],
			[2, "1.50"],
			[100, `1.5${"0".repeat(99)}`]
		] as const) {
			const field = await fieldSession(
				`<w:type w:val="number"/><w:format w:val="0${decimals === 0 ? "" : `.${"0".repeat(decimals)}`}"/>`
			)

			expect(typeInto(field.session, "1.5")).toBe(true)
			expect(fieldResult(field.session)).toBe(expected)
		}
	})
})
