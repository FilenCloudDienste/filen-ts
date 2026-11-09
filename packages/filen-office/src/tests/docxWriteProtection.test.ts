import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { buildDocxModel, gateReasons, openDocxPackage, type DocxPackage } from "@filen/office/core/docx"
import {
	commandAllowed,
	documentProtectionOf,
	DocxEditorSession,
	formattingRestricted,
	legacyPasswordVerifier,
	NO_PROTECTION,
	openDocxEditContext,
	protectionOf,
	readProtectionHash,
	writeProtectionOf,
	type ProtectionHash
} from "@filen/office/core/docx/edit"
import { saveDocx } from "@filen/office/core/docx/write"
import type { FontExtents, TextMeasurer } from "@filen/office/core/text"
import { verifyProtectionPassword } from "@filen/office/dom"
import { inThreadEditingHost } from "@filen/office/dom/docx/editing"
import { legacyPasswordBytes, legacyVerifierText, protectionHashInputs } from "../core/docx/protection/hash"
import { CORPUS_DIR } from "./corpusDir"
import { buildDocx, p } from "./docxSynthetic"

// Password to modify (w:writeProtection) and the hash form w:documentProtection shares with it.

// Word 2016 (Application "Microsoft Office Word", AppVersion 16.0000), password "a": LibreOffice
// sw/qa/uitest/data/writeprotection.docx (tdf#89383, MPL-2.0) at LibreOffice/core@63a2e19155, SHA-256
// a7dca60115a961fa281f11c2a1cf8639ffc7d1582af29528be8ad463a0c11222.
const WORD_WRITE_PROTECTION =
	'<w:writeProtection w:cryptProviderType="rsaAES" w:cryptAlgorithmClass="hash" w:cryptAlgorithmType="typeAny" w:cryptAlgorithmSid="14" w:cryptSpinCount="100000" w:hash="3HjQ4PVpzZ43tfymSZNdbTW/U4pfPg1E2ztXK/t5sQ/D+mU2nFJi+8TAuKlPN9WSIY1Kq5TV/ndaKIYjV5BH6g==" w:salt="T9LnDCDcxpnWeAOWjPDWvw=="/>'

// Word 2010 (AppVersion 14.0000), password "Example": Apache POI test-data/document/bug56076.docx
// (Apache-2.0) at apache/poi@ae62bb5116, SHA-256 3abb05a4e76d5f92cf59eb818db7b03e8ff342d051f832a1bee196b1164b3b0d.
const WORD_DOCUMENT_PROTECTION =
	'<w:documentProtection w:edit="trackedChanges" w:enforcement="1" w:cryptProviderType="rsaFull" w:cryptAlgorithmClass="hash" w:cryptAlgorithmType="typeAny" w:cryptAlgorithmSid="4" w:cryptSpinCount="100000" w:hash="MUHbcmpC9AnlLsd9v3lW0j30y6E=" w:salt="2Z+i7o/0EZyUNakVeWzU/w=="/>'

const measurer: TextMeasurer = {
	kerningControl: true,
	measure(font, _kerning, texts, count, widths) {
		const size = Number(/([\d.]+)px/.exec(font)?.[1] ?? "16")

		for (let i = 0; i < count; i++) widths[i] = (texts[i] ?? "").length * size * 0.5
	},
	fontExtents(font): FontExtents {
		const size = Number(/([\d.]+)px/.exec(font)?.[1] ?? "16")

		return { ascent: size * 0.8, descent: size * 0.2 }
	}
}

async function open(settings: string): Promise<DocxPackage> {
	const opened = await openDocxPackage(bytesSource(buildDocx({ body: p("Some text"), settings })))

	if (!opened.ok) throw new Error(opened.reason)

	return opened.package
}

