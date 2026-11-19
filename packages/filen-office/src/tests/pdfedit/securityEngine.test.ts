import { MessageChannel } from "node:worker_threads"
import * as mupdf from "mupdf"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
import { afterEach, describe, expect, it } from "vitest"
import { PDF_DESKTOP_MEMORY } from "../../core/pdfedit/budget"
import {
	composeWriteOptions,
	heldAfterSave,
	PDF_ALLOW_NONE,
	PDF_AUTH_OWNER,
	PDF_AUTH_USER,
	permissionsValue,
	type PdfHeldAccess,
	type PdfSecurityChoice
} from "../../core/pdfedit/security"
import { describeSecurity, heldAccessAtOpen, planDocumentSecurity, readEncryptFields, unlockOwner } from "../../dom/pdfedit/security"
import { buildPdfCms, type PdfSigningIdentity } from "../../core/pdfsign"
import { cmsCapacity } from "../../core/pdfsign/cmsBuild"
import type { PdfSignPort } from "../../dom/pdfedit/protocol"
import { makePdf } from "./fixtures"
import { startEngine, stopEngines, upload } from "./harness"
import { loadIdentity, signingSubtle, verifySigned } from "../pdfSignCreateFixtures"
import { budget } from "../timing"

// The security block against real MuPDF: each Protect choice saved as the editor saves (full rewrite, garbage=compact),
// then reopened in MuPDF and in pdf.js. RC4 inputs are made here with MuPDF's own writer.

const BASE = "garbage=compact,compress"
const NASTY = ["pässwörd", "密码", 'a,b=c"d\\e}{', "ﬁx", 'x","encrypt":"none', ",encrypt=none,owner-password=", "🔑 key ✓", '\\"}{,=']

function open(bytes: Uint8Array): mupdf.PDFDocument {
	const document = mupdf.Document.openDocument(bytes, "application/pdf").asPDF()

	if (document === null) throw new Error("not a PDF")

	return document
}

function held(document: mupdf.PDFDocument, password: string | null): PdfHeldAccess {
	const access = heldAccessAtOpen(document, password)

	if (access === null) throw new Error("the password unlocks nothing")

	return access
}

function text(document: mupdf.PDFDocument): string {
	return document.loadPage(0).toStructuredText("").asText().trim()
}

// Saves `source` (opened with `password`) under `choice`, as the save pipeline would.
function save(source: Uint8Array, password: string | null, choice: PdfSecurityChoice, unlock?: string): Uint8Array {
	const document = open(source)
	let access = held(document, password)

	if (unlock !== undefined) access = unlockOwner(document, unlock, access) ?? access

	const plan = planDocumentSecurity(document, access, choice)

	if (!plan.ok) throw new Error(plan.reason)

	const bytes = document.saveToBuffer(composeWriteOptions(BASE, plan.options)).asUint8Array().slice()

	document.destroy()

	return bytes
}

function rc4(userPassword: string, ownerPassword: string, permissions: number): Uint8Array {
	const document = open(makePdf({ pages: 1 }))
	const bytes = document
		.saveToBuffer({ encrypt: "rc4-128", "user-password": userPassword, "owner-password": ownerPassword, permissions })
		.asUint8Array()
		.slice()

	document.destroy()

	return bytes
}

// pdf.js's verdict on a password: the first page's text, or "password" when it is refused.
async function pdfjsText(bytes: Uint8Array, password?: string): Promise<string> {
	const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0, ...(password === undefined ? {} : { password }) })

	try {
		const document = await task.promise
		const content = await (await document.getPage(1)).getTextContent()

		return content.items.map(item => ("str" in item ? item.str : "")).join("")
	} catch (error) {
		if (error instanceof Error && error.name === "PasswordException") return "password"

		throw error
	} finally {
		await task.destroy()
	}
}

async function pdfjsPermissions(bytes: Uint8Array): Promise<number[] | null> {
	const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 })
	const permissions = await (await task.promise).getPermissions()

	await task.destroy()

	return permissions === null ? null : [...permissions].sort((a, b) => a - b)
}

