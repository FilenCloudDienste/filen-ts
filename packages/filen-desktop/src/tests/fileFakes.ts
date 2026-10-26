import type { AtomicFile } from "../main/atomicFile.ts"
import type { VaultCipher } from "../main/sessionVault.ts"

// An AtomicFile in memory that counts its writes.
export function memoryFile(initial: Buffer | null = null): AtomicFile & { data: Buffer | null; writes: number } {
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

// Reversible and visibly not plain text (base64 behind a prefix), so a test can tell an encrypted write from a plain
// one and find no secret in it.
export function fakeCipher(): VaultCipher & { failDecrypt: boolean } {
	const cipher = {
		failDecrypt: false,
		encrypt: (plain: string) => Promise.resolve(Buffer.from(`enc:${Buffer.from(plain).toString("base64")}`)),
		decrypt: (encrypted: Buffer) => {
			const text = encrypted.toString()

			if (cipher.failDecrypt || !text.startsWith("enc:")) {
				return Promise.reject(new Error("decrypt failed"))
			}

			return Promise.resolve({ result: Buffer.from(text.slice(4), "base64").toString(), shouldReEncrypt: false })
		}
	}

	return cipher
}
