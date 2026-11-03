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

// safeStorage on Linux as sessionCipher hands it out: "keyring" encrypts with the Secret Service's key ("v11") and reads
// what the fallback key encrypted too, asking for a re-encryption; "fallback" is memory mode on Chromium's hardcoded key
// ("v10", read-only), which cannot read the keyring's; "unprobed" is that key taken for secure storage, as builds did
// before the probe, which wrote what a later run finds.
export function linuxCipher(key: "keyring" | "fallback" | "unprobed"): VaultCipher {
	const prefix = key === "keyring" ? "v11" : "v10"
	const cipher: VaultCipher = {
		encrypt: plain => Promise.resolve(Buffer.from(`${prefix}${Buffer.from(plain).toString("base64")}`)),
		decrypt: encrypted => {
			const head = encrypted.subarray(0, 3).toString("latin1")

			if (head !== "v10" && !(head === "v11" && key === "keyring")) {
				return Promise.reject(new Error("decrypt failed"))
			}

			return Promise.resolve({
				result: Buffer.from(encrypted.subarray(3).toString(), "base64").toString(),
				shouldReEncrypt: head !== prefix
			})
		}
	}

	return key === "fallback" ? { ...cipher, readOnly: true } : cipher
}
