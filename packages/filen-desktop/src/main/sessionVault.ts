import { type } from "arktype"
import { parseSessionBlob, sessionEnvelopeSchema } from "@filen/shared/session"
import { SESSION_BLOB_MAX_LENGTH, type SessionRead } from "../shared/channels.ts"
import { errorCode, type AtomicFile } from "./atomicFile.ts"
import { serialQueue } from "../shared/serial.ts"

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

// The userId digits of a stored session blob, or null when it is not a session.
export function sessionUserId(blob: string): string | null {
	return parseSessionBlob(blob)?.userId.toString() ?? null
}

// The prefix of Chromium's Linux ciphertext under its hardcoded fallback key ("v11" is the keyring's key).
const FALLBACK_KEY_PREFIX = "v10"

// Whether `data` was encrypted with Chromium's Linux fallback key, which protects nothing.
export function fallbackKeyEncrypted(data: Buffer): boolean {
	return data.subarray(0, FALLBACK_KEY_PREFIX.length).toString("latin1") === FALLBACK_KEY_PREFIX
}

// Linux falls back to a hardcoded key when no keyring is recognised ("basic_text"), and silently, with the backend still
// reported as the keyring's, when the Secret Service is missing or locked or its prompt was dismissed (`fallbackKey`: a
// probe encrypted with "v10"). Either protects nothing, so the session then stays in memory for this run (sign in each
// launch). Same when the OS offers no encryption at all.
export function vaultMode(
	platform: NodeJS.Platform,
	linuxBackend: string,
	encryptionAvailable: boolean,
	fallbackKey: boolean
): "encrypted" | "memory" {
	return encryptionAvailable && !(platform === "linux" && (linuxBackend === "basic_text" || fallbackKey)) ? "encrypted" : "memory"
}

export interface VaultCipher {
	encrypt(plain: string): Promise<Buffer>
	decrypt(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
	// Memory mode on Linux's fallback key: the cipher only reads what was encrypted with that key (by a run that took it
	// for secure storage), so nobody is locked out of it; nothing is stored with it, and a run with the keyring's key
	// re-encrypts it.
	readOnly?: true
}

// The cipher to store with: null in memory mode.
export function storingCipher(cipher: VaultCipher | null): VaultCipher | null {
	return cipher?.readOnly === true ? null : cipher
}

// The cipher that reads `data` this run: null in memory mode, unless `data` was encrypted with the fallback key.
export function readingCipher(cipher: VaultCipher | null, data: Buffer): VaultCipher | null {
	return cipher?.readOnly === true && !fallbackKeyEncrypted(data) ? null : cipher
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

// Removes `file` only when it exists, is not `plain` (data that needs no key) and `cipher` cannot decrypt it (null: a
// run without secure storage, which decrypts only what the fallback key encrypted); a failed read or removal rejects.
export async function removeIfUndecryptable(
	file: AtomicFile,
	cipher: VaultCipher | null,
	plain: (data: Buffer) => boolean = () => false
): Promise<boolean> {
	const data = await file.read()

	if (data === null || plain(data)) {
		return false
	}

	const reader = readingCipher(cipher, data)
	const undecryptable =
		reader === null ||
		(await reader.decrypt(data).then(
			() => false,
			() => true
		))

	if (undecryptable) {
		await file.remove()
	}

	return undecryptable
}

export interface SessionVault {
	get(): Promise<SessionRead>
	set(blob: string): Promise<void>
	clear(): Promise<void>
	// Like get, but a session that still cannot be decrypted is removed and reads as absent. A failed file read keeps it.
	discardUnreadable(): Promise<SessionRead>
}

// `cipher` resolves once, lazily (safeStorage only works after app ready); null (or a read-only one) keeps the session
// in memory only, and a file an encrypted run left is never read or replaced then: it reads as unreadable (its keyring
// may come back) and goes only by a clear or a discard. A file encrypted with Linux's fallback key is still read then,
// and goes once a new session replaces it. Operations run one at a time so a clear can never land between a set's write and rename. The decrypted session is
// cached: it is read once per launch and changes only through this vault. Errors never carry the session.
export function createSessionVault(
	cipher: () => Promise<VaultCipher | null>,
	file: AtomicFile,
	warn: (message: string) => void
): SessionVault {
	const currentCipher = lazyCipher(cipher)
	// undefined: not read yet.
	let cached: string | null | undefined
	const serial = serialQueue()

	async function load(cipher: VaultCipher | null, discard: boolean): Promise<SessionRead> {
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

		const active = readingCipher(cipher, data)

		if (active === null) {
			if (!discard) {
				warn("session vault: a session stored with secure storage is kept until it is available again")

				return { status: "unreadable" }
			}

			await file.remove()
			cached = null
			warn("session vault: removed the session stored with secure storage")

			return { status: "absent" }
		}

		let decrypted: { result: string; shouldReEncrypt: boolean }

		try {
			decrypted = await active.decrypt(data)
		} catch (error) {
			// Locked keychain, changed desktop environment or a damaged file: the file stays for a later retry.
			warn(`session vault could not be decrypted: ${errorCode(error)}`)

			if (!discard) {
				return { status: "unreadable" }
			}

			await file.remove()
			cached = null
			warn("session vault: removed the undecryptable session")

			return { status: "absent" }
		}

		// Decrypted but not a session: no retry can fix it, so it counts as absent. The next sign-in overwrites it.
		if (!isSessionBlob(decrypted.result)) {
			warn("session vault holds no valid session; ignoring it")
			cached = null

			return { status: "absent" }
		}

		cached = decrypted.result

		const writer = storingCipher(active)

		if (decrypted.shouldReEncrypt && writer !== null) {
			try {
				await file.write(await writer.encrypt(decrypted.result))
			} catch (error) {
				warn(`session vault re-encryption failed: ${errorCode(error)}`)
			}
		}

		return { status: "present", blob: decrypted.result }
	}

	function read(discard: boolean): Promise<SessionRead> {
		return serial(async (): Promise<SessionRead> => {
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

			return load(active, discard)
		})
	}

	return {
		get: () => read(false),
		discardUnreadable: () => read(true),
		set: blob =>
			serial(async () => {
				const cipher = await currentCipher()
				const active = storingCipher(cipher)

				// A file an encrypted run left stays for when its keyring is back; one encrypted with the fallback key
				// holds a session this one replaces.
				if (active === null) {
					const data = await file.read().catch(() => null)

					if (data !== null && readingCipher(cipher, data) !== null) {
						await file.remove()
					}

					cached = blob

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
