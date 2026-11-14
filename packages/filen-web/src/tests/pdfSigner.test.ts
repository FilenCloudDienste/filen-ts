import { readFileSync } from "node:fs"
import { webcrypto } from "node:crypto"
import { describe, expect, it } from "vitest"
import { checkContents } from "@filen/office/core/pdfsign"
import { createPdfDigest } from "@filen/office/dom/pdfedit/digest"
import { createPdfSignerApi, PDF_SIGNER_MAX_BYTES } from "@/features/pdf/workers/pdfSignerCore"
import {
	certificateValidity,
	certifyLevel,
	isCertificateFileName,
	signatureStampLines,
	signerDisplayName
} from "@/features/pdf/signing/signing.logic"

// The signer worker's core with Node's WebCrypto, over the office package's OpenSSL-made PKCS#12 fixtures.

const p12 = (name: string): Blob =>
	new Blob([readFileSync(new URL(`../../../filen-office/src/tests/fixtures/pdfsign/p12/${name}.p12`, import.meta.url))])

const stamp = {
	signedBy: (name: string) => `Signed by ${name}`,
	date: (date: string) => `Date ${date}`,
	reason: (reason: string) => `Reason ${reason}`
}

describe("pdf signer core", () => {
	it("unlocks a container read from a file and signs digests the verifier accepts", async () => {
		const api = createPdfSignerApi(webcrypto.subtle)

		expect(await api.unlock("fixture-password")).toEqual({ ok: false, reason: "notLoaded" })
		expect(await api.load({ kind: "file", file: p12("p256") })).toEqual({ ok: true })
		expect(await api.unlock("wrong")).toEqual({ ok: false, reason: "password" })

		const unlocked = await api.unlock("fixture-password")

		if (!unlocked.ok) throw new Error(unlocked.reason)

		expect(unlocked.summary).toMatchObject({ digest: "SHA-256", algorithm: "ECDSA P-256", signer: { commonName: "p256 signer" } })
		expect(unlocked.summary.chain.map(cert => cert.commonName)).toEqual(["p256 signer", "Fixture Signing Root"])

		// The signed ranges of a 10-byte "file": [0, 4) and [6, 10).
		const file = new Uint8Array(10).map((_, i) => i * 3)
		const hasher = await createPdfDigest("SHA-256")

		hasher.update(file.subarray(0, 4))
		hasher.update(file.subarray(6))

		const cms = await api.sign(hasher.digest())
		const source = {
			length: file.length,
			read: (offset: number, length: number) => Promise.resolve(file.slice(offset, offset + length))
		}

		expect(
			await checkContents(source, [0, 4, 6, 4], cms, "signature", { subtle: webcrypto.subtle, createDigest: createPdfDigest })
		).toMatchObject({ state: "valid", algorithm: "ECDSA P-256", signer: { commonName: "p256 signer" } })
	})

	it("reads legacy containers and refuses what it cannot sign with", async () => {
		const api = createPdfSignerApi(webcrypto.subtle)

		await api.load({ kind: "file", file: p12("legacy-rc2") })
		expect((await api.unlock("fixture-password")).ok).toBe(true)

		await api.load({ kind: "file", file: p12("brainpool") })
		expect(await api.unlock("fixture-password")).toEqual({ ok: false, reason: "algorithm" })

		await api.load({ kind: "file", file: p12("mismatch") })
		expect(await api.unlock("fixture-password")).toEqual({ ok: false, reason: "keyMismatch" })

		expect(await api.load({ kind: "file", file: new Blob([new Uint8Array(PDF_SIGNER_MAX_BYTES + 1)]) })).toEqual({
			ok: false,
			reason: "tooLarge"
		})
		await expect(createPdfSignerApi(webcrypto.subtle).sign(new Uint8Array(32))).rejects.toThrow("locked")
	})
})

describe("signing choices", () => {
	const certificate = {
		subject: "CN=Ada, O=Example",
		issuer: "CN=Root",
		commonName: "Ada",
		organization: "Example",
		serial: "01",
		notBefore: 1000,
		notAfter: 2000,
		selfSigned: false
	}

	it("judges validity, names and levels", () => {
		expect(certificateValidity(certificate, 1500)).toBe("valid")
		expect(certificateValidity(certificate, 2001)).toBe("expired")
		expect(certificateValidity(certificate, 999)).toBe("notYetValid")
		expect(signerDisplayName({ ...certificate, commonName: null })).toBe("Example")
		expect(signerDisplayName({ ...certificate, commonName: null, organization: null })).toBe("CN=Ada, O=Example")
		expect([certifyLevel("none"), certifyLevel("1"), certifyLevel("2"), certifyLevel("3")]).toEqual([null, 1, 2, 3])
		expect(["a.p12", "B.PFX", "c.pem"].map(isCertificateFileName)).toEqual([true, true, false])
	})

	it("writes the stamp lines the appearance asks for", () => {
		const summary = { signer: certificate, chain: [certificate], digest: "SHA-256", algorithm: "RSA 2048", capacity: 1 } as const
		const options = { reason: "Approved", location: null, appearance: "details", certify: null } as const

		expect(signatureStampLines(summary, options, "today", stamp)).toEqual(["Signed by Ada", "Date today", "Reason Approved"])
		expect(signatureStampLines(summary, { ...options, appearance: "nameDate" }, "today", stamp)).toEqual([
			"Signed by Ada",
			"Date today"
		])
		expect(signatureStampLines(summary, { ...options, reason: null }, "today", stamp)).toEqual(["Signed by Ada", "Date today"])
	})
})
