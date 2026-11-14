import { readdirSync } from "node:fs"
import * as mupdf from "mupdf"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
import { describe, expect, it } from "vitest"
import type { PdfSignatureInfo } from "../core/pdfsign"
import { createPdfDigest } from "../dom/pdfedit/digest"
import { pdfSignatureFields } from "../dom/pdf/signatureFields"
import { verifyPdfSignatures } from "../dom/pdfedit/verify"
import { nodeSubtle, signedFixture as fixture, verifyBytes } from "./pdfSignFixtures"

async function only(name: string): Promise<PdfSignatureInfo> {
	const report = await verifyBytes(fixture(name))

	expect(report.signatures).toHaveLength(1)

	const [signature] = report.signatures

	if (signature === undefined) throw new Error("no signature")

	return signature
}

describe("verifyPdfSignatures", () => {
	it("reports no signatures for an unsigned file", async () => {
		expect((await verifyBytes(fixture("unsigned.pdf"))).signatures).toEqual([])
	})

	it.each([
		["approval-rsa.pdf", "RSA 2048", "SHA-256"],
		["approval-pkcs7.pdf", "RSA 2048", "SHA-256"],
		["approval-rsa-sha512.pdf", "RSA 2048", "SHA-512"],
		["approval-pss.pdf", "RSA-PSS 2048", "SHA-256"],
		["approval-p256.pdf", "ECDSA P-256", "SHA-256"],
		["approval-p384.pdf", "ECDSA P-384", "SHA-384"],
		["approval-p521.pdf", "ECDSA P-521", "SHA-512"],
		["approval-ed25519.pdf", "Ed25519", "SHA-512"],
		["approval-selfsigned.pdf", "RSA 2048", "SHA-256"]
	])("%s is unchanged since signing", async (name, algorithm, digest) => {
		const signature = await only(name)

		expect(signature).toMatchObject({ state: "unchanged", algorithm, digest, field: "Signature1", page: 0, revision: 2, changes: null })
		expect(signature.rect).toEqual([72, 600, 272, 660])
		expect(signature.signedLength).toBe(fixture(name).length)
		expect(signature.claimedTime).toBe(Date.UTC(2026, 0, 1, 12))
	})

	it("describes the signer and its chain", async () => {
		const signature = await only("approval-rsa.pdf")

		expect(signature.signer).toMatchObject({ commonName: "rsa2048 signer", organization: "Filen Fixtures", selfSigned: false })
		expect(signature.chain.map(cert => cert.commonName)).toEqual(["rsa2048 signer", "Fixture Root CA"])
		expect(signature.chain[1]?.selfSigned).toBe(true)
		expect(signature).toMatchObject({ name: "Fixture Signer", reason: "Approval", expiredAtClaimedTime: false })
		expect((await only("approval-selfsigned.pdf")).signer?.selfSigned).toBe(true)
	})

	it("flags a certificate expired at the claimed time without failing the signature", async () => {
		expect(await only("approval-expired.pdf")).toMatchObject({
			state: "unchanged",
			expiredAtClaimedTime: true,
			notYetValidAtClaimedTime: false
		})
	})

	it("shows a signature timestamp's time and verifies document timestamps", async () => {
		const stamped = await only("approval-timestamped.pdf")

		expect(stamped.state).toBe("unchanged")
		expect(stamped.timestampTime).toBeTypeOf("number")
		expect(await only("doc-timestamp.pdf")).toMatchObject({
			kind: "timestamp",
			state: "unchanged",
			signer: { commonName: "tsa signer" }
		})
	})

	it("cannot check a Brainpool signature", async () => {
		expect(await only("approval-brainpool.pdf")).toMatchObject({ state: "unverifiable", unverifiableReason: "algorithm" })
	})

	it.each([
		["tampered-in-range.pdf", "digestMismatch"],
		["gap-wider-than-contents.pdf", "contentsGap"],
		["range-not-at-eof.pdf", "notAtRevisionEnd"],
		["two-signer-infos.pdf", "signerCount"],
		["sha1.pdf", "weakDigest"],
		["rsa1024.pdf", "weakKey"],
		["wrapping.pdf", "contentsGap"]
	])("%s is invalid (%s)", async (name, reason) => {
		expect(await only(name)).toMatchObject({ state: "invalid", invalidReason: reason })
	})

	it("rejects a signature dictionary a later revision redefined", async () => {
		const signature = await only("isa-redefined-sig.pdf")

		expect(signature.state).toBe("invalid")
		expect(["byteRange", "dictionaryChanged"]).toContain(signature.invalidReason)
	})

	it.each([
		["certified-p1.pdf", 1],
		["certified-p2.pdf", 2],
		["certified-p3.pdf", 3]
	])("%s certifies at level %i", async (name, level) => {
		expect(await only(name)).toMatchObject({ state: "unchanged", certification: level })
	})

	it.each([
		["approval-filled.pdf", true, ["form"]],
		["approval-annotated.pdf", true, ["annotation"]],
		["approval-content-changed.pdf", false, ["content"]],
		["certified-p1-filled.pdf", false, ["form"]],
		["certified-p2-filled.pdf", true, ["form"]],
		["certified-p3-filled.pdf", true, ["form"]],
		["certified-p1-annotated.pdf", false, ["annotation"]],
		["certified-p2-annotated.pdf", false, ["annotation"]],
		["certified-p3-annotated.pdf", true, ["annotation"]],
		["fieldmdp-locked-filled.pdf", false, ["form"]],
		["shadow-hide-replace.pdf", false, ["content"]],
		["appended-without-xref.pdf", false, ["content"]]
	])("%s changed after signing (allowed: %s)", async (name, allowed, kinds) => {
		const signature = await only(name)

		expect(signature.state).toBe("changed")
		expect(signature.changes).toEqual({ allowed, kinds })
		expect(signature.signedLength).toBeLessThan(fixture(name).length)
	})

	it("judges each of two signatures against what came after it", async () => {
		const report = await verifyBytes(fixture("two-signatures.pdf"))
		const [first, second] = report.signatures

		expect(report.revisions).toBe(4)
		expect(first).toMatchObject({
			field: "Signature1",
			state: "changed",
			changes: { allowed: true, kinds: ["signature"] },
			revision: 2
		})
		expect(second).toMatchObject({ field: "Signature2", state: "unchanged", algorithm: "ECDSA P-256", revision: 4 })
	})

	it("opens the signed revision as a byte prefix that verifies unchanged", async () => {
		const bytes = fixture("approval-content-changed.pdf")
		const { signedLength } = await only("approval-content-changed.pdf")
		const report = await verifyBytes(bytes.slice(0, signedLength))

		expect(report.signatures[0]?.state).toBe("unchanged")
	})

	it("trusts nothing when a second parser sees other signature fields", async () => {
		const bytes = fixture("approval-rsa.pdf")
		const range = (await verifyBytes(bytes)).signatures[0]?.signedLength ?? 0
		const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 })
		const document = await task.promise
		const hints = pdfSignatureFields(await document.getSignatures()) ?? []
		const agree = await verifyBytes(bytes, { expectedFields: hints })
		const differ = await verifyBytes(bytes, { expectedFields: [...hints, { name: "Hidden", byteRange: [0, 1, 3, 1] }] })
		const moved = await verifyBytes(bytes, {
			expectedFields: hints.map(hint => ({ ...hint, byteRange: [0, 1, 3, range - 3] as const }))
		})
		const unknown = await verifyBytes(bytes, { expectedFields: null })

		await task.destroy()
		expect(unknown.signatures[0]).toMatchObject({ state: "unverifiable", unverifiableReason: "parserMismatch" })

		expect(agree.signatures[0]?.state).toBe("unchanged")
		expect(differ.signatures[0]).toMatchObject({ state: "unverifiable", unverifiableReason: "parserMismatch" })
		expect(moved.signatures[0]).toMatchObject({ state: "unverifiable", unverifiableReason: "parserMismatch" })
	})

	it("reads failures as unverifiable, never valid", async () => {
		const bytes = fixture("approval-rsa.pdf")
		const document = new mupdf.PDFDocument(bytes)
		const report = await verifyPdfSignatures(
			document,
			{ length: bytes.length, read: () => Promise.reject(new Error("offline")) },
			{
				subtle: nodeSubtle,
				createDigest: createPdfDigest,
				openRevision: length => new mupdf.PDFDocument(bytes.slice(0, length))
			}
		)

		expect(report.signatures[0]).toMatchObject({ state: "unverifiable", unverifiableReason: "readFailed" })
	})

	// pdf.js reads the same fields from every fixture, so the cross-check passes on honest files.
	it.each(readdirSync(new URL("fixtures/pdfsign/", import.meta.url)).filter(name => name.endsWith(".pdf")))(
		"pdf.js agrees on %s",
		async name => {
			const bytes = fixture(name)
			const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 })
			const document = await task.promise
			const expectedFields = pdfSignatureFields(await document.getSignatures())

			await task.destroy()

			const report = await verifyBytes(bytes, { expectedFields })

			expect(report.signatures.every(signature => signature.unverifiableReason !== "parserMismatch")).toBe(true)
		}
	)
})
