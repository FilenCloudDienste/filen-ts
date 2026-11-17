import { describe, expect, it } from "vitest"
import * as asn1js from "asn1js"
import { Attribute, ContentInfo, SignedAndUnsignedAttributes, SignedData, SignerInfo } from "pkijs"
import { buildPdfCms, cmsSigner } from "../core/pdfsign"
import { loadIdentity, signingSubtle } from "./pdfSignCreateFixtures"

// Who signed a code signature's CMS and when it says so: the signing-time attribute, else a countersignature's time.

const SIGNING_TIME = "1.2.840.113549.1.9.5"
const COUNTER_SIGNATURE = "1.2.840.113549.1.9.6"
const SIGNED_AT = Date.UTC(2024, 2, 1, 12, 30, 0)

async function signedCms(): Promise<Uint8Array> {
	return await buildPdfCms(await loadIdentity("p256"), new Uint8Array(32), signingSubtle)
}

// The CMS with its signer changed by `edit` (nothing is re-signed: the summary verifies nothing).
function edited(der: Uint8Array, edit: (signer: SignerInfo) => void): Uint8Array {
	const info = ContentInfo.fromBER(new Uint8Array(der))
	const signedData = new SignedData({ schema: info.content })
	const signer = signedData.signerInfos[0]

	if (signer === undefined) throw new Error("no signer")

	edit(signer)

	return new Uint8Array(new ContentInfo({ contentType: info.contentType, content: signedData.toSchema(true) }).toSchema().toBER())
}

const timeAttribute = (): Attribute =>
	new Attribute({ type: SIGNING_TIME, values: [new asn1js.UTCTime({ valueDate: new Date(SIGNED_AT) })] })

describe("cmsSigner", () => {
	it("names the signer certificate's subject and issuer, without a time when none is given", async () => {
		const summary = cmsSigner(await signedCms())

		expect(summary?.subject).toMatch(/CN=/)
		expect(summary?.issuer).toMatch(/CN=/)
		expect(summary?.signedAt).toBeNull()
	})

	it("reads the signing-time attribute", async () => {
		const der = edited(await signedCms(), signer => {
			signer.signedAttrs?.attributes.push(timeAttribute())
		})

		expect(cmsSigner(der)?.signedAt).toBe(SIGNED_AT)
	})

	it("reads a countersignature's signing time", async () => {
		const original = await signedCms()
		const counter = ContentInfo.fromBER(new Uint8Array(original))
		const counterSigner = new SignedData({ schema: counter.content }).signerInfos[0]

		if (counterSigner === undefined) throw new Error("no signer")

		counterSigner.signedAttrs?.attributes.push(timeAttribute())

		const der = edited(original, signer => {
			signer.unsignedAttrs = new SignedAndUnsignedAttributes({
				type: 1,
				attributes: [new Attribute({ type: COUNTER_SIGNATURE, values: [counterSigner.toSchema()] })]
			})
		})

		expect(cmsSigner(der)?.signedAt).toBe(SIGNED_AT)
	})

	it("gives nothing for bytes that are no SignedData", () => {
		expect(cmsSigner(new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x01]))).toBeNull()
		expect(cmsSigner(new Uint8Array(0))).toBeNull()
	})
})
