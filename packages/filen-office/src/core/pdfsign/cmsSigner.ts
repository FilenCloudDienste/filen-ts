import * as asn1js from "asn1js"
import { SignerInfo } from "pkijs"
import { TIMESTAMP_TOKEN_OID } from "./algorithms"
import { certificateInfo } from "./certificate"
import { derOf, parseCms, parseTimestampToken, signingTime } from "./cms"

// Who signed a CMS SignedData and when it says so, for a code signature shown beside a file (an Authenticode or Mach-O
// signature). Display only: nothing is verified, no chain or revocation is checked (that would contact servers).

export interface CmsSignerSummary {
	// RFC 4514-style distinguished names.
	readonly subject: string
	readonly issuer: string
	readonly commonName: string | null
	readonly organization: string | null
	// Epoch ms: the signing-time attribute, else a timestamp token's or a countersignature's time; null when none.
	readonly signedAt: number | null
}

// RFC 3161 tokens: CMS's own attribute, and Authenticode's.
const TIMESTAMP_TOKENS: ReadonlySet<string> = new Set([TIMESTAMP_TOKEN_OID, "1.3.6.1.4.1.311.3.3.1"])
const COUNTER_SIGNATURE = "1.2.840.113549.1.9.6"

function unsignedTime(signer: SignerInfo): number | null {
	for (const attribute of signer.unsignedAttrs?.attributes ?? []) {
		const value: unknown = attribute.values[0]

		if (!(value instanceof asn1js.BaseBlock)) continue

		if (TIMESTAMP_TOKENS.has(attribute.type)) {
			const token = parseTimestampToken(derOf(value))

			if ("info" in token) return token.info.genTime.getTime()
		} else if (attribute.type === COUNTER_SIGNATURE) {
			try {
				const time = signingTime(new SignerInfo({ schema: value }))

				if (time !== null) return time
			} catch {
				// A countersignature that is no SignerInfo says nothing.
			}
		}
	}

	return null
}

// The signer of `der`; null when it is no single-signer SignedData or carries no signer certificate.
export function cmsSigner(der: Uint8Array): CmsSignerSummary | null {
	const parsed = parseCms(der)

	if (!parsed.ok || parsed.cms.signerCertificate === null) {
		return null
	}

	const info = certificateInfo(parsed.cms.signerCertificate)

	return {
		subject: info.subject,
		issuer: info.issuer,
		commonName: info.commonName,
		organization: info.organization,
		signedAt: signingTime(parsed.cms.signer) ?? unsignedTime(parsed.cms.signer)
	}
}
