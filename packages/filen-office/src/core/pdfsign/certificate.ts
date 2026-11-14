import * as asn1js from "asn1js"
import type { Certificate, RelativeDistinguishedNames } from "pkijs"
import { derOf } from "./cms"
import { equalBytes } from "./source"
import type { PdfCertificateInfo } from "./types"

// Certificate details shown with a signature. Display only: nothing here establishes trust (no trust list, no
// revocation), and the chain is just the issuers found among the signature's own certificates.

const NAMES = new Map([
	["2.5.4.3", "CN"],
	["2.5.4.6", "C"],
	["2.5.4.7", "L"],
	["2.5.4.8", "ST"],
	["2.5.4.10", "O"],
	["2.5.4.11", "OU"],
	["2.5.4.5", "SERIALNUMBER"],
	["2.5.4.4", "SN"],
	["2.5.4.42", "GN"],
	["1.2.840.113549.1.9.1", "E"],
	["2.5.4.97", "organizationIdentifier"]
])

const MAX_CHAIN = 16

function attributeText(value: unknown): string {
	if (value instanceof asn1js.BaseStringBlock) return value.getValue()
	if (value instanceof asn1js.BaseBlock) return value.toString("ascii")

	return ""
}

function rdnText(name: RelativeDistinguishedNames): string {
	return name.typesAndValues
		.map(item => `${NAMES.get(item.type) ?? item.type}=${attributeText(item.value).replace(/([,+"\\<>;])/g, "\\$1")}`)
		.reverse()
		.join(", ")
}

function rdnValue(name: RelativeDistinguishedNames, type: string): string | null {
	const found = name.typesAndValues.find(item => item.type === type)

	return found === undefined ? null : attributeText(found.value)
}

function hex(bytes: Uint8Array): string {
	let text = ""

	for (const byte of bytes) text += byte.toString(16).padStart(2, "0")

	return text.toUpperCase()
}

function sameName(a: RelativeDistinguishedNames, b: RelativeDistinguishedNames): boolean {
	return equalBytes(derOf(a.toSchema()), derOf(b.toSchema()))
}

export function certificateInfo(certificate: Certificate): PdfCertificateInfo {
	return {
		subject: rdnText(certificate.subject),
		issuer: rdnText(certificate.issuer),
		commonName: rdnValue(certificate.subject, "2.5.4.3"),
		organization: rdnValue(certificate.subject, "2.5.4.10"),
		serial: hex(certificate.serialNumber.valueBlock.valueHexView),
		notBefore: certificate.notBefore.value.getTime(),
		notAfter: certificate.notAfter.value.getTime(),
		selfSigned: sameName(certificate.subject, certificate.issuer)
	}
}

// The signer's certificate, then each issuer among `certificates` by name, stopping at a self-issued one or a loop.
export function certificateChain(signer: Certificate, certificates: readonly Certificate[]): Certificate[] {
	const chain = [signer]
	let current = signer

	while (chain.length < MAX_CHAIN && !sameName(current.subject, current.issuer)) {
		const issuer = certificates.find(cert => sameName(cert.subject, current.issuer) && !chain.includes(cert))

		if (issuer === undefined) break

		chain.push(issuer)
		current = issuer
	}

	return chain
}
