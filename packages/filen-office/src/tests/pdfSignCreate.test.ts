import * as mupdf from "mupdf"
import { describe, expect, it } from "vitest"
import {
	BYTE_RANGE_SENTINEL,
	PdfPkcs12Error,
	PdfPlaceholderError,
	buildPdfCms,
	certificateInfo,
	locatePlaceholder,
	patchByteRange,
	patchContents,
	type PdfSigningIdentity
} from "../core/pdfsign"
import { parseCms, verifyCms } from "../core/pdfsign/cms"
import { cmsCapacity } from "../core/pdfsign/cmsBuild"
import { createPdfDigest } from "../dom/pdfedit/digest"
import { addPdfSignatureField, PdfSignRefusal } from "../dom/pdfedit/sign"
import { signedFixture } from "./pdfSignFixtures"
import {
	P12_UNICODE_PASSWORD,
	loadIdentity,
	p12Fixture,
	signBytes,
	signRequest,
	signingSubtle,
	verifySigned
} from "./pdfSignCreateFixtures"
import { budget } from "./timing"

async function digestOf(bytes: Uint8Array, identity: PdfSigningIdentity): Promise<Uint8Array> {
	const digest = await createPdfDigest(identity.scheme.digest)

	digest.update(bytes)

	return digest.digest()
}

async function importFailure(name: string, password?: string): Promise<string> {
	try {
		await loadIdentity(name, password)
	} catch (error) {
		if (error instanceof PdfPkcs12Error) return error.reason

		throw error
	}

	return "imported"
}

describe("PKCS#12 import", () => {
	it.each([
		["rsa2048", "RSASSA-PKCS1-v1_5", "SHA-256"],
		["rsa4096", "RSASSA-PKCS1-v1_5", "SHA-256"],
		["rsapss", "RSA-PSS", "SHA-256"],
		["p256", "ECDSA", "SHA-256"],
		["p384", "ECDSA", "SHA-384"],
		["p521", "ECDSA", "SHA-512"],
		["ed25519", "Ed25519", "SHA-512"],
		["legacy-rc2", "RSASSA-PKCS1-v1_5", "SHA-256"],
		["legacy-3des", "RSASSA-PKCS1-v1_5", "SHA-256"],
		["legacy-3des-p256", "ECDSA", "SHA-256"]
	])("reads %s: key, leaf by localKeyId, chain to the root", async (name, scheme, digest) => {
		const identity = await loadIdentity(name)

		expect(identity.scheme).toMatchObject({ name: scheme, digest })
		expect(identity.chain.map(cert => certificateInfo(cert).commonName)).toEqual([`${name} signer`, "Fixture Signing Root"])
	})

	it("takes a non-ASCII password as UTF-8 (PBKDF2) and BMPString (MAC, legacy PBE)", async () => {
		for (const name of ["unicode", "unicode-3des"]) {
			const identity = await loadIdentity(name, P12_UNICODE_PASSWORD)

			expect(certificateInfo(identity.chain[0] ?? fail()).commonName).toBe(`${name} signer`)
			expect(await importFailure(name, "Passwort")).toBe("password")
		}
	})

	it("keeps the key non-extractable", async () => {
		const identity = await loadIdentity("rsa2048")

		await expect(signingSubtle.digest("SHA-256", new Uint8Array(1))).resolves.toBeInstanceOf(ArrayBuffer)
		expect(identity.key).toMatchObject({ extractable: false, usages: ["sign"] })
	})

	it("refuses a wrong password, Brainpool, a weak key, a key without its certificate and non-PKCS#12 bytes", async () => {
		expect(await importFailure("rsa2048", "wrong")).toBe("password")
		expect(await importFailure("legacy-3des", "wrong")).toBe("password")
		expect(await importFailure("brainpool")).toBe("algorithm")
		expect(await importFailure("rsa1024")).toBe("weakKey")
		expect(await importFailure("mismatch")).toBe("keyMismatch")
		expect(await importFailure("unicode-3des", "Pässwörd-密码x")).toBe("password")

		const notP12 = await (async () => {
			try {
				await (await import("../core/pdfsign")).importPkcs12(new Uint8Array([1, 2, 3]), "x", { subtle: signingSubtle })
			} catch (error) {
				return error instanceof PdfPkcs12Error ? error.reason : "other"
			}

			return "imported"
		})()

		expect(notP12).toBe("malformed")
	})

	it("needs node-forge only for legacy containers", async () => {
		const { importPkcs12 } = await import("../core/pdfsign")

		await expect(importPkcs12(p12Fixture("rsa2048"), "fixture-password", { subtle: signingSubtle })).resolves.toBeDefined()
		await expect(importPkcs12(p12Fixture("legacy-3des"), "fixture-password", { subtle: signingSubtle })).rejects.toMatchObject({
			reason: "algorithm"
		})
	})
})

