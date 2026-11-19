import { MessageChannel } from "node:worker_threads"
import * as mupdf from "mupdf"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
import { afterEach, describe, expect, it } from "vitest"
import { PDF_DESKTOP_MEMORY } from "../../core/pdfedit/budget"
import {
	PDF_AES256_METHOD,
	PDF_ALLOW_NONE,
	PDF_AUTH_OWNER,
	PDF_AUTH_USER,
	permissionsValue,
	type PdfSecurityChoice
} from "../../core/pdfedit/security"
import type { PdfEditState } from "../../core/pdfedit/state"
import { buildPdfCms, type PdfSigningIdentity } from "../../core/pdfsign"
import { cmsCapacity } from "../../core/pdfsign/cmsBuild"
import type { PdfEngineClient } from "../../dom/pdfedit/client"
import type { PdfOpenResult, PdfSignPort } from "../../dom/pdfedit/protocol"
import { makePdf } from "./fixtures"
import { startEngine, stopEngines, upload } from "./harness"
import { loadIdentity, signingSubtle, verifySigned } from "../pdfSignCreateFixtures"
import { budget } from "../timing"

// The security block through the engine's requests, as the editor drives it: a file opened (the held access the
// session starts with), owner rights unlocked, each Protect choice saved (a full rewrite) and the saved file opened
// again in a new engine, in MuPDF and in pdf.js. RC4 inputs are made here with MuPDF's own writer.

afterEach(stopEngines)

const TIMEOUT = budget(60_000)
const NASTY = ["pässwörd", "密码", 'a,b=c"d\\e}{', "ﬁx", 'x","encrypt":"none', ",encrypt=none,owner-password=", "🔑 key ✓", '\\"}{,=']

interface Session {
	readonly client: PdfEngineClient
	readonly opened: PdfOpenResult
	readonly state: PdfEditState | null
}

// `bytes` opened for editing with `password`, and the session's snapshot when it opened.
async function session(bytes: Uint8Array, password?: string): Promise<Session> {
	const engine = startEngine(bytes)
	const opened = await engine.open(password)

	return { client: engine.client, opened, state: opened.status === "open" ? await engine.client.call("state", {}) : null }
}

function snapshot(opened: Session): PdfEditState {
	if (opened.state === null) throw new Error("the password unlocks nothing")

	return opened.state
}

async function pageText(client: PdfEngineClient): Promise<string> {
	return (await client.call("text", { page: 0 })).lines.map(line => line.str).join("")
}

// Saves `source` (opened with `password`, owner rights unlocked with `unlock`) under `choice`, as the editor saves.
async function save(source: Uint8Array, password: string | undefined, choice: PdfSecurityChoice, unlock?: string): Promise<Uint8Array> {
	const { client } = await session(source, password)

	if (unlock !== undefined) expect(await client.call("securityUnlock", { password: unlock })).toMatchObject({ ok: true })

	const chosen = await client.call("securitySet", { choice })

	if (!chosen.ok) throw new Error(chosen.reason)

	const begun = await client.call("saveBegin", { inputBytes: source.length, memory: PDF_DESKTOP_MEMORY, invalidateConfirmed: false })

	if (begun.status !== "written") throw new Error(begun.reason)

	return (await upload(client)).bytes
}

