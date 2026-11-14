import { parseByteRange, readContentsGap, signedEnd, type ByteRange } from "./byteRange"
import { certificateChain, certificateInfo } from "./certificate"
import {
	OID,
	parseCms,
	parseTimestampToken,
	signatureTimestamp,
	signingTime,
	verifyCms,
	verifyTimestampToken,
	type PdfCryptoDeps
} from "./cms"
import { digestBytes, digestRanges, readExactly, type PdfByteSource } from "./source"
import { asciiBytes, indexOf, latin1 } from "./syntax"
import type { PdfCertificateInfo, PdfDigestName, PdfSignatureInvalidReason } from "./types"
import { endsRevision, xrefEntry, type XrefChain, type XrefSection } from "./xref"

// The checks of one signature that need only the raw bytes: where its signed bytes are, that they are exactly what
// it covers, and that the CMS signature over them verifies.

export interface SignatureLocation {
	// /ByteRange as read (numbers, unvalidated).
	readonly byteRange: readonly unknown[]
	// The indirect object holding the signature dictionary, or the field holding it directly; null when neither is an
	// indirect object (then the dictionary's location cannot be proven).
	readonly dictionaryNum: number | null
}

export type IntegrityResult =
	| {
			readonly ok: true
			readonly range: ByteRange
			readonly der: Uint8Array
			// Sections written after the signed revision, newest first.
			readonly later: readonly XrefSection[]
			// 1-based revision the signature closes.
			readonly revision: number
	  }
	| { readonly ok: false; readonly reason: PdfSignatureInvalidReason }

const MAX_DICTIONARY_BYTES = 1024 * 1024
const REVISION_TAIL = 1024
const ENDOBJ = asciiBytes("endobj")

export async function checkIntegrity(source: PdfByteSource, chain: XrefChain, location: SignatureLocation): Promise<IntegrityResult> {
	const range = parseByteRange(location.byteRange, source.length)

	if (range === null) return { ok: false, reason: "byteRange" }

	const der = await readContentsGap(source, range)

	if (der === null) return { ok: false, reason: "contentsGap" }

	const end = signedEnd(range)
	const tailStart = Math.max(0, end - REVISION_TAIL)
	const tail = await readExactly(source, tailStart, end - tailStart)

	if (!endsRevision(tail, tailStart, end, chain)) return { ok: false, reason: "notAtRevisionEnd" }

	const later = chain.sections.filter(section => section.offset >= end)

	if (location.dictionaryNum === null || !(await dictionaryInPlace(source, chain, later, location.dictionaryNum, range))) {
		return { ok: false, reason: "dictionaryChanged" }
	}

	return { ok: true, range, der, later, revision: chain.sections.length - later.length }
}

// The dictionary's object starts before the gap and has not ended at it ("N G obj ... /Contents <gap"), and no later
// revision rewrote it: the signed bytes are the ones a reader shows for it.
async function dictionaryInPlace(
	source: PdfByteSource,
	chain: XrefChain,
	later: readonly XrefSection[],
	num: number,
	range: ByteRange
): Promise<boolean> {
	if (later.some(section => section.entries.has(num))) return false

	const entry = xrefEntry(chain, num)

	if (entry?.type !== 1 || entry.offset >= range[1] || range[1] - entry.offset > MAX_DICTIONARY_BYTES) return false

	const bytes = await readExactly(source, entry.offset, range[1] - entry.offset)
	const header = /^(\d+)\s+(\d+)\s+obj\b/.exec(latin1(bytes.subarray(0, 32)))

	return header !== null && Number(header[1]) === num && Number(header[2]) === entry.gen && indexOf(bytes, ENDOBJ) < 0
}

export type ContentsResult =
	| {
			readonly state: "valid"
			readonly algorithm: string
			readonly digest: PdfDigestName
			readonly signer: PdfCertificateInfo | null
			readonly chain: readonly PdfCertificateInfo[]
			readonly signingTime: number | null
			readonly timestampTime: number | null
	  }
	| {
			readonly state: "invalid"
			readonly reason: PdfSignatureInvalidReason
			readonly signer: PdfCertificateInfo | null
			readonly digest: PdfDigestName | null
	  }
	| { readonly state: "unverifiable"; readonly signer: PdfCertificateInfo | null; readonly digest: PdfDigestName | null }

