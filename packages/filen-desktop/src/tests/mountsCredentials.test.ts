import { describe, expect, it, vi } from "vitest"
import { createCredentialStore, credentialsProblem, generateCredentials, type ServeCredentials } from "../main/mounts/credentials.ts"
import { s3AuthSchema, basicAuthSchema } from "../shared/nativeProtocol.ts"
import { fakeCipher, memoryFile } from "./fileFakes.ts"

function secretsOf(credentials: ServeCredentials): string[] {
	return credentials.kind === "basic" ? [credentials.password] : [credentials.accessKeyId, credentials.secretAccessKey]
}

describe("generateCredentials", () => {
	it("makes credentials rclone takes and the strength check keeps", () => {
		const basic = generateCredentials("webdav")
		const s3 = generateCredentials("s3")

		expect(basic.kind === "basic" && /^filen-[0-9a-f]{8}$/.test(basic.user) && basic.password.length === 43).toBe(true)
		expect(s3.kind === "s3" && s3.accessKeyId.length === 20 && s3.secretAccessKey.length === 40).toBe(true)
		expect(basicAuthSchema.allows(basic)).toBe(true)
		expect(s3AuthSchema.allows(s3)).toBe(true)
		expect(credentialsProblem(basic)).toBeNull()
		expect(credentialsProblem(s3)).toBeNull()
		expect(generateCredentials("ftp")).not.toEqual(generateCredentials("ftp"))
	})
})

describe("credentialsProblem", () => {
	it.each([
		[{ kind: "basic", user: "admin", password: "admin" }, "weak"],
		[{ kind: "basic", user: "bob", password: "short-pw" }, "weak"],
		[{ kind: "basic", user: "bob", password: "passwordpassword" }, "weak"],
		[{ kind: "basic", user: "bob", password: "aaaaaaaaaaaaaaaa" }, "weak"],
		[{ kind: "basic", user: "correcthorsebattery", password: "CorrectHorseBattery" }, "weak"],
		[{ kind: "basic", user: "bob", password: "with:colon-in-it" }, "invalid"],
		[{ kind: "basic", user: "", password: "correct horse battery staple" }, "invalid"],
		[{ kind: "s3", accessKeyId: "admin", secretAccessKey: "admin" }, "invalid"],
		[{ kind: "s3", accessKeyId: "AKIA0123456789ABCDEF", secretAccessKey: "with,comma-in-the-secret" }, "invalid"],
		[{ kind: "basic", user: "bob", password: "correct horse battery staple" }, null],
		[{ kind: "s3", accessKeyId: "AKIA0123456789ABCDEF", secretAccessKey: "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY" }, null]
	] satisfies [ServeCredentials, "weak" | "invalid" | null][])("%j is %s", (credentials, problem) => {
		expect(credentialsProblem(credentials)).toBe(problem)
	})
})

describe("createCredentialStore", () => {
	it("credentials never written in plain text", async () => {
		const file = memoryFile()
		const store = createCredentialStore(file, () => Promise.resolve(fakeCipher()), vi.fn())
		const webdav = await store.ensure("webdav")
		const s3 = await store.ensure("s3")

		expect(await store.ensure("webdav")).toEqual(webdav)
		expect(file.writes).toBe(2)

		const written = file.data?.toString() ?? ""

		expect(written.startsWith("enc:")).toBe(true)

		for (const secret of [...secretsOf(webdav), ...secretsOf(s3), webdav.kind === "basic" ? webdav.user : ""]) {
			expect(written).not.toContain(secret)
		}

		// A new run reads them back.
		const again = createCredentialStore(file, () => Promise.resolve(fakeCipher()), vi.fn())

		expect(await again.get("s3")).toEqual(s3)
		expect(await again.get("ftp")).toBeNull()
	})

	it("regenerate changes both parts", async () => {
		const store = createCredentialStore(memoryFile(), () => Promise.resolve(fakeCipher()), vi.fn())

		for (const protocol of ["sftp", "s3"] as const) {
			const before = await store.ensure(protocol)
			const after = await store.regenerate(protocol)
			const [beforeName, beforeSecret] =
				before.kind === "basic" ? [before.user, before.password] : [before.accessKeyId, before.secretAccessKey]
			const [afterName, afterSecret] =
				after.kind === "basic" ? [after.user, after.password] : [after.accessKeyId, after.secretAccessKey]

			expect(afterName).not.toBe(beforeName)
			expect(afterSecret).not.toBe(beforeSecret)
			expect(await store.get(protocol)).toEqual(after)
		}
	})

	it("without secure storage they last for this run and nothing is written", async () => {
		const file = memoryFile()
		const store = createCredentialStore(file, () => Promise.resolve(null), vi.fn())
		const http = await store.ensure("http")

		expect(await store.ensure("http")).toEqual(http)
		expect(await store.persistent()).toBe(false)
		expect(file.writes).toBe(0)
	})

	it("an undecryptable file is never overwritten and is read again later", async () => {
		const cipher = fakeCipher()
		const file = memoryFile()
		const store = createCredentialStore(file, () => Promise.resolve(cipher), vi.fn())
		const kept = await store.ensure("restic")

		cipher.failDecrypt = true

		const locked = createCredentialStore(file, () => Promise.resolve(cipher), vi.fn())

		await expect(locked.ensure("restic")).rejects.toThrow("credentialsUnreadable")
		await expect(locked.regenerate("restic")).rejects.toThrow("credentialsUnreadable")
		expect(file.writes).toBe(1)
		cipher.failDecrypt = false
		expect(await locked.ensure("restic")).toEqual(kept)
	})

	it("refuses credentials of the wrong kind", async () => {
		const store = createCredentialStore(memoryFile(), () => Promise.resolve(fakeCipher()), vi.fn())

		await expect(store.set("s3", generateCredentials("webdav"))).rejects.toThrow("credentialsKind")
	})
})