function rc4(userPassword: string, ownerPassword: string, permissions: number): Uint8Array {
	const document = new mupdf.PDFDocument(makePdf({ pages: 1 }))
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
	it.each(NASTY)(
		"sets an AES-256 open password %j that MuPDF and pdf.js accept, and nothing else",
		async password => {
			const saved = await save(makePdf({ pages: 1 }), undefined, { kind: "open", password })
			const { client, opened } = await session(saved, "wrong")

			expect(opened).toEqual({ status: "password" })

			const unlocked = await client.call("authenticate", { password })

			expect(unlocked).toMatchObject({ status: "open", access: "owner", document: { encryption: PDF_AES256_METHOD } })
			expect(await pageText(client)).toBe("Page 1")
			expect((await client.call("state", {})).security).toMatchObject({
				method: "aes-256",
				openPassword: true,
				restricted: false,
				ownerAccess: true
			})

			expect(await pdfjsText(saved, password)).toBe("Page 1")
			expect(await pdfjsText(saved)).toBe("password")
			expect(await pdfjsText(saved, "wrong")).toBe("password")
		},
		TIMEOUT
	)

	it(
		"restricts without an open password: opens freely, denied until the owner password unlocks",
		async () => {
			const saved = await save(makePdf({ pages: 1 }), undefined, {
				kind: "restrict",
				ownerPassword: "密码",
				openPassword: null,
				allowed: { print: true, copy: false, change: false }
			})
			const opened = await session(saved)
			const { client } = opened
			const before = snapshot(opened)

			expect(opened.opened).toMatchObject({ status: "open", access: "none" })
			expect(before.security).toMatchObject({
				openPassword: false,
				restricted: true,
				ownerAccess: false,
				allowed: { print: true, copy: false, change: false }
			})
			expect(before.restrictions).toEqual({ owner: false, print: true, edit: false, annotate: false, form: false, assemble: false })
			expect(await client.call("securitySet", { choice: { kind: "remove" } })).toEqual({ ok: false, reason: "ownerRequired" })

			// A wrong owner password leaves the document readable, as it was.
			expect(await client.call("securityUnlock", { password: "nope" })).toEqual({ ok: false })
			expect(await pageText(client)).toBe("Page 1")
			expect((await client.call("state", {})).restrictions.edit).toBe(false)
			expect(await client.call("securityUnlock", { password: "密码" })).toMatchObject({
				ok: true,
				state: { security: { ownerAccess: true }, restrictions: { owner: true } }
			})

			expect(await pdfjsText(saved)).toBe("Page 1")
			expect(await pdfjsPermissions(saved)).toEqual([
				pdfjs.PermissionFlag.PRINT,
				pdfjs.PermissionFlag.COPY_FOR_ACCESSIBILITY,
				pdfjs.PermissionFlag.PRINT_HIGH_QUALITY
			])
		},
		TIMEOUT
	)

	it(
		"takes the owner password at open on a file that opens without one, and a wrong one as no password",
		async () => {
			const saved = await save(makePdf({ pages: 1 }), undefined, {
				kind: "restrict",
				ownerPassword: "ﬁx",
				openPassword: null,
				allowed: PDF_ALLOW_NONE
			})
			const owner = await session(saved, "ﬁx")

			expect(owner.opened).toMatchObject({ status: "open", access: "owner" })
			expect(snapshot(owner)).toMatchObject({
				security: { openPassword: false, restricted: true, ownerAccess: true },
				restrictions: { owner: true }
			})
			expect(await owner.client.call("securitySet", { choice: { kind: "remove" } })).toMatchObject({ ok: true })

			// The failed attempt is undone: the file stays readable, restricted.
			const wrong = await session(saved, "nope")

			expect(wrong.opened).toMatchObject({ status: "open", access: "none" })
			expect(snapshot(wrong)).toMatchObject({ security: { ownerAccess: false }, restrictions: { owner: false } })
			expect(await pageText(wrong.client)).toBe("Page 1")
		},
		TIMEOUT
	)

	it(
		"restricts with an open password; the open password does not lift the restrictions",
		async () => {
			const saved = await save(makePdf({ pages: 1 }), undefined, {
				kind: "restrict",
				ownerPassword: "owner",
				openPassword: "pässwörd",
				allowed: PDF_ALLOW_NONE
			})
			const opened = await session(saved, "pässwörd")
			const { client } = opened

			expect(opened.opened).toMatchObject({ status: "open", access: "user" })
			expect(snapshot(opened)).toMatchObject({
				security: { openPassword: true, ownerAccess: false },
				restrictions: { owner: false, print: false, edit: false }
			})
			expect(await pageText(client)).toBe("Page 1")

			// The open password typed into the owner prompt is no owner password; access stays.
			expect(await client.call("securityUnlock", { password: "pässwörd" })).toEqual({ ok: false })
			expect(await pageText(client)).toBe("Page 1")

			expect(await pdfjsText(saved, "pässwörd")).toBe("Page 1")
			expect(await pdfjsText(saved)).toBe("password")
		},
		TIMEOUT
	)

	it(
		"gives the session's document the saved encryption, with owner rights",
		async () => {
			const source = makePdf({ pages: 1 })
			const { client } = await session(source)
			const choice = { kind: "restrict", ownerPassword: "owner", openPassword: "open", allowed: PDF_ALLOW_NONE } as const

			expect(await client.call("securitySet", { choice })).toMatchObject({ ok: true })

			const begun = await client.call("saveBegin", {
				inputBytes: source.length,
				memory: PDF_DESKTOP_MEMORY,
				invalidateConfirmed: false
			})

			expect(begun.status).toBe("written")
			expect((await upload(client)).uploaded).toBe(true)
			expect((await client.call("saveEnd", { outcome: "saved", next: "continue" })).state).toMatchObject({
				security: { method: "aes-256", restricted: true, ownerAccess: true, pending: null },
				restrictions: { owner: true }
			})

			// A later plain save keeps the new encryption.
			const again = await client.call("saveBegin", {
				inputBytes: source.length,
				memory: PDF_DESKTOP_MEMORY,
				invalidateConfirmed: false
			})

			expect(again).toMatchObject({ status: "written", protection: { kind: "keep" } })

			const kept = new mupdf.PDFDocument((await upload(client)).bytes)

			expect(kept.authenticatePassword("open")).toBe(PDF_AUTH_USER)
			expect(kept.authenticatePassword("owner")).toBe(PDF_AUTH_OWNER)
			kept.destroy()
		},
		TIMEOUT
	)

	it(
		"removes encryption only with owner access",
		async () => {
			const source = await save(makePdf({ pages: 1 }), undefined, {
				kind: "restrict",
				ownerPassword: "owner",
				openPassword: "open",
				allowed: PDF_ALLOW_NONE
			})

			await expect(save(source, "open", { kind: "remove" })).rejects.toThrow("ownerRequired")

			const removed = await save(source, "open", { kind: "remove" }, "owner")
			const opened = await session(removed)

			expect(opened.opened).toMatchObject({ status: "open", document: { encryption: "None" } })
			expect(snapshot(opened).security).toMatchObject({ method: "none", restricted: false, ownerAccess: true })
			expect(await pdfjsText(removed)).toBe("Page 1")
		},
		TIMEOUT
	)

	it(
		"keeps RC4 on a plain save",
		async () => {
			const source = rc4("pässwörd", "owner", permissionsValue(PDF_ALLOW_NONE))
			const kept = await save(source, "pässwörd", { kind: "keep" })
			const opened = await session(kept, "pässwörd")

			expect(snapshot(opened).security).toMatchObject({
				method: "rc4-128",
				rc4: true,
				openPassword: true,
				restricted: true,
				upgrade: "ownerRequired"
			})
			expect(await pdfjsText(kept, "pässwörd")).toBe("Page 1")
			expect(await pdfjsText(kept)).toBe("password")
		},
		TIMEOUT
	)

	it(
		"upgrades RC4 to AES-256 with the same password and permissions",
		async () => {
			const restricted = permissionsValue({ print: true, copy: false, change: false })
			const upgraded = await save(rc4("", "owner", restricted), undefined, { kind: "upgrade" }, "owner")
			const opened = await session(upgraded)

			expect(opened.opened).toMatchObject({ status: "open", document: { encryption: PDF_AES256_METHOD } })
			expect(snapshot(opened).security).toMatchObject({
				method: "aes-256",
				openPassword: false,
				permissions: restricted,
				ownerAccess: false
			})
			expect(await opened.client.call("securityUnlock", { password: "owner" })).toMatchObject({ ok: true })

			const open2 = await save(rc4("u", "u", -4), "u", { kind: "upgrade" })

			expect(snapshot(await session(open2, "u")).security).toMatchObject({ method: "aes-256", openPassword: true })
			expect(await pdfjsText(upgraded)).toBe("Page 1")
			expect(await pdfjsText(open2, "u")).toBe("Page 1")
			expect(await pdfjsText(open2)).toBe("password")
		},
		TIMEOUT
	)

	it(
		"refuses the upgrade where a password cannot be carried over",
		async () => {
			const { client } = await session(rc4("open", "owner", -4), "open")
			const unlocked = await client.call("securityUnlock", { password: "owner" })

			expect(unlocked).toMatchObject({ ok: true, state: { security: { upgrade: "openPasswordUnknown" } } })
		},
		TIMEOUT
	)

	it(
		"authenticates a password typed in a form SASLprep maps elsewhere",
		async () => {
			// The file holds "fix" (what an AES-256 writer stores), the user types the ligature.
			const saved = makePdf({ pages: 1, userPassword: "fix", ownerPassword: "fix" })
			const opened = await session(saved, "ﬁx")

			expect(opened.opened).toMatchObject({ status: "open", access: "owner" })
			expect(snapshot(opened).security).toMatchObject({ openPassword: true, ownerAccess: true })

			// The session holds the SASLprep'd form: the protection it keeps is the file's.
			const removed = await save(saved, "ﬁx", { kind: "remove" })

			expect(await pdfjsText(removed)).toBe("Page 1")
		},
		TIMEOUT
	)
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

			const copy = new mupdf.PDFDocument(extracted.bytes)

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
