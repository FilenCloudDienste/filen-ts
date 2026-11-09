import { directoryBytes, isNotFoundError, opfsDirectory } from "@/lib/storage/opfs"
import type { AssistantModelManifest } from "@/features/assistant/runtime/manifest"

// The downloaded models live in OPFS under models/<manifest id>/, apart from every account's data: they hold
// nothing of the user's, so sign-out (lib/logout.ts) leaves them alone and the next account reuses them.
// Each shard keeps its published file name; VERIFIED_FILE records the shards whose sha256 matched, so a
// shard is trusted on its size and that record and is never re-read in full just to be listed.

export const MODELS_DIRECTORY = "models"

// Held by the tab that downloads or runs the model, and by anything else that removes model files.
export const MODEL_LOCK = "filen-assistant-model"

export const VERIFIED_FILE = "verified.json"

export function modelDirectory(manifestId: string): Promise<FileSystemDirectoryHandle> {
	return opfsDirectory([MODELS_DIRECTORY, manifestId])
}

export async function readVerified(directory: FileSystemDirectoryHandle): Promise<Map<string, string>> {
	try {
		const text = await (await (await directory.getFileHandle(VERIFIED_FILE)).getFile()).text()
		const value: unknown = JSON.parse(text)

		if (typeof value !== "object" || value === null) {
			return new Map()
		}

		return new Map(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
	} catch {
		// Missing or torn: nothing counts as verified, and the shards present are hashed again.
		return new Map()
	}
}

export interface ModelInspection {
	// Bytes on disk, verified or not (a resumed download continues from them).
	presentBytes: number
	verifiedBytes: number
	complete: boolean
}

// Sizes and the verified record only; reads no shard content.
export async function inspectModel(manifest: AssistantModelManifest): Promise<ModelInspection> {
	let directory: FileSystemDirectoryHandle

	try {
		directory = await (
			await navigator.storage.getDirectory()
		)
			.getDirectoryHandle(MODELS_DIRECTORY)
			.then(models => models.getDirectoryHandle(manifest.id))
	} catch (e) {
		if (isNotFoundError(e)) {
			return { presentBytes: 0, verifiedBytes: 0, complete: false }
		}

		throw e
	}

	const verified = await readVerified(directory)
	let presentBytes = 0
	let verifiedBytes = 0

	for (const shard of manifest.shards) {
		const size = await directory
			.getFileHandle(shard.file)
			.then(handle => handle.getFile())
			.then(
				file => file.size,
				() => 0
			)

		presentBytes += Math.min(size, shard.size)

		if (size === shard.size && verified.get(shard.file) === shard.sha256) {
			verifiedBytes += size
		}
	}

	return {
		presentBytes,
		verifiedBytes,
		complete: verifiedBytes === manifest.shards.reduce((sum, shard) => sum + shard.size, 0)
	}
}

// The models other than `id` on disk (one a newer build downloaded, or the one an update replaced), and the
// bytes they take. Sizes only; reads no file content. Which of the two they are, only the client can tell.
export async function otherModels(id: string): Promise<{ present: boolean; bytes: number }> {
	let models: FileSystemDirectoryHandle

	try {
		models = await (await navigator.storage.getDirectory()).getDirectoryHandle(MODELS_DIRECTORY)
	} catch (e) {
		if (isNotFoundError(e)) {
			return { present: false, bytes: 0 }
		}

		throw e
	}

	let present = false
	let bytes = 0

	for await (const [name, entry] of models.entries()) {
		if (name !== id) {
			present = true
			bytes += entry.kind === "file" ? (await entry.getFile()).size : await directoryBytes(entry)
		}
	}

	return { present, bytes }
}

// Removes one model's directory, whatever of it is on disk.
export async function deleteModelDirectory(id: string): Promise<void> {
	try {
		const models = await (await navigator.storage.getDirectory()).getDirectoryHandle(MODELS_DIRECTORY)

		await models.removeEntry(id, { recursive: true })
	} catch (e) {
		if (!isNotFoundError(e)) {
			throw e
		}
	}
}

// Removes every downloaded model except `keep` (an older model version after an update, or all of them).
export async function deleteModels(keep: string | null = null): Promise<void> {
	let models: FileSystemDirectoryHandle

	try {
		models = await (await navigator.storage.getDirectory()).getDirectoryHandle(MODELS_DIRECTORY)
	} catch (e) {
		if (isNotFoundError(e)) {
			return
		}

		throw e
	}

	const names: string[] = []

	for await (const name of models.keys()) {
		if (name !== keep) {
			names.push(name)
		}
	}

	for (const name of names) {
		await models.removeEntry(name, { recursive: true })
	}
}
