import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	createSessionVault,
	isSessionBlob,
	SESSION_BLOB_MAX_LENGTH,
	vaultFile,
	vaultMode,
	type VaultCipher,
	type VaultFile
} from "../main/sessionVault.ts"

const BLOB = JSON.stringify({
	email: "user@example.com",
	userId: "$bigint:123456789012345678n",
	rootUuid: "root-uuid",
	authInfo: "auth-info",
	privateKey: "private-key",
	apiKey: "api-key",
	authVersion: 2
})

// Reversible and visibly not plain text, so a test can tell an encrypted write from a plain one.
function fakeCipher(): VaultCipher & { shouldReEncrypt: boolean; failDecrypt: boolean } {
	const cipher = {
		shouldReEncrypt: false,
		failDecrypt: false,
		encrypt: (plain: string) => Promise.resolve(Buffer.from(`enc:${plain}`)),
		decrypt: (encrypted: Buffer) => {
			const text = encrypted.toString()

			if (cipher.failDecrypt || !text.startsWith("enc:")) {
				return Promise.reject(new Error("decrypt failed"))
			}

			return Promise.resolve({ result: text.slice(4), shouldReEncrypt: cipher.shouldReEncrypt })
		}
	}

	return cipher
}

function memoryFile(initial: Buffer | null = null): VaultFile & { data: Buffer | null; writes: number } {
	const file = {
		data: initial,
		writes: 0,
		read: () => Promise.resolve(file.data),
		write: (data: Buffer) => {
			file.data = data
			file.writes++

			return Promise.resolve()
		},
		remove: () => {
			file.data = null

			return Promise.resolve()
		}
	}

	return file
}

describe("isSessionBlob", () => {
	it("accepts the envelope JSON of a session", () => {
		expect(isSessionBlob(BLOB)).toBe(true)
	})

	it("rejects non-strings, broken JSON, wrong shapes and oversized payloads", () => {
		expect(isSessionBlob(42)).toBe(false)
		expect(isSessionBlob({})).toBe(false)
		expect(isSessionBlob("{")).toBe(false)
		expect(isSessionBlob(JSON.stringify({ email: "a" }))).toBe(false)
		expect(isSessionBlob(BLOB.replace("$bigint:123456789012345678n", "123"))).toBe(false)
		expect(isSessionBlob(BLOB.slice(0, -1) + `,"pad":"${"x".repeat(SESSION_BLOB_MAX_LENGTH)}"}`)).toBe(false)
	})
})

describe("vaultMode", () => {
	it("keeps the session in memory on Linux basic_text or without encryption", () => {
		expect(vaultMode("linux", "basic_text", true)).toBe("memory")
		expect(vaultMode("linux", "gnome_libsecret", true)).toBe("encrypted")
		expect(vaultMode("darwin", "", true)).toBe("encrypted")
		expect(vaultMode("win32", "", false)).toBe("memory")
	})
})

