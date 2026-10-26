import { X509Certificate } from "node:crypto"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CERTIFICATE_DAYS, certificateHosts, ensureCertificate, RENEW_DAYS } from "../main/mounts/tls.ts"

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 26)

let dir: string

beforeEach(async () => {
	dir = path.join(await mkdtemp(path.join(tmpdir(), "filen-tls-")), "tls")
})

afterEach(async () => {
	await rm(path.dirname(dir), { recursive: true, force: true })
})

async function load(file: string): Promise<X509Certificate> {
	return new X509Certificate(await readFile(file))
}

describe("ensureCertificate", () => {
	it("certificate covers loopback and host", async () => {
		const made = await ensureCertificate(dir, "webdav", ["192.168.1.20"], NOW)
		const cert = await load(made.cert)

		for (const ip of ["127.0.0.1", "::1", "192.168.1.20"]) {
			expect(cert.checkIP(ip), ip).toBe(ip)
		}

		expect(cert.checkHost("localhost")).toBe("localhost")
		expect(cert.checkIP("192.168.1.21")).toBeUndefined()
		expect(cert.validToDate.getTime()).toBe(Math.floor((NOW + CERTIFICATE_DAYS * DAY_MS) / 1000) * 1000)
		expect(cert.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1")
		expect(made.fingerprint).toBe(cert.fingerprint256)
		expect(made.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)

		if (process.platform !== "win32") {
			expect((await stat(made.key)).mode & 0o777).toBe(0o600)
			expect((await stat(dir)).mode & 0o777).toBe(0o700)
		}
	})

	it("keeps a certificate that still serves", async () => {
		const first = await ensureCertificate(dir, "s3", ["127.0.0.1"], NOW)
		const again = await ensureCertificate(dir, "s3", ["localhost"], NOW + 300 * DAY_MS)

		expect(again).toEqual(first)
		expect((await ensureCertificate(dir, "http", [], NOW)).fingerprint).not.toBe(first.fingerprint)
	})

	it("is made anew near expiry, for another host, or when the key does not match", async () => {
		const first = await ensureCertificate(dir, "s3", [], NOW)
		const renewed = await ensureCertificate(dir, "s3", [], NOW + (CERTIFICATE_DAYS - RENEW_DAYS + 1) * DAY_MS)

		expect(renewed.fingerprint).not.toBe(first.fingerprint)

		const moved = await ensureCertificate(dir, "s3", ["10.0.0.5"], NOW + (CERTIFICATE_DAYS - RENEW_DAYS + 1) * DAY_MS)

		expect(moved.fingerprint).not.toBe(renewed.fingerprint)

		// A crash between the key and certificate writes leaves a key of another pair.
		const other = await ensureCertificate(dir, "http", [], NOW)
		const otherKey = await readFile(other.key)
		const { writeFile } = await import("node:fs/promises")

		await writeFile(moved.key, otherKey)
		expect((await ensureCertificate(dir, "s3", ["10.0.0.5"], NOW)).fingerprint).not.toBe(moved.fingerprint)
	})

	it("names no wildcard address", () => {
		expect(certificateHosts(["0.0.0.0", "::", "192.168.1.20", "127.0.0.1"])).toEqual(["localhost", "127.0.0.1", "::1", "192.168.1.20"])
	})
})
