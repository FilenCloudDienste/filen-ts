import { createPrivateKey, generateKeyPairSync, X509Certificate } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { CERTIFICATE_DAYS, certificateHosts, ensureCertificate, RECENT_ADDRESSES, RENEW_DAYS } from "../main/mounts/tls.ts"

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 26)

let dir: string
// One s3 pair made at NOW, and a key of another pair. Each generation costs two fsync'd writes, which a loaded runner
// stretches to seconds, so the tests that only need a stored pair to start from copy these bytes instead of making one.
let seeded: { cert: Buffer; key: Buffer; fingerprint: string }
let otherKey: string

beforeAll(async () => {
	const seedDir = path.join(await mkdtemp(path.join(tmpdir(), "filen-tls-seed-")), "tls")

	try {
		const made = await ensureCertificate(seedDir, "s3", [], NOW)

		seeded = { cert: await readFile(made.cert), key: await readFile(made.key), fingerprint: made.fingerprint }
	} finally {
		await rm(path.dirname(seedDir), { recursive: true, force: true })
	}

	otherKey = generateKeyPairSync("ec", {
		namedCurve: "prime256v1",
		publicKeyEncoding: { type: "spki", format: "pem" },
		privateKeyEncoding: { type: "pkcs8", format: "pem" }
	}).privateKey
})

async function seed(key: Buffer | string = seeded.key): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o700 })
	await writeFile(path.join(dir, "s3.crt"), seeded.cert)
	await writeFile(path.join(dir, "s3.key"), key)
}

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
		expect(made.regenerated).toBe(false)

		if (process.platform !== "win32") {
			expect((await stat(made.key)).mode & 0o777).toBe(0o600)
			expect((await stat(dir)).mode & 0o777).toBe(0o700)
		}
	})

	it("keeps a certificate that still serves", async () => {
		await seed()

		const kept = await ensureCertificate(dir, "s3", ["127.0.0.1"], NOW)
		const again = await ensureCertificate(dir, "s3", ["localhost"], NOW + 300 * DAY_MS)

		expect(kept.fingerprint).toBe(seeded.fingerprint)
		expect(kept.regenerated).toBe(false)
		expect(again).toEqual(kept)
		expect((await ensureCertificate(dir, "http", [], NOW)).fingerprint).not.toBe(kept.fingerprint)
	})

	it("is made anew near expiry", async () => {
		await seed()

		const renewed = await ensureCertificate(dir, "s3", [], NOW + (CERTIFICATE_DAYS - RENEW_DAYS + 1) * DAY_MS)

		expect(renewed.fingerprint).not.toBe(seeded.fingerprint)
		expect(renewed.regenerated).toBe(true)
	})

	it("is made anew for another host", async () => {
		await seed()

		const moved = await ensureCertificate(dir, "s3", ["10.0.0.5"], NOW)

		expect(moved.fingerprint).not.toBe(seeded.fingerprint)
		expect(moved.regenerated).toBe(true)
		expect((await load(moved.cert)).checkIP("10.0.0.5")).toBe("10.0.0.5")

		// One explicit address: the previous one is not carried over.
		const again = await ensureCertificate(dir, "s3", ["10.0.0.6"], NOW)

		expect((await load(again.cert)).checkIP("10.0.0.5")).toBeUndefined()
	})

	it("every interface keeps one certificate across known networks", async () => {
		const home = ["127.0.0.1", "192.168.1.20", "0.0.0.0"]
		const work = ["127.0.0.1", "10.0.0.5", "0.0.0.0"]
		const first = await ensureCertificate(dir, "webdav", home, NOW, true)
		const moved = await ensureCertificate(dir, "webdav", work, NOW, true)
		const back = await ensureCertificate(dir, "webdav", home, NOW, true)
		const cert = await load(back.cert)

		expect(moved.fingerprint).not.toBe(first.fingerprint)
		expect(moved.regenerated).toBe(true)
		expect(back).toEqual({ ...moved, regenerated: false })
		expect(cert.checkIP("192.168.1.20")).toBe("192.168.1.20")
		expect(cert.checkIP("10.0.0.5")).toBe("10.0.0.5")
	})

	it("every interface carries at most RECENT_ADDRESSES addresses, the newest first", async () => {
		const old = Array.from({ length: RECENT_ADDRESSES }, (_, index) => `10.0.0.${index + 1}`)

		await ensureCertificate(dir, "webdav", old, NOW, true)

		const made = await ensureCertificate(dir, "webdav", ["192.168.1.20"], NOW, true)
		const cert = await load(made.cert)

		expect(cert.checkIP("192.168.1.20")).toBe("192.168.1.20")
		expect(old.filter(ip => cert.checkIP(ip) !== undefined)).toEqual(old.slice(0, -1))
	})

	it("every interface carries nothing from a certificate near expiry", async () => {
		const later = NOW + (CERTIFICATE_DAYS - RENEW_DAYS + 1) * DAY_MS

		await ensureCertificate(dir, "webdav", ["10.0.0.5"], NOW, true)

		const made = await ensureCertificate(dir, "webdav", ["192.168.1.20"], later, true)

		expect((await load(made.cert)).checkIP("10.0.0.5")).toBeUndefined()
	})

	it("is made anew when the key does not match", async () => {
		// A crash between the key and certificate writes leaves a key of another pair.
		await seed(otherKey)

		const remade = await ensureCertificate(dir, "s3", [], NOW)

		expect(remade.fingerprint).not.toBe(seeded.fingerprint)
	})

	it("concurrent calls for one protocol make one pair", async () => {
		const [first, second] = await Promise.all([
			ensureCertificate(dir, "webdav", ["10.0.0.5"], NOW),
			ensureCertificate(dir, "webdav", ["10.0.0.5"], NOW)
		])
		const cert = await load(first.cert)

		expect(second.fingerprint).toBe(first.fingerprint)
		expect(cert.fingerprint256).toBe(first.fingerprint)
		expect(cert.checkPrivateKey(createPrivateKey(await readFile(first.key)))).toBe(true)
	})

	it("names no wildcard address", () => {
		expect(certificateHosts(["0.0.0.0", "::", "192.168.1.20", "127.0.0.1"])).toEqual(["localhost", "127.0.0.1", "::1", "192.168.1.20"])
	})
})
