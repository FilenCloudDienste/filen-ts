import { createPrivateKey, KeyObject, randomBytes, X509Certificate } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { isIP, SocketAddress } from "node:net"
import path from "node:path"
import type { DesktopServeProtocol } from "@filen/shared/desktop"
import { atomicFile } from "../atomicFile.ts"

// Self-signed certificates for the https servers, one per protocol. Read with Node's own X509Certificate; only the
// generation needs @peculiar/x509 (on WebCrypto), loaded the first time a certificate is made, with the Reflect
// polyfill its dependency injection needs.

// What browsers accept for a leaf certificate's lifetime.
export const CERTIFICATE_DAYS = 397
// A certificate this close to expiry is made anew.
export const RENEW_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

// Every certificate covers loopback, whatever address the server listens on.
const LOOPBACK = ["localhost", "127.0.0.1", "::1"]

// An every-interface certificate names at most this many addresses besides loopback: the current ones, then the
// stored certificate's most recent others, so a machine moving between known networks keeps one certificate. Each one
// is visible to every client of the server, hence the bound.
export const RECENT_ADDRESSES = 8

const ECDSA = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" }

export interface ServeCertificate {
	// File paths, as rclone takes them.
	cert: string
	key: string
	// SHA-256, as colon-separated hex, for the user to compare.
	fingerprint: string
}

export interface EnsuredCertificate extends ServeCertificate {
	// A stored certificate was replaced, so clients that trusted it must trust the new one.
	regenerated: boolean
}

// The names a certificate must cover: loopback and the given hosts; "every interface" addresses name no host.
export function certificateHosts(hosts: readonly string[]): string[] {
	return [...new Set([...LOOPBACK, ...hosts.filter(host => host !== "0.0.0.0" && host !== "::")])]
}

function covers(cert: X509Certificate, host: string): boolean {
	return (isIP(host) === 0 ? cert.checkHost(host) : cert.checkIP(host)) !== undefined
}

// The stored pair, when it can still serve: it parses, the key is the certificate's and it is not about to expire.
function serves(certPem: Buffer | null, keyPem: Buffer | null, now: number): X509Certificate | null {
	if (certPem === null || keyPem === null) {
		return null
	}

	try {
		const cert = new X509Certificate(certPem)

		return cert.checkPrivateKey(createPrivateKey(keyPem)) && cert.validToDate.getTime() - now > RENEW_DAYS * DAY_MS ? cert : null
	} catch {
		return null
	}
}

// One spelling per address: the certificate reads IPv6 back expanded and upper case.
function canonicalIp(address: string): string {
	return new SocketAddress({ address, family: isIP(address) === 6 ? "ipv6" : "ipv4" }).address
}

// `wanted`, then the stored certificate's other IP addresses in its order (generate writes the current ones first),
// up to RECENT_ADDRESSES besides loopback.
function withRecent(wanted: readonly string[], stored: X509Certificate): string[] {
	const current = new Set(wanted.map(host => (isIP(host) === 0 ? host : canonicalIp(host))))
	const room = RECENT_ADDRESSES - (wanted.length - LOOPBACK.length)

	if (room <= 0) {
		return [...wanted]
	}

	const carried = (stored.subjectAltName ?? "")
		.split(", ")
		.flatMap(entry => {
			const address = entry.startsWith("IP Address:") ? entry.slice("IP Address:".length) : ""

			return isIP(address) === 0 ? [] : [canonicalIp(address)]
		})
		.filter(address => !current.has(address))

	return [...wanted, ...carried.slice(0, room)]
}

async function generate(hosts: readonly string[], now: number): Promise<{ cert: string; key: string }> {
	await import("reflect-metadata")

	const {
		BasicConstraintsExtension,
		ExtendedKeyUsage,
		ExtendedKeyUsageExtension,
		KeyUsageFlags,
		KeyUsagesExtension,
		SubjectAlternativeNameExtension,
		X509CertificateGenerator
	} = await import("@peculiar/x509")
	const keys = await crypto.subtle.generateKey(ECDSA, true, ["sign", "verify"])
	const cert = await X509CertificateGenerator.createSelfSigned({
		serialNumber: randomBytes(16).toString("hex"),
		name: "CN=Filen",
		// A clock slightly behind on the client still accepts it.
		notBefore: new Date(now - DAY_MS),
		notAfter: new Date(now + CERTIFICATE_DAYS * DAY_MS),
		signingAlgorithm: ECDSA,
		keys,
		extensions: [
			new BasicConstraintsExtension(false, undefined, true),
			new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
			new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth]),
			new SubjectAlternativeNameExtension(hosts.map(host => ({ type: isIP(host) === 0 ? "dns" : "ip", value: host })))
		]
	})
	const key = KeyObject.from(keys.privateKey).export({ type: "pkcs8", format: "pem" })

	return { cert: cert.toString("pem"), key: typeof key === "string" ? key : key.toString("utf8") }
}

// The last call for each `<dir>/<protocol>`, which the next one waits for: two writers of one pair would interleave.
const pending = new Map<string, Promise<EnsuredCertificate>>()

// `<dir>/<protocol>.crt` and `.key` (owner-only), made anew when missing, unusable, within RENEW_DAYS of expiry, or
// not covering `hosts` (the address the server listens on; for every interface, the LAN addresses). With
// `keepRecent` (every interface), a usable stored certificate's other addresses carry over into the new one. Calls for
// one pair run one at a time.
export function ensureCertificate(
	dir: string,
	protocol: DesktopServeProtocol,
	hosts: readonly string[],
	now: number,
	keepRecent = false
): Promise<EnsuredCertificate> {
	const id = path.join(dir, protocol)
	const make = () => certificate(dir, protocol, hosts, now, keepRecent)
	const previous = pending.get(id)
	const run = previous === undefined ? make() : previous.then(make, make)
	const done = () => {
		if (pending.get(id) === run) {
			pending.delete(id)
		}
	}

	pending.set(id, run)
	void run.then(done, done)

	return run
}

async function certificate(
	dir: string,
	protocol: DesktopServeProtocol,
	hosts: readonly string[],
	now: number,
	keepRecent: boolean
): Promise<EnsuredCertificate> {
	const certFile = atomicFile(path.join(dir, `${protocol}.crt`))
	const keyFile = atomicFile(path.join(dir, `${protocol}.key`))
	const wanted = certificateHosts(hosts)
	const [certPem, keyPem] = await Promise.all([certFile.read(), keyFile.read()])
	const stored = serves(certPem, keyPem, now)
	let cert = stored !== null && wanted.every(host => covers(stored, host)) ? stored : null

	if (cert === null) {
		const made = await generate(keepRecent && stored !== null ? withRecent(wanted, stored) : wanted, now)

		await mkdir(dir, { recursive: true, mode: 0o700 })
		// A crash between the two writes leaves a pair whose key does not match, which the next call makes anew.
		await keyFile.write(Buffer.from(made.key))
		await certFile.write(Buffer.from(made.cert))
		cert = new X509Certificate(made.cert)
	}

	return {
		cert: path.join(dir, `${protocol}.crt`),
		key: path.join(dir, `${protocol}.key`),
		fingerprint: cert.fingerprint256,
		regenerated: certPem !== null && cert !== stored
	}
}