describe("CMS signatures", () => {
	it.each([
		["rsa2048", "RSA 2048"],
		["rsa4096", "RSA 4096"],
		["rsapss", "RSA-PSS 2048"],
		["p256", "ECDSA P-256"],
		["p384", "ECDSA P-384"],
		["p521", "ECDSA P-521"],
		["ed25519", "Ed25519"]
	])("%s verifies with our verifier and fits its estimate", async (name, algorithm) => {
		const identity = await loadIdentity(name)
		const content = new TextEncoder().encode("signed bytes")
		const digest = await digestOf(content, identity)
		const der = await buildPdfCms(identity, digest, signingSubtle)
		const parsed = parseCms(der)

		if (!parsed.ok) throw new Error("parse failed")

		expect(der.length).toBeLessThanOrEqual(cmsCapacity(identity))
		expect(parsed.cms.content).toBeNull()
		expect(parsed.cms.signer.signedAttrs?.attributes.map(attribute => attribute.type).sort()).toEqual([
			"1.2.840.113549.1.9.16.2.47",
			"1.2.840.113549.1.9.3",
			"1.2.840.113549.1.9.4"
		])
		expect(await verifyCms(parsed.cms, digest, { subtle: signingSubtle, createDigest: createPdfDigest })).toEqual({
			ok: true,
			algorithm
		})
		expect(
			await verifyCms(
				parsed.cms,
				digest.map(byte => byte ^ 1),
				{ subtle: signingSubtle, createDigest: createPdfDigest }
			)
		).toMatchObject({
			ok: false,
			reason: "digestMismatch"
		})
	})
})