describe("createSessionVault", () => {
	const warn = vi.fn<(message: string) => void>()

	it("reports absent when no file exists", async () => {
		const vault = createSessionVault(() => Promise.resolve(fakeCipher()), memoryFile(), warn)

		await expect(vault.get()).resolves.toEqual({ status: "absent" })
	})

	it("encrypts on set, reads back and caches the decrypted session", async () => {
		const cipher = fakeCipher()
		const decrypt = vi.spyOn(cipher, "decrypt")
		const file = memoryFile()

		await createSessionVault(() => Promise.resolve(cipher), file, warn).set(BLOB)
		expect(file.data?.toString()).toBe(`enc:${BLOB}`)

		const fresh = createSessionVault(() => Promise.resolve(cipher), file, warn)

		await expect(fresh.get()).resolves.toEqual({ status: "present", blob: BLOB })
		await expect(fresh.get()).resolves.toEqual({ status: "present", blob: BLOB })
		expect(decrypt).toHaveBeenCalledTimes(1)
	})

	it("reports unreadable on decrypt failure, keeps the file and retries on the next get", async () => {
		const cipher = fakeCipher()
		const file = memoryFile(Buffer.from(`enc:${BLOB}`))
		const vault = createSessionVault(() => Promise.resolve(cipher), file, warn)

		cipher.failDecrypt = true
		await expect(vault.get()).resolves.toEqual({ status: "unreadable" })
		expect(file.data?.toString()).toBe(`enc:${BLOB}`)
		expect(warn.mock.calls.flat().join(" ")).not.toContain("private-key")

		cipher.failDecrypt = false
		await expect(vault.get()).resolves.toEqual({ status: "present", blob: BLOB })
	})

	it("reports unreadable when the file cannot be read", async () => {
		const file = memoryFile()

		file.read = () => Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }))

		await expect(createSessionVault(() => Promise.resolve(fakeCipher()), file, warn).get()).resolves.toEqual({
			status: "unreadable"
		})
	})

	it("reports unreadable while the encryption probe fails and retries it", async () => {
		const probe = vi.fn<() => Promise<VaultCipher | null>>().mockRejectedValueOnce(new Error("probe")).mockResolvedValue(fakeCipher())
		const vault = createSessionVault(probe, memoryFile(Buffer.from(`enc:${BLOB}`)), warn)

		await expect(vault.get()).resolves.toEqual({ status: "unreadable" })
		await expect(vault.get()).resolves.toEqual({ status: "present", blob: BLOB })
	})

	it("treats a decrypted non-session as absent without deleting it", async () => {
		const file = memoryFile(Buffer.from("enc:garbage"))

		await expect(createSessionVault(() => Promise.resolve(fakeCipher()), file, warn).get()).resolves.toEqual({ status: "absent" })
		expect(file.data?.toString()).toBe("enc:garbage")
	})

	it("re-encrypts when the cipher asks for it", async () => {
		const cipher = fakeCipher()
		const file = memoryFile(Buffer.from(`enc:${BLOB}`))

		cipher.shouldReEncrypt = true
		await createSessionVault(() => Promise.resolve(cipher), file, warn).get()
		expect(file.writes).toBe(1)
	})

	it("clear forgets the session and removes the file", async () => {
		const file = memoryFile()
		const vault = createSessionVault(() => Promise.resolve(fakeCipher()), file, warn)

		await vault.set(BLOB)
		await vault.clear()
		expect(file.data).toBeNull()
		await expect(vault.get()).resolves.toEqual({ status: "absent" })
	})

	it("clear forgets the session for this run even when the file cannot be removed", async () => {
		const file = memoryFile()
		const vault = createSessionVault(() => Promise.resolve(fakeCipher()), file, warn)

		await vault.set(BLOB)
		file.remove = () => Promise.reject(new Error("busy"))
		await expect(vault.clear()).rejects.toThrow("busy")
		await expect(vault.get()).resolves.toEqual({ status: "absent" })
	})

	it("a failed set rejects and keeps the previous session", async () => {
		const cipher = fakeCipher()
		const file = memoryFile()
		const vault = createSessionVault(() => Promise.resolve(cipher), file, warn)

		await vault.set(BLOB)
		cipher.encrypt = () => Promise.reject(new Error("locked"))
		await expect(vault.set(BLOB.replace("api-key", "new-key"))).rejects.toThrow("locked")
		await expect(vault.get()).resolves.toEqual({ status: "present", blob: BLOB })
	})

	it("runs operations in order so a clear cannot interleave with a set", async () => {
		const file = memoryFile()
		const vault = createSessionVault(() => Promise.resolve(fakeCipher()), file, warn)

		const set = vault.set(BLOB)
		const clear = vault.clear()

		await Promise.all([set, clear])
		expect(file.data).toBeNull()
		await expect(vault.get()).resolves.toEqual({ status: "absent" })
	})

	describe("memory only", () => {
		it("keeps the session in memory, never writes, and leaves an older file unread until replaced", async () => {
			const file = memoryFile(Buffer.from(`enc:${BLOB}`))
			const vault = createSessionVault(() => Promise.resolve(null), file, warn)

			await expect(vault.get()).resolves.toEqual({ status: "absent" })
			expect(file.data).not.toBeNull()

			await vault.set(BLOB)
			expect(file.writes).toBe(0)
			expect(file.data).toBeNull()
			await expect(vault.get()).resolves.toEqual({ status: "present", blob: BLOB })

			await vault.clear()
			await expect(vault.get()).resolves.toEqual({ status: "absent" })
		})
	})
})

describe("vaultFile", () => {
	let directory: string

	beforeEach(async () => {
		directory = await mkdtemp(path.join(tmpdir(), "filen-vault-"))
	})

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true })
	})

	it("reads null when missing, writes atomically with owner-only permissions, and removes idempotently", async () => {
		const target = path.join(directory, "session.vault")
		const file = vaultFile(target)

		await expect(file.read()).resolves.toBeNull()

		await writeFile(target, "old")
		await file.write(Buffer.from("new"))
		expect(await readFile(target, "utf8")).toBe("new")
		await expect(stat(`${target}.tmp`)).rejects.toThrow()

		if (process.platform !== "win32") {
			expect((await stat(target)).mode & 0o777).toBe(0o600)
		}

		await file.remove()
		await file.remove()
		await expect(file.read()).resolves.toBeNull()
	})
})