const SIGNATURE_SUBFILTERS = new Set(["adbe.pkcs7.detached", "ETSI.CAdES.detached"])
const TIMESTAMP_SUBFILTER = "ETSI.RFC3161"
// SHA-1-only formats.
const WEAK_SUBFILTERS = new Set(["adbe.pkcs7.sha1", "adbe.x509.rsa_sha1"])

export function signatureKind(subFilter: string | null): "signature" | "timestamp" | PdfSignatureInvalidReason {
	if (subFilter === TIMESTAMP_SUBFILTER) return "timestamp"
	if (subFilter !== null && SIGNATURE_SUBFILTERS.has(subFilter)) return "signature"
	if (subFilter !== null && WEAK_SUBFILTERS.has(subFilter)) return "weakDigest"

	return "unsupportedSubFilter"
}

// Streams the signed ranges through the signer's digest and verifies the CMS signature (or timestamp token).
export async function checkContents(
	source: PdfByteSource,
	range: ByteRange,
	der: Uint8Array,
	kind: "signature" | "timestamp",
	deps: PdfCryptoDeps,
	signal?: { readonly aborted: boolean }
): Promise<ContentsResult> {
	const ranges: readonly (readonly [number, number])[] = [
		[range[0], range[1]],
		[range[2], range[3]]
	]

	if (kind === "timestamp") {
		const token = parseTimestampToken(der)

		if ("ok" in token)
			return token.state === "invalid"
				? { state: "invalid", reason: token.reason, signer: null, digest: null }
				: { state: "unverifiable", signer: null, digest: null }

		const signerCert = token.cms.signerCertificate
		const signer = signerCert === null ? null : certificateInfo(signerCert)
		const digests = await digestRanges(source, ranges, [token.imprintDigest], deps.createDigest, signal)
		const verdict = await verifyTimestampToken(token, digests.get(token.imprintDigest) ?? new Uint8Array(0), deps)
		const digest = token.cms.digest === "weak" ? null : token.cms.digest

		if (!verdict.ok)
			return verdict.state === "invalid"
				? { state: "invalid", reason: verdict.reason, signer, digest }
				: { state: "unverifiable", signer, digest }

		return {
			state: "valid",
			algorithm: verdict.algorithm,
			digest: token.imprintDigest,
			signer,
			chain: signerCert === null ? [] : certificateChain(signerCert, token.cms.certificates).map(certificateInfo),
			signingTime: null,
			timestampTime: token.info.genTime.getTime()
		}
	}

	const parsed = parseCms(der)

	if (!parsed.ok)
		return parsed.state === "invalid"
			? { state: "invalid", reason: parsed.reason, signer: null, digest: null }
			: { state: "unverifiable", signer: null, digest: null }

	const { cms } = parsed
	const signerCert = cms.signerCertificate
	const signer = signerCert === null ? null : certificateInfo(signerCert)
	const digest = cms.digest === "weak" ? null : cms.digest

	if (cms.contentType !== OID.data || cms.content !== null) return { state: "invalid", reason: "notDetached", signer, digest }
	if (cms.digest === "weak") return { state: "invalid", reason: "weakDigest", signer, digest }
	if (cms.digest === null) return { state: "unverifiable", signer, digest }

	const digests = await digestRanges(source, ranges, [cms.digest], deps.createDigest, signal)
	const verdict = await verifyCms(cms, digests.get(cms.digest) ?? new Uint8Array(0), deps)

	if (!verdict.ok)
		return verdict.state === "invalid"
			? { state: "invalid", reason: verdict.reason, signer, digest }
			: { state: "unverifiable", signer, digest }

	return {
		state: "valid",
		algorithm: verdict.algorithm,
		digest: cms.digest,
		signer,
		chain: signerCert === null ? [] : certificateChain(signerCert, cms.certificates).map(certificateInfo),
		signingTime: signingTime(cms.signer),
		timestampTime: await signatureTimestampTime(cms.signer, deps)
	}
}

// The time of a valid signature-timestamp token over the signature value. An unsigned attribute is not covered by the
// signature, so a token that does not verify is ignored rather than failing the signature.
async function signatureTimestampTime(signer: Parameters<typeof signatureTimestamp>[0], deps: PdfCryptoDeps): Promise<number | null> {
	const der = signatureTimestamp(signer)

	if (der === null) return null

	const token = parseTimestampToken(der)

	if ("ok" in token) return null

	const imprint = await digestBytes(signer.signature.valueBlock.valueHexView, token.imprintDigest, deps.createDigest)
	const verdict = await verifyTimestampToken(token, imprint, deps)

	return verdict.ok ? token.info.genTime.getTime() : null
}