describe("signing a PDF", () => {
	it(
		"signs a new field: unchanged since signing, pdf.js agrees, earlier bytes untouched",
		async () => {
			const original = signedFixture("unsigned.pdf")
			const identity = await loadIdentity("rsa2048")
			const signed = await signBytes(original, identity)
			const report = await verifySigned(signed)

			expect(signed.subarray(0, original.length)).toEqual(original)
			expect(report.signatures).toHaveLength(1)
			expect(report.signatures[0]).toMatchObject({
				field: "Signature2",
				state: "unchanged",
				algorithm: "RSA 2048",
				digest: "SHA-256",
				name: "Fixture Signer",
				reason: "Approval",
				location: "Berlin",
				claimedTime: Date.UTC(2026, 10, 14, 12),
				subFilter: "ETSI.CAdES.detached",
				signedLength: signed.length,
				page: 0
			})
		},
		budget(30_000)
	)

	it.each(["p256", "p384", "ed25519", "rsapss", "legacy-3des"])(
		"signs with %s",
		async name => {
			const signed = await signBytes(signedFixture("unsigned.pdf"), await loadIdentity(name))

			expect((await verifySigned(signed)).signatures[0]?.state).toBe("unchanged")
		},
		budget(30_000)
	)

	it(
		"signs an existing empty signature field with an image appearance",
		async () => {
			const identity = await loadIdentity("p256")
			const png = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 40, 20], false)

			png.clear(80)

			const signed = await signBytes(signedFixture("unsigned.pdf"), identity, {
				placement: { kind: "field", name: "Signature1" },
				visual: { kind: "image", png: png.asPNG().slice() }
			})
			const report = await verifySigned(signed)

			expect(report.signatures).toEqual([
				expect.objectContaining({ field: "Signature1", state: "unchanged", rect: [72, 600, 272, 660] })
			])

			// The widget shows our appearance, nobody else's was regenerated.
			const document = new mupdf.PDFDocument(signed.slice())
			const widget = document
				.loadPage(0)
				.getWidgets()
				.find(item => item.getName() === "Signature1")

			expect(widget?.getObject().get("AP", "N").isStream()).toBe(true)
			expect(
				document
					.loadPage(0)
					.getWidgets()
					.find(item => item.getName() === "Name")
					?.getObject()
					.get("AP")
					.isNull()
			).toBe(true)
		},
		budget(30_000)
	)

	it(
		"adds a second signature that keeps the first valid (changed, allowed)",
		async () => {
			const signed = await signBytes(signedFixture("approval-rsa.pdf"), await loadIdentity("p384"), {
				placement: { kind: "rect", page: 0, rect: [320, 300, 520, 360] }
			})
			const [first, second] = (await verifySigned(signed)).signatures

			expect(first).toMatchObject({ field: "Signature1", state: "changed", changes: { allowed: true, kinds: ["signature"] } })
			expect(second).toMatchObject({ field: "Signature2", state: "unchanged", algorithm: "ECDSA P-384" })
		},
		budget(30_000)
	)

	it(
		"certifies at level 2, after which filling the form is allowed",
		async () => {
			const certified = await signBytes(signedFixture("unsigned.pdf"), await loadIdentity("rsa2048"), { certify: 2 })

			expect((await verifySigned(certified)).signatures[0]).toMatchObject({ state: "unchanged", certification: 2 })

			const document = new mupdf.PDFDocument(certified.slice())
			const field = document
				.loadPage(0)
				.getWidgets()
				.find(item => item.getName() === "Name")

			field?.setTextValue("Ada")
			field?.update()

			const filled = document.saveToBuffer("incremental").asUint8Array().slice()

			expect((await verifySigned(filled)).signatures[0]).toMatchObject({
				state: "changed",
				certification: 2,
				changes: { allowed: true, kinds: ["form"] }
			})

			// Only the first signature certifies; a level 1 certification allows no more signatures.
			expect(() => addPdfSignatureField(mupdf, new mupdf.PDFDocument(certified.slice()), signRequest({ certify: 3 }))).toThrow(
				expect.objectContaining({ reason: "certifyAfterSignature" })
			)

			const locked = await signBytes(signedFixture("unsigned.pdf"), await loadIdentity("rsa2048"), { certify: 1 })

			expect(() => addPdfSignatureField(mupdf, new mupdf.PDFDocument(locked.slice()), signRequest())).toThrow(PdfSignRefusal)
		},
		budget(30_000)
	)

	it(
		"keeps /Contents unencrypted in an encrypted document",
		async () => {
			const source = new mupdf.PDFDocument(signedFixture("unsigned.pdf"))
			const encrypted = source.saveToBuffer("encrypt=aes-256,user-password=open,owner-password=owner").asUint8Array().slice()
			const signed = await signBytes(encrypted, await loadIdentity("rsa2048"), {}, { password: "open" })
			const report = await verifySigned(signed, "open")

			expect(report.signatures[0]).toMatchObject({ state: "unchanged", name: "Fixture Signer" })
			expect(new TextDecoder("latin1").decode(signed.subarray(encrypted.length))).toMatch(/\/Contents\s*<30[0-9A-F]+>/)
		},
		budget(30_000)
	)

	it(
		"saves again with room for a signature larger than the placeholder",
		async () => {
			const original = signedFixture("unsigned.pdf")
			const signed = await signBytes(original, await loadIdentity("rsa4096"), {}, { capacity: 64 })
			const report = await verifySigned(signed)

			expect(report.signatures[0]).toMatchObject({ state: "unchanged", revision: 3, signedLength: signed.length })
			expect(report.revisions).toBe(3)
			expect(signed.subarray(0, original.length)).toEqual(original)
		},
		budget(30_000)
	)

	it("shows non-Latin text and refuses a missing field or page", async () => {
		const identity = await loadIdentity("rsa2048")
		const signed = await signBytes(signedFixture("unsigned.pdf"), identity, { lines: ["Подписано: Ωμέγα"], visual: null })
		const widget = new mupdf.PDFDocument(signed.slice())
			.loadPage(0)
			.getWidgets()
			.find(item => item.getName() === "Signature2")
		const text = widget?.toDisplayList().toStructuredText("preserve-whitespace").asText()

		expect(text).toContain("Подписано: Ωμέγα")
		expect((await verifySigned(signed)).signatures[0]?.state).toBe("unchanged")

		const document = new mupdf.PDFDocument(signedFixture("unsigned.pdf"))

		expect(() => addPdfSignatureField(mupdf, document, signRequest({ placement: { kind: "field", name: "Nope" } }))).toThrow(
			expect.objectContaining({ reason: "fieldNotFound" })
		)
		expect(() =>
			addPdfSignatureField(mupdf, document, signRequest({ placement: { kind: "rect", page: 9, rect: [0, 0, 1, 1] } }))
		).toThrow(expect.objectContaining({ reason: "pageOutOfRange" }))
	})
})