async function hashOf(settings: string, element: "writeProtection" | "documentProtection" = "writeProtection"): Promise<ProtectionHash> {
	const read = readProtectionHash((await open(settings)).settings, element)

	if (read === undefined || read === "unsupported") throw new Error(`no hash: ${String(read)}`)

	return read
}

// ISO form, computed independently ([MS-OFFCRYPTO] §2.4.2.4): H0 = H(salt + input), Hn = H(Hn-1 + LE32(i)).
function isoHash(algorithm: string, salt: Buffer, input: string, spinCount: number): string {
	let h = createHash(algorithm)
		.update(Buffer.concat([salt, Buffer.from(input, "utf16le")]))
		.digest()
	const iterator = Buffer.alloc(4)

	for (let i = 0; i < spinCount; i++) {
		iterator.writeUInt32LE(i)
		h = createHash(algorithm)
			.update(Buffer.concat([h, iterator]))
			.digest()
	}

	return h.toString("base64")
}

const SALT = Buffer.from("00112233445566778899aabbccddeeff", "hex")

function iso(element: string, algorithm: string, nodeAlgorithm: string, input: string, spinCount: number = 1000): string {
	return `<w:${element} w:algorithmName="${algorithm}" w:hashValue="${isoHash(nodeAlgorithm, SALT, input, spinCount)}" w:saltValue="${SALT.toString("base64")}" w:spinCount="${spinCount}"/>`
}

describe("the legacy password verifier ([MS-OFFCRYPTO] §2.3.7.4)", () => {
	const bytes = (text: string): Uint8Array => legacyPasswordBytes(text)[0] ?? new Uint8Array()

	it("matches the published values", () => {
		// ECMA-376 Part 4 §2.15.1.28's example, and POI's leading-zero case (TestDocumentProtection).
		expect(legacyPasswordVerifier(bytes("Example"))).toBe(0x64ceed7e)
		expect(legacyVerifierText(0x64ceed7e)).toBe("7EEDCE64")
		expect(legacyPasswordVerifier(bytes("34579"))).toBe(0x0005cb00)
		expect(legacyPasswordVerifier(bytes(""))).toBe(0)
	})

	it("truncates to 15 characters and tries both single-byte forms", () => {
		expect(legacyPasswordVerifier(bytes("abcdefghijklmnopq"))).toBe(legacyPasswordVerifier(bytes("abcdefghijklmno")))
		// "€" (U+20AC): its low byte 0xAC, or 0x80 in Windows-1252.
		expect(legacyPasswordBytes("x€").map(form => [...form])).toEqual([
			[0x78, 0xac],
			[0x78, 0x80]
		])
		// Characters Windows-1252 lacks whose low byte is 0: their high byte.
		expect(legacyPasswordBytes("Ā").map(form => [...form])).toEqual([[0x01]])
		expect(legacyPasswordBytes("　").map(form => [...form])).toEqual([[0x30]])
		expect(legacyPasswordBytes("é")).toHaveLength(1)
	})
})

