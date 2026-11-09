import { createHash } from "node:crypto"
import { unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { buildDocxModel, openDocxPackage, type DocxPackage } from "@filen/office/core/docx"
import {
	commandAllowed,
	documentProtectionOf,
	DocxEditorSession,
	formattingRestricted,
	NO_PROTECTION,
	openDocxEditContext,
	protectionOf,
	readProtectionHash,
	setDocumentProtection,
	type DocxEditContext,
	type DocxProtectionSetting
} from "@filen/office/core/docx/edit"
import { saveDocx } from "@filen/office/core/docx/write"
import { hashDocumentProtectionPassword, verifyProtectionPassword } from "@filen/office/dom"
import { permissionRanges } from "../core/docx/edit/protection"
import { documentProtectionHashRead, type DocumentProtectionHash } from "../core/docx/protection/hash"
import { buildDocx, p } from "./docxSynthetic"

// Review > Restrict Editing > Start Enforcing Protection and Track Changes > Lock Tracking (ECMA-376 Part 1
// §17.15.1.29), set in the session with Word's own password hash, and Stop Protection in place.

const SPIN_TIMEOUT = 60_000

async function open(settings: string, body: string = p("Some text")): Promise<DocxPackage> {
	const opened = await openDocxPackage(bytesSource(buildDocx({ body, settings })))

	if (!opened.ok) throw new Error(opened.reason)

	return opened.package
}

async function editing(
	settings: string,
	body?: string
): Promise<{ pkg: DocxPackage; context: DocxEditContext; session: DocxEditorSession }> {
	const pkg = await open(settings, body)
	const context = await openDocxEditContext(pkg, await buildDocxModel(pkg), { author: "Ada" })

	return { pkg, context, session: new DocxEditorSession(context) }
}

async function saved(
	pkg: DocxPackage,
	context: DocxEditContext,
	session: DocxEditorSession
): Promise<{ settings: string; pkg: DocxPackage }> {
	const bytes = (await saveDocx({ pkg, context, sessions: [session] })).bytes as Uint8Array
	const reopened = await openDocxPackage(bytesSource(bytes))

	if (!reopened.ok) throw new Error(reopened.reason)

	return { settings: new TextDecoder().decode(unzipSync(bytes)["word/settings.xml"]), pkg: reopened.package }
}

// A stand-in hash (the spin is tested on its own below).
const HASH: DocumentProtectionHash = {
	algorithm: "SHA-512",
	hash: Buffer.alloc(64, 7).toString("base64"),
	salt: Buffer.alloc(16, 1).toString("base64"),
	spinCount: 100_000
}

describe("hashDocumentProtectionPassword", () => {
	it(
		"hashes the password's legacy verifier with SHA-512 as Word 2013 and later do, and the hash reads back",
		async () => {
			const written = await hashDocumentProtectionPassword("Example")

			expect(written).toMatchObject({ algorithm: "SHA-512", spinCount: 100_000 })
			expect(Buffer.from(written.salt, "base64")).toHaveLength(16)

			// Independently ([MS-OFFCRYPTO] §2.4.2.4): "Example"'s verifier is 0x64CEED7E, hashed as "7EEDCE64".
			let h = createHash("sha512")
				.update(Buffer.concat([Buffer.from(written.salt, "base64"), Buffer.from("7EEDCE64", "utf16le")]))
				.digest()
			const iterator = Buffer.alloc(4)

			for (let i = 0; i < 100_000; i++) {
				iterator.writeUInt32LE(i)
				h = createHash("sha512")
					.update(Buffer.concat([h, iterator]))
					.digest()
			}

			expect(written.hash).toBe(h.toString("base64"))
			expect(await verifyProtectionPassword(documentProtectionHashRead(written), "Example")).toBe("correct")
			expect(await verifyProtectionPassword(documentProtectionHashRead(written), "example")).toBe("wrong")

			// Saved, the file asks for the same password.
			const { pkg, context, session } = await editing("")

			setDocumentProtection(context, [session], { edit: "readOnly", formatting: false, password: written })

			const read = readProtectionHash((await saved(pkg, context, session)).pkg.settings, "documentProtection")

			if (read === undefined || read === "unsupported") throw new Error(String(read))

			expect(read).toMatchObject({ algorithm: "SHA-512", input: "legacy" })
			expect(await verifyProtectionPassword(read, "Example")).toBe("correct")
		},
		SPIN_TIMEOUT
	)
})

describe("starting document protection in the session", () => {
	it("limits editing at once, makes the document dirty, and saves the element as Word writes it", async () => {
		const { pkg, context, session } = await editing("")

		expect(session.snapshot().dirty).toBe(false)
		expect(documentProtectionOf(context)).toBeUndefined()

		setDocumentProtection(context, [session], { edit: "forms", formatting: true, password: HASH })

		expect(protectionOf(context).mode).toBe("forms")
		expect(protectionOf(context).hashed).toBe(true)
		expect(formattingRestricted(context)).toBe(true)
		expect(commandAllowed(session, "format.bold")).toBe(false)
		expect(session.dispatch(session.state.tr.insertText("New ", 1))).toBe(false)
		expect(session.snapshot().dirty).toBe(true)
		expect(session.snapshot().enabled["format.bold"]).toBe(false)
		expect(documentProtectionOf(context)).toEqual({ edit: "forms", formatting: true, password: documentProtectionHashRead(HASH) })

		const out = await saved(pkg, context, session)

		expect(out.settings).toContain(
			`<w:documentProtection w:edit="forms" w:formatting="1" w:enforcement="1" w:cryptProviderType="rsaAES" w:cryptAlgorithmClass="hash" w:cryptAlgorithmType="typeAny" w:cryptAlgorithmSid="14" w:cryptSpinCount="100000" w:hash="${HASH.hash}" w:salt="${HASH.salt}"/>`
		)
		expect(out.pkg.facts.documentProtection).toMatchObject({ edit: "forms", enforced: true, formatting: true, hashed: true })

		session.markSaved()

		expect(session.snapshot().dirty).toBe(false)
	})

	it("writes no hash without a password, and replaces the file's own element", async () => {
		const { pkg, context, session } = await editing(
			'<w:documentProtection w:edit="comments" w:enforcement="0" w:hash="aGFzaA==" w:salt="c2FsdA=="/>'
		)

		setDocumentProtection(context, [session], { edit: "comments", formatting: false })

		expect(documentProtectionOf(context)).toEqual({ edit: "comments", formatting: false, password: undefined })

		const out = await saved(pkg, context, session)

		expect(out.settings).toContain('<w:documentProtection w:edit="comments" w:enforcement="1"/>')
		expect(out.settings.match(/documentProtection/g)).toHaveLength(1)
	})

	it("makes the whole document read-only but its open ranges", async () => {
		const { context, session } = await editing(
			"",
			`${p("Locked")}<w:p><w:permStart w:id="1" w:edGrp="everyone"/><w:r><w:t>Open</w:t></w:r><w:permEnd w:id="1"/></w:p>`
		)

		setDocumentProtection(context, [session], { edit: "readOnly", formatting: false })

		expect(protectionOf(context).mode).toBe("readOnly")
		expect(session.dispatch(session.state.tr.insertText("x", 2))).toBe(false)

		let open = -1

		session.state.doc.descendants((node, pos) => {
			if (node.isText && node.text === "Open") open = pos
		})

		expect(session.dispatch(session.state.tr.insertText("x", open + 1))).toBe(true)
	})

	it("locks tracking: tracking turns on and cannot be turned off or decided, and the save records both", async () => {
		const { pkg, context, session } = await editing("")

		expect(context.review.tracking).toBe(false)

		setDocumentProtection(context, [session], { edit: "trackedChanges", formatting: false, password: HASH })

		expect(context.review.tracking).toBe(true)
		expect(protectionOf(context).forcesTracking).toBe(true)
		expect(commandAllowed(session, "review.track")).toBe(false)
		expect(commandAllowed(session, "review.acceptAll")).toBe(false)
		expect(session.dispatch(session.state.tr.insertText("New ", 1))).toBe(true)

		const out = await saved(pkg, context, session)

		expect(out.settings).toContain("<w:trackRevisions/>")
		expect(out.settings).toContain('<w:documentProtection w:edit="trackedChanges" w:enforcement="1" w:cryptProviderType="rsaAES"')
	})
})

describe("stopping document protection in place", () => {
	it("lifts the file's limited protection and saves it switched off", async () => {
		const { pkg, context, session } = await editing('<w:documentProtection w:edit="comments" w:formatting="1" w:enforcement="1"/>')

		expect(protectionOf(context).mode).toBe("comments")
		expect(session.dispatch(session.state.tr.insertText("New ", 1))).toBe(false)

		setDocumentProtection(context, [session], undefined)

		expect(protectionOf(context)).toBe(NO_PROTECTION)
		expect(formattingRestricted(context)).toBe(false)
		expect(documentProtectionOf(context)).toBeUndefined()
		expect(session.snapshot().dirty).toBe(true)
		expect(session.dispatch(session.state.tr.insertText("New ", 1))).toBe(true)
		expect((await saved(pkg, context, session)).settings).toContain(
			'<w:documentProtection w:edit="comments" w:formatting="1" w:enforcement="0"/>'
		)
	})

	it("leaves an unprotected file as it was when protection set in the session stops", async () => {
		const { pkg, context, session } = await editing("")

		setDocumentProtection(context, [session], { edit: "comments", formatting: false })
		setDocumentProtection(context, [session], undefined)

		expect(context.protectionChange).toBeUndefined()
		expect(session.snapshot().dirty).toBe(false)
		expect((await saved(pkg, context, session)).settings).not.toContain("documentProtection")
	})

	it("makes the open ranges again when the protection changes to or from forms", async () => {
		const { context, session } = await editing("")
		const setting: DocxProtectionSetting = { edit: "comments", formatting: false }

		setDocumentProtection(context, [session], setting)

		expect(permissionRanges(session).forms).toBe(false)

		setDocumentProtection(context, [session], { edit: "forms", formatting: false })

		expect(permissionRanges(session).forms).toBe(true)
	})
})