describe("signature placeholders", () => {
	const ascii = (text: string): Uint8Array => new TextEncoder().encode(text)
	const sentinel = String(BYTE_RANGE_SENTINEL)
	const object = (contents: string, extra = ""): string =>
		`7 0 obj\n<</Type/Sig/ByteRange[0 ${sentinel} ${sentinel} ${sentinel}]/Contents<${contents}>${extra}>>\nendobj\n`

	it("patches /ByteRange in place and writes the CMS as hex", () => {
		const prefix = "%PDF-1.7\n1 0 obj\n<<>>\nendobj\n"
		const bytes = ascii(`${prefix}${object("0".repeat(8))}trailer\n%%EOF\n`)
		const placeholder = locatePlaceholder(bytes, 7, prefix.length, 4)
		const range = patchByteRange(bytes, placeholder)

		expect(range).toEqual([0, placeholder.contentsStart, placeholder.contentsEnd, bytes.length - placeholder.contentsEnd])
		expect(patchContents(bytes, placeholder, new Uint8Array([0xab, 0x01, 0x02, 0x03, 0x04]))).toBe(false)
		expect(patchContents(bytes, placeholder, new Uint8Array([0xab, 0x01]))).toBe(true)

		const text = new TextDecoder().decode(bytes)

		expect(text).toContain(`/ByteRange[0 ${String(range[1])} ${String(range[2])} ${String(range[3])}`)
		expect(text).toContain("/Contents<AB010000>")
	})

	it("refuses an encrypted or resized /Contents, a duplicate key and an object outside the appended revision", () => {
		const prefix = "%PDF-1.7\n"

		expect(() => locatePlaceholder(ascii(prefix + object("5A3F09C1")), 7, prefix.length, 4)).toThrow(PdfPlaceholderError)
		expect(() => locatePlaceholder(ascii(prefix + object("0".repeat(10))), 7, prefix.length, 4)).toThrow(PdfPlaceholderError)
		expect(() => locatePlaceholder(ascii(prefix + object("0".repeat(8), "/Contents<00>")), 7, prefix.length, 4)).toThrow(
			PdfPlaceholderError
		)
		expect(() => locatePlaceholder(ascii(object("0".repeat(8)) + "trailer\n"), 7, 40, 4)).toThrow(PdfPlaceholderError)
	})

	it(
		"keeps the appearance upright on a rotated page",
		async () => {
			const source = new mupdf.PDFDocument(signedFixture("unsigned.pdf"))

			source.findPage(0).put("Rotate", 90)

			const signed = await signBytes(source.saveToBuffer("").asUint8Array().slice(), await loadIdentity("rsa2048"), {
				placement: { kind: "rect", page: 0, rect: [100, 100, 400, 200] }
			})
			const widget = new mupdf.PDFDocument(signed.slice())
				.loadPage(0)
				.getWidgets()
				.find(item => item.getName() === "Signature2")

			expect(widget?.getObject().get("AP", "N", "Matrix").toString()).toBe("[0 1 -1 0 0 0]")
			expect(widget?.getObject().get("AP", "N", "BBox").toString()).toBe("[0 0 300 100]")
			expect((await verifySigned(signed)).signatures[0]?.state).toBe("unchanged")
		},
		budget(30_000)
	)
})

function fail(): never {
	throw new Error("missing")
}