describe("reading protection hashes", () => {
	it("reads Word's transitional and the ISO attributes, transitional first", async () => {
		expect(await hashOf(WORD_WRITE_PROTECTION)).toEqual({
			algorithm: "SHA-512",
			hash: "3HjQ4PVpzZ43tfymSZNdbTW/U4pfPg1E2ztXK/t5sQ/D+mU2nFJi+8TAuKlPN9WSIY1Kq5TV/ndaKIYjV5BH6g==",
			salt: "T9LnDCDcxpnWeAOWjPDWvw==",
			spinCount: 100000,
			input: "plain"
		})
		expect((await hashOf(WORD_DOCUMENT_PROTECTION, "documentProtection")).input).toBe("legacy")
		expect((await hashOf(iso("documentProtection", "SHA-256", "sha256", "x"), "documentProtection")).input).toBe("either")

		const both = await hashOf(
			'<w:writeProtection w:cryptAlgorithmSid="4" w:hash="aGFzaA==" w:salt="" w:algorithmName="SHA-512" w:hashValue="b3RoZXI=" w:spinCount="5"/>'
		)

		expect(both).toMatchObject({ algorithm: "SHA-1", hash: "aGFzaA==", spinCount: 0 })
	})

	it("calls hashes no platform digest computes, or out of bounds, unsupported", async () => {
		const read = async (settings: string) => readProtectionHash((await open(settings)).settings, "writeProtection")

		expect(await read('<w:writeProtection w:cryptAlgorithmSid="3" w:hash="aGFzaA==" w:salt="c2FsdA=="/>')).toBe("unsupported")
		expect(await read('<w:writeProtection w:cryptAlgorithmSid="4" w:algIdExt="0000800C" w:hash="aGFzaA=="/>')).toBe("unsupported")
		expect(await read('<w:writeProtection w:cryptAlgorithmSid="4" w:cryptSpinCount="10000001" w:hash="aGFzaA=="/>')).toBe("unsupported")
		expect(await read('<w:writeProtection w:cryptAlgorithmSid="4" w:cryptSpinCount="-1" w:hash="aGFzaA=="/>')).toBe("unsupported")
		expect(await read('<w:writeProtection w:algorithmName="WHIRLPOOL" w:hashValue="aGFzaA==" w:spinCount="1"/>')).toBe("unsupported")
		expect(await read('<w:writeProtection w:recommended="1"/>')).toBeUndefined()
		expect(await read("")).toBeUndefined()
	})

	it("hashes the password itself for writeProtection, and its legacy verifier for documentProtection", async () => {
		expect(protectionHashInputs(await hashOf(WORD_WRITE_PROTECTION), "a")).toEqual(["a"])
		expect(protectionHashInputs(await hashOf(WORD_DOCUMENT_PROTECTION, "documentProtection"), "Example")).toEqual(["7EEDCE64"])
		expect(
			protectionHashInputs(await hashOf(iso("documentProtection", "SHA-1", "sha1", "x"), "documentProtection"), "Example")
		).toEqual(["Example", "7EEDCE64"])
	})
})

// 100,000-spin samples: room for a loaded machine.
const SPIN_TIMEOUT = 60_000

describe("verifyProtectionPassword", () => {
	it(
		"verifies Word's write protection (Word 2016, SHA-512, 100,000 spins)",
		async () => {
			const hash = await hashOf(WORD_WRITE_PROTECTION)

			expect(await verifyProtectionPassword(hash, "a")).toBe("correct")
			expect(await verifyProtectionPassword(hash, "A")).toBe("wrong")
		},
		SPIN_TIMEOUT
	)

	it(
		"verifies Word's document protection hash (Word 2010, SHA-1, legacy verifier)",
		async () => {
			const hash = await hashOf(WORD_DOCUMENT_PROTECTION, "documentProtection")

			expect(await verifyProtectionPassword(hash, "Example")).toBe("correct")
			expect(await verifyProtectionPassword(hash, "example")).toBe("wrong")
		},
		SPIN_TIMEOUT
	)

	it(
		"verifies the ISO attributes with every platform digest",
		async () => {
			for (const [name, node] of [
				["SHA-1", "sha1"],
				["SHA-256", "sha256"],
				["SHA-384", "sha384"],
				["SHA-512", "sha512"]
			] as const) {
				const hash = await hashOf(iso("writeProtection", name, node, "pässwörd 🔒"))

				expect(await verifyProtectionPassword(hash, "pässwörd 🔒")).toBe("correct")
				// NFC and NFD are different passwords.
				expect(await verifyProtectionPassword(hash, "pässwörd 🔒".normalize("NFD"))).toBe("wrong")
			}

			const legacy = await hashOf(iso("documentProtection", "SHA-512", "sha512", "7EEDCE64"), "documentProtection")

			expect(await verifyProtectionPassword(legacy, "Example")).toBe("correct")
			expect(await verifyProtectionPassword(await hashOf(iso("writeProtection", "SHA-1", "sha1", "x", 0)), "x")).toBe("correct")
		},
		SPIN_TIMEOUT
	)

	it("calls a hash that cannot match unsupported", async () => {
		const hash = await hashOf(WORD_WRITE_PROTECTION)

		expect(await verifyProtectionPassword({ ...hash, hash: "not base64!" }, "a")).toBe("unsupported")
		expect(await verifyProtectionPassword({ ...hash, hash: "aGFzaA==" }, "a")).toBe("unsupported")
		expect(await verifyProtectionPassword({ ...hash, salt: Buffer.alloc(65537).toString("base64") }, "a")).toBe("unsupported")
	})

	it("stops when the caller aborts", async () => {
		const hash = await hashOf(WORD_WRITE_PROTECTION)

		await expect(verifyProtectionPassword(hash, "a", { signal: { aborted: true } })).rejects.toMatchObject({ code: "aborted" })
	})
})

