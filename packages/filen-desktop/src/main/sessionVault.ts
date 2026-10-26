import { type } from "arktype"
import { sessionEnvelopeSchema } from "@filen/shared/session"
import type { SessionRead } from "../shared/channels.ts"
import { errorCode, type AtomicFile } from "./atomicFile.ts"

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

// Resolves the cipher once and shares it; a failed probe is retried by the next call instead of being replayed for the
// rest of the run.
export function lazyCipher(probe: () => Promise<VaultCipher | null>): () => Promise<VaultCipher | null> {
	let resolved: Promise<VaultCipher | null> | null = null

	return () => {
		if (resolved === null) {
			const attempt = probe()

			resolved = attempt
			void attempt.catch(() => {
				if (resolved === attempt) {
					resolved = null
				}
			})
		}

		return resolved
	}
}

export interface SessionVault {
	get(): Promise<SessionRead>
	set(blob: string): Promise<void>
	clear(): Promise<void>
}

// `cipher` resolves once, lazily (safeStorage only works after app ready); null keeps the session in memory only.
// Operations run one at a time so a clear can never land between a set's write and rename. The decrypted session is
// cached: it is read once per launch and changes only through this vault. Errors never carry the session.
export function createSessionVault(
	cipher: () => Promise<VaultCipher | null>,
	file: AtomicFile,
	warn: (message: string) => void
): SessionVault {
	const currentCipher = lazyCipher(cipher)
	// undefined: not read yet.
	let cached: string | null | undefined
	let tail: Promise<unknown> = Promise.resolve()

	function serial<T>(operation: () => Promise<T>): Promise<T> {
		const run = tail.then(operation, operation)

		tail = run.catch(() => undefined)

		return run
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
