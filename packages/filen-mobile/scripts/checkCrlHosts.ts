// Fails when a CRL distribution point of Filen's live certificates is not on the cleartext allowlist of
// the generated Android network security config. Android's platform TLS verifier fetches CRLs over plain
// HTTP; a host missing from the allowlist makes every certificate it covers look revoked.
//
// Needs network (Filen's endpoints and the rustls-platform-verifier AAR), so it is not part of
// `pnpm test`: run it with `pnpm run check:crl-hosts`.

import { X509Certificate } from "node:crypto"
import path from "node:path"
import tls from "node:tls"
import { isHostCovered, parseCleartextDomains } from "../plugins/rustlsPlatformVerifier"
import { generateNetworkSecurityConfig } from "../plugins/withAndroidNetworkSecurityConfig"

export const FILEN_HOSTS = ["gateway.filen.io", "ingest.filen.io", "egest.filen.io", "socket.filen.io"]

const CONNECT_TIMEOUT_MS = 15_000
// id-ce-cRLDistributionPoints (2.5.29.31), DER-encoded with its tag and length.
const CRL_DISTRIBUTION_POINTS_OID = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x1f])
// GeneralName uniformResourceIdentifier: [6] IMPLICIT IA5String.
const URI_TAG = 0x86
const BOOLEAN_TAG = 0x01
const OCTET_STRING_TAG = 0x04

type Tlv = { tag: number; contentStart: number; end: number }

function readTlv(der: Uint8Array, offset: number): Tlv {
	const tag = der[offset]
	let length = der[offset + 1]
	let contentStart = offset + 2

	if (tag === undefined || length === undefined) {
		throw new Error("Truncated DER")
	}

	if (length & 0x80) {
		const lengthBytes = length & 0x7f

		length = 0

		for (let i = 0; i < lengthBytes; i++) {
			length = length * 256 + (der[contentStart + i] ?? 0)
		}

		contentStart += lengthBytes
	}

	const end = contentStart + length

	if (end > der.length) {
		throw new Error("DER length out of range")
	}

	return { tag, contentStart, end }
}

function collectUris(der: Uint8Array, start: number, end: number, out: string[]): void {
	let offset = start

	while (offset < end) {
		const tlv = readTlv(der, offset)

		if (tlv.tag === URI_TAG) {
			out.push(Buffer.from(der.subarray(tlv.contentStart, tlv.end)).toString("ascii"))
		} else if (tlv.tag & 0x20) {
			collectUris(der, tlv.contentStart, tlv.end, out)
		}

		offset = tlv.end
	}
}

/** The URIs in a certificate's CRL distribution points extension (empty when it has none). */
export function crlDistributionPoints(certificateDer: Uint8Array): string[] {
	const der = Buffer.from(certificateDer)
	const uris: string[] = []
	let index = der.indexOf(CRL_DISTRIBUTION_POINTS_OID)

	while (index !== -1) {
		let offset = index + CRL_DISTRIBUTION_POINTS_OID.length
		let tlv = readTlv(der, offset)

		if (tlv.tag === BOOLEAN_TAG) {
			offset = tlv.end
			tlv = readTlv(der, offset)
		}

		if (tlv.tag === OCTET_STRING_TAG) {
			collectUris(der, tlv.contentStart, tlv.end, uris)
		}

		index = der.indexOf(CRL_DISTRIBUTION_POINTS_OID, index + 1)
	}

	return uris
}

function peerChain(host: string): Promise<X509Certificate[]> {
	return new Promise((resolve, reject) => {
		const socket = tls.connect({ host, port: 443, servername: host, timeout: CONNECT_TIMEOUT_MS }, () => {
			const chain: X509Certificate[] = []
			const seen = new Set<string>()
			let current: tls.DetailedPeerCertificate | undefined = socket.getPeerCertificate(true)

			while (current?.raw && !seen.has(current.fingerprint256)) {
				seen.add(current.fingerprint256)
				chain.push(new X509Certificate(current.raw))
				current = current.issuerCertificate
			}

			socket.end()
			resolve(chain)
		})

		socket.on("timeout", () => {
			socket.destroy(new Error(`${host}: TLS connect timed out`))
		})
		socket.on("error", reject)
	})
}

async function main(): Promise<void> {
	const projectRoot = path.resolve(__dirname, "..")
	const allowlist = parseCleartextDomains(await generateNetworkSecurityConfig(projectRoot))
	const uncovered = new Set<string>()
	let checked = 0

	for (const host of FILEN_HOSTS) {
		for (const certificate of await peerChain(host)) {
			for (const uri of crlDistributionPoints(certificate.raw)) {
				const crlHost = new URL(uri).hostname
				const covered = isHostCovered(crlHost, allowlist)

				checked++
				console.log(`${covered ? "ok     " : "MISSING"} ${host}: ${certificate.subject.replace(/\n/g, ", ")} -> ${uri}`)

				if (!covered) {
					uncovered.add(crlHost)
				}
			}
		}
	}

	if (checked === 0) {
		throw new Error("No CRL distribution points found on any Filen certificate; the check would prove nothing.")
	}

	if (uncovered.size > 0) {
		throw new Error(`CRL hosts missing from the generated network security config: ${[...uncovered].join(", ")}`)
	}

	console.log(`All ${checked} CRL distribution points are covered.`)
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(__filename)) {
	main().catch((e: unknown) => {
		console.error(e instanceof Error ? e.message : e)
		process.exit(1)
	})
}