describe("PDF security engine", () => {
	it.each(NASTY)("sets an AES-256 open password %j that MuPDF and pdf.js accept, and nothing else", async password => {
		const saved = save(makePdf({ pages: 1 }), null, { kind: "open", password })
		const reopened = open(saved)

		expect(readEncryptFields(reopened)).toMatchObject({ v: 5, r: 6, cfm: "AESV3" })
		expect(heldAccessAtOpen(reopened, "wrong")).toBeNull()

		const access = held(reopened, password)

		expect(access.openPassword).toBe(true)
		expect(text(reopened)).toBe("Page 1")
		expect(describeSecurity(reopened, access)).toMatchObject({
			method: "aes-256",
			openPassword: true,
			restricted: false,
			ownerAccess: true
		})
		reopened.destroy()

		expect(await pdfjsText(saved, password)).toBe("Page 1")
		expect(await pdfjsText(saved)).toBe("password")
		expect(await pdfjsText(saved, "wrong")).toBe("password")
	})

	it("restricts without an open password: opens freely, denied until the owner password unlocks", async () => {
		const saved = save(makePdf({ pages: 1 }), null, {
			kind: "restrict",
			ownerPassword: "密码",
			openPassword: null,
			allowed: { print: true, copy: false, change: false }
		})
		const document = open(saved)
		const access = held(document, null)
		const before = describeSecurity(document, access)

		expect(before).toMatchObject({
			openPassword: false,
			restricted: true,
			ownerAccess: false,
			allowed: { print: true, copy: false, change: false }
		})
		expect(before.granted).toMatchObject({
			print: true,
			printHq: true,
			copy: false,
			edit: false,
			annotate: false,
			form: false,
			assemble: false
		})
		expect(planDocumentSecurity(document, access, { kind: "remove" })).toEqual({ ok: false, reason: "ownerRequired" })

		// A wrong owner password leaves the document readable, as it was.
		expect(unlockOwner(document, "nope", access)).toBeNull()
		expect(text(document)).toBe("Page 1")
		expect(describeSecurity(document, access).granted.edit).toBe(false)

		const owner = unlockOwner(document, "密码", access)

		expect(owner).not.toBeNull()

		if (owner === null) return

		expect(describeSecurity(document, owner)).toMatchObject({ ownerAccess: true, granted: { edit: true, copy: true } })
		document.destroy()

		expect(await pdfjsText(saved)).toBe("Page 1")
		expect(await pdfjsPermissions(saved)).toEqual([
			pdfjs.PermissionFlag.PRINT,
			pdfjs.PermissionFlag.COPY_FOR_ACCESSIBILITY,
			pdfjs.PermissionFlag.PRINT_HIGH_QUALITY
		])
	})

	it("restricts with an open password; the open password does not lift the restrictions", async () => {
		const saved = save(makePdf({ pages: 1 }), null, {
			kind: "restrict",
			ownerPassword: "owner",
			openPassword: "pässwörd",
			allowed: PDF_ALLOW_NONE
		})
		const document = open(saved)
		const access = held(document, "pässwörd")

		expect(describeSecurity(document, access)).toMatchObject({
			openPassword: true,
			ownerAccess: false,
			granted: { print: false, edit: false }
		})
		expect(text(document)).toBe("Page 1")

		// The open password typed into the owner prompt is no owner password; access stays.
		expect(unlockOwner(document, "pässwörd", access)).toBeNull()
		expect(text(document)).toBe("Page 1")
		document.destroy()

		expect(await pdfjsText(saved, "pässwörd")).toBe("Page 1")
		expect(await pdfjsText(saved)).toBe("password")
	})

	it("gives the session's document the saved encryption, with owner rights", () => {
		const document = open(makePdf({ pages: 1 }))
		const before = held(document, null)
		const plan = planDocumentSecurity(document, before, {
			kind: "restrict",
			ownerPassword: "owner",
			openPassword: "open",
			allowed: PDF_ALLOW_NONE
		})

		if (!plan.ok) throw new Error(plan.reason)

		document.saveToBuffer(composeWriteOptions(BASE, plan.options))

		const after = heldAfterSave(plan.options, before)

		expect(after).toEqual({ password: "owner", bits: PDF_AUTH_OWNER, openPassword: true })
		expect(describeSecurity(document, after)).toMatchObject({
			method: "aes-256",
			restricted: true,
			ownerAccess: true,
			granted: { edit: true }
		})

		// A later plain save keeps the new encryption.
		const kept = open(
			document
				.saveToBuffer(composeWriteOptions(BASE, { encrypt: "keep" }))
				.asUint8Array()
				.slice()
		)

		expect(kept.authenticatePassword("open")).toBe(PDF_AUTH_USER)
		expect(kept.authenticatePassword("owner")).toBe(PDF_AUTH_OWNER)
		kept.destroy()
		document.destroy()
	})

	it("removes encryption only with owner access", async () => {
		const source = save(makePdf({ pages: 1 }), null, {
			kind: "restrict",
			ownerPassword: "owner",
			openPassword: "open",
			allowed: PDF_ALLOW_NONE
		})

		expect(() => save(source, "open", { kind: "remove" })).toThrow("ownerRequired")

		const removed = save(source, "open", { kind: "remove" }, "owner")
		const document = open(removed)

		expect(readEncryptFields(document)).toBeNull()
		expect(describeSecurity(document, held(document, null))).toMatchObject({ method: "none", restricted: false, ownerAccess: true })
		document.destroy()
		expect(await pdfjsText(removed)).toBe("Page 1")
	})

	it("keeps RC4 on a plain save", async () => {
		const source = rc4("pässwörd", "owner", permissionsValue(PDF_ALLOW_NONE))
		const kept = save(source, "pässwörd", { kind: "keep" })
		const document = open(kept)
		const access = held(document, "pässwörd")

		expect(describeSecurity(document, access)).toMatchObject({
			method: "rc4-128",
			rc4: true,
			openPassword: true,
			restricted: true,
			upgrade: "ownerRequired"
		})
		document.destroy()
		expect(await pdfjsText(kept, "pässwörd")).toBe("Page 1")
		expect(await pdfjsText(kept)).toBe("password")
	})

	it("upgrades RC4 to AES-256 with the same password and permissions", async () => {
		const restricted = permissionsValue({ print: true, copy: false, change: false })
		const source = rc4("", "owner", restricted)
		const upgraded = save(source, null, { kind: "upgrade" }, "owner")
		const document = open(upgraded)

		expect(readEncryptFields(document)).toMatchObject({ v: 5, r: 6, cfm: "AESV3" })

		const access = held(document, null)

		expect(describeSecurity(document, access)).toMatchObject({
			method: "aes-256",
			openPassword: false,
			permissions: restricted,
			ownerAccess: false
		})
		expect(unlockOwner(document, "owner", access)).not.toBeNull()
		document.destroy()

		const open2 = save(rc4("u", "u", -4), "u", { kind: "upgrade" })
		const reopened = open(open2)

		expect(describeSecurity(reopened, held(reopened, "u"))).toMatchObject({ method: "aes-256", openPassword: true })
		reopened.destroy()
		expect(await pdfjsText(upgraded)).toBe("Page 1")
		expect(await pdfjsText(open2, "u")).toBe("Page 1")
		expect(await pdfjsText(open2)).toBe("password")
	})

	it("refuses the upgrade where a password cannot be carried over", () => {
		const source = rc4("open", "owner", -4)
		const document = open(source)
		const owner = unlockOwner(document, "owner", held(document, "open"))

		expect(owner).not.toBeNull()

		if (owner === null) return

		expect(describeSecurity(document, owner).upgrade).toBe("openPasswordUnknown")
		document.destroy()
	})

	it("authenticates a password typed in a form SASLprep maps elsewhere", () => {
		const saved = save(makePdf({ pages: 1 }), null, { kind: "open", password: "ﬁx" })
		const document = open(saved)

		expect(held(document, "ﬁx")).toMatchObject({ password: "fix", openPassword: true })
		document.destroy()
	})
})