describe("the write protection gate", () => {
	it("keeps a password-protected document view-only until unlocked, then saves it with the element unchanged", async () => {
		const pkg = await open(WORD_WRITE_PROTECTION)
		const model = await buildDocxModel(pkg)
		const locked = await openDocxEditContext(pkg, model)

		expect(locked.gate).toEqual(["writeProtected"])
		expect(writeProtectionOf(locked)).toMatchObject({ recommended: false, password: { algorithm: "SHA-512" } })
		expect(new DocxEditorSession(locked).readOnly).toBe(true)
		await expect(saveDocx({ pkg, context: locked, sessions: [new DocxEditorSession(locked)] })).rejects.toMatchObject({
			reason: "readOnly"
		})

		const context = await openDocxEditContext(pkg, model, { writeUnlocked: true })
		const session = new DocxEditorSession(context)

		expect(context.gate).toEqual([])
		expect(session.readOnly).toBe(false)
		expect(session.dispatch(session.state.tr.insertText("New ", 1))).toBe(true)

		const saved = unzipSync((await saveDocx({ pkg, context, sessions: [session] })).bytes as Uint8Array)
		const source = unzipSync(buildDocx({ body: p("Some text"), settings: WORD_WRITE_PROTECTION }))

		expect(new TextDecoder().decode(saved["word/document.xml"])).toContain("New Some text")
		expect(saved["word/settings.xml"]).toEqual(source["word/settings.xml"])

		// A save that rewrites the settings part (tracking turned on) keeps the element as written.
		context.review.tracking = true

		const tracked = new TextDecoder().decode(
			unzipSync((await saveDocx({ pkg, context, sessions: [session] })).bytes as Uint8Array)["word/settings.xml"]
		)

		expect(tracked).toContain("<w:trackRevisions/>")
		expect(tracked).toContain(WORD_WRITE_PROTECTION)
	})

	it("leaves the other gate reasons in place when unlocked", async () => {
		const pkg = await open(`${WORD_WRITE_PROTECTION}<w:documentProtection w:edit="readOnly" w:enforcement="1"/>`)
		const model = await buildDocxModel(pkg)

		expect(gateReasons(pkg.facts)).toEqual(["protected", "writeProtected"])
		expect((await openDocxEditContext(pkg, model, { writeUnlocked: true })).gate).toEqual(["protected"])
	})

	it("gates nothing for a read-only recommendation alone (the app offers it)", async () => {
		const pkg = await open('<w:writeProtection w:recommended="1"/>')
		const context = await openDocxEditContext(pkg, await buildDocxModel(pkg))

		expect(context.gate).toEqual([])
		expect(writeProtectionOf(context)).toEqual({ recommended: true, password: undefined })

		const plain = await open("")

		expect(writeProtectionOf(await openDocxEditContext(plain, await buildDocxModel(plain)))).toBeUndefined()
	})

	it("calls a password it cannot check unsupported (still view-only)", async () => {
		const pkg = await open('<w:writeProtection w:recommended="1" w:cryptAlgorithmSid="3" w:hash="aGFzaA==" w:salt="c2FsdA=="/>')
		const context = await openDocxEditContext(pkg, await buildDocxModel(pkg))

		expect(context.gate).toEqual(["writeProtected"])
		expect(writeProtectionOf(context)).toEqual({ recommended: true, password: "unsupported" })
	})

	it("opens editable through an editing host told the password was given", async () => {
		for (const writeUnlocked of [false, true]) {
			const editing = inThreadEditingHost(
				() => ({
					fontHost: { addBytes: () => Promise.resolve(true), addLocal: () => Promise.resolve(false), remove: () => undefined },
					replayFonts: false,
					fontAssets: { read: () => Promise.resolve(new Uint8Array(4)) },
					measurer,
					yield: () => Promise.resolve(),
					sliceMs: 8
				}),
				{ writeUnlocked }
			)
			const session = editing.host(bytesSource(buildDocx({ body: p("Some text"), settings: WORD_WRITE_PROTECTION })), () => undefined)
			const editor = await editing.editor

			expect(editor.session.readOnly).toBe(!writeUnlocked)
			session.close()
		}
	})
})

