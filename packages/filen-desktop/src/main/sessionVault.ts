import { open, readFile, rename, rm } from "node:fs/promises"
import { type } from "arktype"
import { sessionEnvelopeSchema } from "@filen/shared/session"
import type { SessionRead } from "../shared/channels.ts"

// A real session is a few KB (an RSA private key plus the master-key chain, ~65 bytes a key); this leaves room
// for thousands of keys and only stops an unbounded payload.
export const SESSION_BLOB_MAX_LENGTH = 1024 * 1024

// The shape check main does before storing what the renderer sent. Main never uses the keys; the web's resume is
// the real check.
export function isSessionBlob(value: unknown): value is string {
	if (typeof value !== "string" || value.length > SESSION_BLOB_MAX_LENGTH) {
		return false
	}

	try {
		return !(sessionEnvelopeSchema(JSON.parse(value)) instanceof type.errors)
	} catch {
		return false
	}
}

// Linux falls back to a hardcoded key when no keyring is recognised ("basic_text"), which protects nothing, so the
// session then stays in memory for this run (sign in each launch). Same when the OS offers no encryption at all.
export function vaultMode(platform: NodeJS.Platform, linuxBackend: string, encryptionAvailable: boolean): "encrypted" | "memory" {
	return encryptionAvailable && !(platform === "linux" && linuxBackend === "basic_text") ? "encrypted" : "memory"
}

export interface VaultCipher {
	encrypt(plain: string): Promise<Buffer>
	decrypt(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
}

export interface VaultFile {
	// null when the file does not exist; any other read error throws.
	read(): Promise<Buffer | null>
	write(data: Buffer): Promise<void>
	remove(): Promise<void>
}

export interface SessionVault {
	get(): Promise<SessionRead>
	set(blob: string): Promise<void>
	clear(): Promise<void>
}

function errorCode(error: unknown): string {
	return error instanceof Error ? ((error as NodeJS.ErrnoException).code ?? error.name) : "unknown"
}

// The file is written to a sibling and renamed over the old one, so a crash mid-write never leaves half a vault.
export function vaultFile(file: string): VaultFile {
	return {
		read: async () => {
			try {
				return await readFile(file)
			} catch (error) {
				if (errorCode(error) === "ENOENT") {
					return null
				}

				throw error
			}
		},
		write: async data => {
			const temp = `${file}.tmp`
			const handle = await open(temp, "w", 0o600)

			try {
				await handle.writeFile(data)
				await handle.sync()
			} finally {
				await handle.close()
			}

			await rename(temp, file)
		},
		remove: () => rm(file, { force: true })
	}
}

// `cipher` resolves once, lazily (safeStorage only works after app ready); null keeps the session in memory only.
// Operations run one at a time so a clear can never land between a set's write and rename. The decrypted session is
// cached: it is read once per launch and changes only through this vault. Errors never carry the session.
export function createSessionVault(
	cipher: () => Promise<VaultCipher | null>,
	file: VaultFile,
	warn: (message: string) => void
): SessionVault {
	let resolvedCipher: Promise<VaultCipher | null> | null = null
	// undefined: not read yet.
	let cached: string | null | undefined
	let tail: Promise<unknown> = Promise.resolve()

	function serial<T>(operation: () => Promise<T>): Promise<T> {
		const run = tail.then(operation, operation)

		tail = run.catch(() => undefined)

		return run
	}

	function currentCipher(): Promise<VaultCipher | null> {
		if (resolvedCipher === null) {
			const attempt = cipher()

			resolvedCipher = attempt
			// A failed probe is retried by the next call instead of being replayed for the rest of the run.
			void attempt.catch(() => {
				if (resolvedCipher === attempt) {
					resolvedCipher = null
				}
			})
		}

		return resolvedCipher
	}

	async function load(active: VaultCipher): Promise<SessionRead> {
		let data: Buffer | null

		try {
			data = await file.read()
		} catch (error) {
			warn(`session vault unreadable: ${errorCode(error)}`)

			return { status: "unreadable" }
		}

		if (data === null) {
			cached = null

			return { status: "absent" }
		}

		let decrypted: { result: string; shouldReEncrypt: boolean }

		try {
			decrypted = await active.decrypt(data)
		} catch (error) {
			// Locked keychain, changed desktop environment or a damaged file: the file stays for a later retry.
			warn(`session vault could not be decrypted: ${errorCode(error)}`)

			return { status: "unreadable" }
		}

		// Decrypted but not a session: no retry can fix it, so it counts as absent. The next sign-in overwrites it.
		if (!isSessionBlob(decrypted.result)) {
			warn("session vault holds no valid session; ignoring it")
			cached = null

			return { status: "absent" }
		}

		cached = decrypted.result

		if (decrypted.shouldReEncrypt) {
			try {
				await file.write(await active.encrypt(decrypted.result))
			} catch (error) {
				warn(`session vault re-encryption failed: ${errorCode(error)}`)
			}
		}

		return { status: "present", blob: decrypted.result }
	}

	return {
		get: () =>
			serial(async (): Promise<SessionRead> => {
				if (cached !== undefined) {
					return cached === null ? { status: "absent" } : { status: "present", blob: cached }
				}

				let active: VaultCipher | null

				try {
					active = await currentCipher()
				} catch (error) {
					warn(`session vault encryption unavailable: ${errorCode(error)}`)

					return { status: "unreadable" }
				}

				if (active === null) {
					cached = null

					return { status: "absent" }
				}

				return load(active)
			}),
		set: blob =>
			serial(async () => {
				const active = await currentCipher()

				if (active === null) {
					cached = blob

					// A vault file left from an encrypted run holds an older session this one supersedes.
					await file.remove().catch((error: unknown) => {
						warn(`stale session vault removal failed: ${errorCode(error)}`)
					})

					return
				}

				await file.write(await active.encrypt(blob))
				cached = blob
			}),
		clear: () =>
			serial(async () => {
				// Forgotten for this run even if the file cannot be removed; the web retries the clear on next boot.
				cached = null
				await file.remove()
			})
	}
}