// Answers the engine's digests with the CMS, as the page relays them to the signer worker.
function signerPort(identity: PdfSigningIdentity): PdfSignPort {
	const channel = new MessageChannel()

	channel.port2.on("message", (message: { digest: Uint8Array }) => {
		void buildPdfCms(identity, message.digest, signingSubtle).then(
			cms => {
				channel.port2.postMessage({ cms })
			},
			(error: unknown) => {
				channel.port2.postMessage({ error: String(error) })
			}
		)
	})

	return channel.port1 as unknown as PdfSignPort
}

describe("a password SASLprep changes, in the engine", () => {
	afterEach(stopEngines)

	const TIMEOUT = budget(60_000)
	// AES-256 compares the SASLprep'd password: the file holds "fix", the user types the ligature.
	const TYPED = "\uFB01x"
	const PREPARED = "fix"
	const shape = { command: "annotations.shape", args: { page: 0, author: "Ann", kind: "Square", rect: [300, 300, 400, 400] } } as const

	it(
		"reopens a plain save in place and encrypts an extract with the form that unlocked the file",
		async () => {
			const bytes = makePdf({ pages: 2, userPassword: PREPARED, ownerPassword: "owner" })
			const engine = startEngine(bytes)

			expect(await engine.open(TYPED)).toMatchObject({ status: "open", access: "user" })

			await engine.client.call("dispatch", shape)

			const begun = await engine.client.call("saveBegin", {
				inputBytes: bytes.length,
				memory: PDF_DESKTOP_MEMORY,
				invalidateConfirmed: false
			})

			expect(begun.status).toBe("written")
			expect((await upload(engine.client)).uploaded).toBe(true)
			expect((await engine.client.call("saveEnd", { outcome: "saved", next: "adopt" })).history).toBe("reset")

			const extract = await engine.client.call("extractBegin", {
				pages: [0],
				protect: true,
				inputBytes: bytes.length,
				memory: PDF_DESKTOP_MEMORY
			})

			expect(extract.status).toBe("written")

			const extracted = await upload(engine.client)

			await engine.client.call("saveEnd", { outcome: "copied", next: "continue" })

			const copy = open(extracted.bytes)

			expect(copy.needsPassword()).toBe(true)
			expect(copy.authenticatePassword(PREPARED)).not.toBe(0)
			copy.destroy()
		},
		TIMEOUT
	)

	it(
		"signs on a rewrite of unsaved changes and verifies the signed file's revisions",
		async () => {
			const identity = await loadIdentity("rsa2048")
			const bytes = makePdf({ pages: 1, userPassword: PREPARED, ownerPassword: "owner" })
			const engine = startEngine(bytes)

			expect(await engine.open(TYPED)).toMatchObject({ status: "open" })

			await engine.client.call("dispatch", shape)
			await engine.client.call("dispatch", {
				command: "sign.addField",
				args: {
					placement: { kind: "rect", page: 0, rect: [320, 100, 520, 160] },
					visual: null,
					lines: ["Signed by Fixture"],
					name: "Fixture Signer",
					reason: "Approval",
					location: null,
					time: Date.UTC(2026, 10, 14, 12),
					certify: null,
					capacity: cmsCapacity(identity)
				}
			})

			const signer = signerPort(identity)
			const begun = await engine.client.call(
				"signBegin",
				{ inputBytes: bytes.length, memory: PDF_DESKTOP_MEMORY, digest: identity.scheme.digest, signer },
				[signer]
			)

			expect(begun.status).toBe("written")

			const signed = (await upload(engine.client)).bytes

			expect((await verifySigned(signed, PREPARED)).signatures.map(signature => signature.state)).toEqual(["unchanged"])
			expect((await engine.client.call("saveEnd", { outcome: "saved", next: "adopt" })).history).toBe("reset")

			const fields = await engine.client.call("signatureHints", {})

			expect((await engine.client.call("verifySignatures", { fields })).signatures.map(signature => signature.state)).toEqual([
				"unchanged"
			])
		},
		TIMEOUT
	)
})