// Review > Restrict Editing > Stop Protection (ECMA-376 Part 1 §17.15.1.29): the app checks the password against
// documentProtectionOf and opens the document again with protectionUnlocked.
describe("stopping document protection", () => {
	const settingsOf = async (pkg: DocxPackage, context: Awaited<ReturnType<typeof openDocxEditContext>>, session: DocxEditorSession) =>
		new TextDecoder().decode(
			unzipSync((await saveDocx({ pkg, context, sessions: [session] })).bytes as Uint8Array)["word/settings.xml"]
		)

	it("tells the password to check, and nothing once unlocked or unenforced", async () => {
		const pkg = await open(WORD_DOCUMENT_PROTECTION)
		const model = await buildDocxModel(pkg)

		expect(documentProtectionOf(await openDocxEditContext(pkg, model))).toMatchObject({
			edit: "trackedChanges",
			password: { algorithm: "SHA-1", input: "legacy" }
		})
		expect(documentProtectionOf(await openDocxEditContext(pkg, model, { protectionUnlocked: true }))).toBeUndefined()

		const plain = await open('<w:documentProtection w:edit="forms" w:enforcement="1"/>')

		expect(documentProtectionOf(await openDocxEditContext(plain, await buildDocxModel(plain)))).toEqual({
			edit: "forms",
			formatting: false,
			password: undefined
		})

		const odd = await open(
			'<w:documentProtection w:edit="forms" w:enforcement="1" w:cryptAlgorithmSid="3" w:hash="aGFzaA==" w:salt="c2FsdA=="/>'
		)

		expect(documentProtectionOf(await openDocxEditContext(odd, await buildDocxModel(odd)))?.password).toBe("unsupported")

		const off = await open('<w:documentProtection w:edit="forms" w:enforcement="0"/>')

		expect(documentProtectionOf(await openDocxEditContext(off, await buildDocxModel(off)))).toBeUndefined()
	})

	it("lifts limited protection and its formatting restrictions, and saves the protection switched off", async () => {
		const pkg = await open(
			'<w:documentProtection w:edit="forms" w:formatting="1" w:enforcement="1" w:cryptProviderType="rsaFull" w:cryptAlgorithmClass="hash" w:cryptAlgorithmType="typeAny" w:cryptAlgorithmSid="4" w:cryptSpinCount="100000" w:hash="MUHbcmpC9AnlLsd9v3lW0j30y6E=" w:salt="2Z+i7o/0EZyUNakVeWzU/w=="/>'
		)
		const model = await buildDocxModel(pkg)
		const locked = await openDocxEditContext(pkg, model)
		const lockedSession = new DocxEditorSession(locked)

		expect(protectionOf(locked).mode).toBe("forms")
		expect(formattingRestricted(locked)).toBe(true)
		expect(commandAllowed(lockedSession, "format.bold")).toBe(false)
		expect(lockedSession.dispatch(lockedSession.state.tr.insertText("New ", 1))).toBe(false)

		const context = await openDocxEditContext(pkg, model, { protectionUnlocked: true })
		const session = new DocxEditorSession(context)

		expect(protectionOf(context)).toBe(NO_PROTECTION)
		expect(formattingRestricted(context)).toBe(false)
		expect(commandAllowed(session, "format.bold")).toBe(true)
		expect(session.dispatch(session.state.tr.insertText("New ", 1))).toBe(true)

		const settings = await settingsOf(pkg, context, session)

		expect(settings).toContain('<w:documentProtection w:edit="forms" w:formatting="1" w:enforcement="0"/>')
		expect(settings).not.toContain("w:hash=")

		// Saved without the unlock, the element stays as written.
		expect(await settingsOf(pkg, locked, lockedSession)).not.toContain('w:enforcement="0"')
	})

	it("lifts the view-only gate of read-only protection, and the saved file opens unprotected", async () => {
		const pkg = await open('<w:documentProtection w:edit="readOnly" w:enforcement="1"/>')
		const model = await buildDocxModel(pkg)

		expect((await openDocxEditContext(pkg, model)).gate).toEqual(["protected"])
		expect((await openDocxEditContext(pkg, model, { writeUnlocked: true })).gate).toEqual(["protected"])

		const context = await openDocxEditContext(pkg, model, { protectionUnlocked: true })
		const session = new DocxEditorSession(context)

		expect(context.gate).toEqual([])
		expect(session.readOnly).toBe(false)
		expect(session.dispatch(session.state.tr.insertText("New ", 1))).toBe(true)

		const saved = (await saveDocx({ pkg, context, sessions: [session] })).bytes as Uint8Array
		const reopened = await openDocxPackage(bytesSource(saved))

		if (!reopened.ok) throw new Error(reopened.reason)

		expect(reopened.package.facts.documentProtection).toMatchObject({ edit: "readOnly", enforced: false })
		expect((await openDocxEditContext(reopened.package, await buildDocxModel(reopened.package))).gate).toEqual([])
	})

	it("keeps tracking on after tracked changes protection stops, and lets the user turn it off", async () => {
		const pkg = await open(WORD_DOCUMENT_PROTECTION)
		const context = await openDocxEditContext(pkg, await buildDocxModel(pkg), { protectionUnlocked: true })
		const session = new DocxEditorSession(context)

		expect(context.review.tracking).toBe(true)
		expect(commandAllowed(session, "review.track")).toBe(true)
		expect(commandAllowed(session, "review.acceptAll")).toBe(true)
	})

	it("opens unprotected through an editing host told protection was stopped", async () => {
		for (const protectionUnlocked of [false, true]) {
			const editing = inThreadEditingHost(
				() => ({
					fontHost: { addBytes: () => Promise.resolve(true), addLocal: () => Promise.resolve(false), remove: () => undefined },
					replayFonts: false,
					fontAssets: { read: () => Promise.resolve(new Uint8Array(4)) },
					measurer,
					yield: () => Promise.resolve(),
					sliceMs: 8
				}),
				{ protectionUnlocked }
			)
			const session = editing.host(
				bytesSource(buildDocx({ body: p("Some text"), settings: '<w:documentProtection w:edit="readOnly" w:enforcement="1"/>' })),
				() => undefined
			)
			const editor = await editing.editor

			expect(editor.session.readOnly).toBe(!protectionUnlocked)
			session.close()
		}
	})
})

