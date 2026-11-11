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

// safeStorage on Linux: "keyring" encrypts with the Secret Service's key ("v11") and reads what the fallback key
// encrypted too, asking for a re-encryption; "fallback" is Chromium's hardcoded key ("v10"), which cannot read the
// keyring's.
export function linuxCipher(key: "keyring" | "fallback"): VaultCipher {
	const prefix = key === "keyring" ? "v11" : "v10"

	return {
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
}

function fsError(code: string, at: string): Error {
	return Object.assign(new Error(`${code}: ${at}`), { code })
}

type MemoryFsOp = "rename" | "link" | "unlink" | "mkdir" | "open" | "stat"

// A CommitFs over in-memory paths (exact strings, no normalization). `fail` can throw for one op and path before the
// op runs; `sizes` answers stat.
export function memoryFs(files: readonly string[] = [], dirs: readonly string[] = []) {
	const state = {
		files: new Set(files),
		dirs: new Set(dirs),
		sizes: new Map<string, number>(),
		fail: (_op: MemoryFsOp, _path: string): Error | undefined => undefined
	}
	// Runs an op as the real promise API does: a throw becomes a rejection.
	const settle = <T>(run: () => T): Promise<T> =>
		new Promise<T>(resolve => {
			resolve(run())
		})
	const taken = (at: string) => state.files.has(at) || state.dirs.has(at)
	const check = (op: MemoryFsOp, at: string) => {
		const error = state.fail(op, at)

		if (error !== undefined) {
			throw error
		}
	}
	const fs = {
		rename: (from: string, to: string) =>
			settle(() => {
				check("rename", to)

				if (!state.files.has(from)) {
					throw fsError("ENOENT", from)
				}

				state.files.delete(from)
				state.files.add(to)
			}),
		link: (existing: string, target: string) =>
			settle(() => {
				check("link", target)

				if (!state.files.has(existing)) {
					throw fsError("ENOENT", existing)
				}

				if (taken(target)) {
					throw fsError("EEXIST", target)
				}

				state.files.add(target)
			}),
		unlink: (at: string) =>
			settle(() => {
				check("unlink", at)

				if (!state.files.delete(at)) {
					throw fsError("ENOENT", at)
				}
			}),
		mkdir: (at: string) =>
			settle(() => {
				check("mkdir", at)

				if (taken(at)) {
					throw fsError("EEXIST", at)
				}

				state.dirs.add(at)
			}),
		open: (at: string) =>
			settle(() => {
				check("open", at)

				if (taken(at)) {
					throw fsError("EEXIST", at)
				}

				state.files.add(at)

				return { close: () => Promise.resolve() }
			}),
		stat: (at: string) =>
			settle(() => {
				check("stat", at)

				if (!taken(at)) {
					throw fsError("ENOENT", at)
				}

				return { size: state.sizes.get(at) ?? 0 }
			})
	}

	return { fs, state, error: fsError }
}