// Word's own files in the corpus (GOV.UK, OGL-UK-3.0): read-only recommended without a password, and document
// protection with a SHA-512 hash whose password is not published.
const RECOMMENDED_FILES = [
	"govuk__IHM_Post16_Evidence_summary_Speech_language_and_communication.docx",
	"govuk__IHM_Post16_Fac_guide_Intro_session_2_What_is_inclusive_teaching.docx",
	"govuk__IHM_Post16_Fac_guide_Intro_session_3_Areas_of_development.docx",
	"govuk__IHM_Post16_Fac_guide_Intro_session_4_Speech_language_and_communication.docx",
	"govuk__IHM_Post16_Fac_guide_Sense-making_Speech_language_and_communication.docx",
	"govuk__IHM_Sch_Evidence_summary_Speech_language_and_communication.docx",
	"govuk__IHM_Sch_Fac_guide_Intro_session_2_What_is_inclusive_teaching.docx",
	"govuk__IHM_Sch_Fac_guide_Intro_session_3_Areas_of_development.docx",
	"govuk__IHM_Sch_Fac_guide_Intro_session_4_Speech_language_and_communication.docx",
	"govuk__IHM_Sch_Fac_guide_Sense-making_Speech_language_and_communication.docx"
]
const HASHED_FILES = [
	"govuk__Hep_A_6.0_FINAL.docx",
	"govuk__Hep_A___B_v5.0_FINAL.docx",
	"govuk__IP-guidance-implementation-tracker-template.docx",
	"govuk__Recognition_Requirement.docx"
]
const corpusFile = (name: string): string => join(CORPUS_DIR, "docx", name)

describe.skipIf(!existsSync(corpusFile(RECOMMENDED_FILES[0] ?? "")))("Word's write and document protection in the corpus", () => {
	it("reads the read-only recommendations and the document protection hashes", async () => {
		for (const name of RECOMMENDED_FILES) {
			const opened = await openDocxPackage(bytesSource(new Uint8Array(readFileSync(corpusFile(name)))))

			if (!opened.ok) throw new Error(`${name}: ${opened.reason}`)

			expect(opened.package.facts.writeProtection, name).toEqual({ recommended: true, hashed: false })
			expect(gateReasons(opened.package.facts), name).not.toContain("writeProtected")
			expect(readProtectionHash(opened.package.settings, "writeProtection"), name).toBeUndefined()
		}

		for (const name of HASHED_FILES) {
			const opened = await openDocxPackage(bytesSource(new Uint8Array(readFileSync(corpusFile(name)))))

			if (!opened.ok) throw new Error(`${name}: ${opened.reason}`)

			expect(readProtectionHash(opened.package.settings, "documentProtection"), name).toMatchObject({
				algorithm: "SHA-512",
				spinCount: 100000,
				input: "legacy"
			})
		}
	})

	it(
		"verifies the corpus files with a published password to modify",
		async () => {
			const manifest = JSON.parse(readFileSync(join(CORPUS_DIR, "manifest.json"), "utf8")) as {
				files: { path: string; modifyPassword?: string }[]
			}
			const samples = manifest.files.filter(file => file.modifyPassword !== undefined)

			expect(samples.map(file => file.path).sort()).toEqual(["docx/lo__writeprotection.docx", "docx/poi__bug56076.docx"])

			for (const { path, modifyPassword } of samples) {
				const opened = await openDocxPackage(bytesSource(new Uint8Array(readFileSync(join(CORPUS_DIR, path)))))

				if (!opened.ok || modifyPassword === undefined) throw new Error(path)

				const settings = opened.package.settings
				const hash = readProtectionHash(settings, "writeProtection") ?? readProtectionHash(settings, "documentProtection")

				if (hash === undefined || hash === "unsupported") throw new Error(`${path}: no hash`)

				expect(await verifyProtectionPassword(hash, modifyPassword), path).toBe("correct")
				expect(await verifyProtectionPassword(hash, `${modifyPassword}x`), path).toBe("wrong")
			}
		},
		SPIN_TIMEOUT
	)
})
