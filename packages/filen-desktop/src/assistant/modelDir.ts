import { renameSync, writeFileSync } from "node:fs"
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises"
import path from "node:path"
import type { AssistantModelFile, AssistantModelFiles } from "@filen/shared/dom/assistantModel/manifest"

// The native engine's models: `<root>/<manifest id>/` holds the shards under their published names, each partial one
// with its hasher checkpoint beside it, and VERIFIED_FILE, the shards whose sha256 matched (the OPFS layout of the web
// runtime). A shard is trusted on its size and that record and never re-read just to be listed. Main lists and removes
// them; the engine's process downloads, verifies and loads them.

export const VERIFIED_FILE = "verified.json"

// The hasher state of a partial shard, beside it; gone once the shard is verified.
export function checkpointName(shard: AssistantModelFile): string {
	return `${shard.file}.sha256-state`
}

export function modelDir(root: string, id: string): string {
	return path.join(root, id)
}

function isNotFound(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | null)?.code === "ENOENT"
}

export async function readVerified(dir: string): Promise<Map<string, string>> {
	try {
		const value: unknown = JSON.parse(await readFile(path.join(dir, VERIFIED_FILE), "utf8"))

		if (typeof value !== "object" || value === null) {
			return new Map()
		}

		return new Map(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
	} catch {
		// Missing or torn: nothing counts as verified, and the shards present are hashed again.
		return new Map()
	}
}

// The record is replaced whole (written beside it, then renamed over it), so it is never torn. Synchronous: a few
// hundred bytes, written by one writer at a time (the engine's download, or main's import).
export function replaceVerified(dir: string, verified: ReadonlyMap<string, string>): void {
	const target = path.join(dir, VERIFIED_FILE)
	const staged = `${target}.tmp`

	writeFileSync(staged, JSON.stringify(Object.fromEntries(verified)), { mode: 0o600 })
	renameSync(staged, target)
}

export async function sizeOf(file: string): Promise<number> {
	try {
		return (await stat(file)).size
	} catch (error) {
		if (isNotFound(error)) {
			return 0
		}

		throw error
	}
}

export interface ModelInspection {
	// Bytes on disk, verified or not (a resumed download continues from them).
	presentBytes: number
	verifiedBytes: number
	complete: boolean
}

// Sizes and the verified record only; reads no shard content.
export async function inspectModel(root: string, model: AssistantModelFiles): Promise<ModelInspection> {
	const dir = modelDir(root, model.id)
	const verified = await readVerified(dir)
	let presentBytes = 0
	let verifiedBytes = 0
	let total = 0

	for (const shard of model.shards) {
		const size = await sizeOf(path.join(dir, shard.file))

		total += shard.size
		presentBytes += Math.min(size, shard.size)

		if (size === shard.size && verified.get(shard.file) === shard.sha256) {
			verifiedBytes += size
		}
	}

	return { presentBytes, verifiedBytes, complete: verifiedBytes === total }
}

async function treeBytes(target: string): Promise<number> {
	const info = await stat(target)

	if (!info.isDirectory()) {
		return info.size
	}

	let bytes = 0

	for (const entry of await readdir(target)) {
		bytes += await treeBytes(path.join(target, entry))
	}

	return bytes
}

async function entries(root: string): Promise<string[]> {
	try {
		return await readdir(root)
	} catch (error) {
		if (isNotFound(error)) {
			return []
		}

		throw error
	}
}

// The models other than `id` on disk (one an earlier version left), and the bytes they take.
export async function otherModels(root: string, id: string): Promise<{ present: boolean; bytes: number }> {
	let present = false
	let bytes = 0

	for (const name of await entries(root)) {
		if (name !== id) {
			present = true
			bytes += await treeBytes(path.join(root, name))
		}
	}

	return { present, bytes }
}

// Removes every model but `keep`.
export async function deleteModels(root: string, keep: string | null): Promise<void> {
	for (const name of await entries(root)) {
		if (name !== keep) {
			await rm(path.join(root, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
		}
	}
}

// Owner-only, as every directory the app keeps in userData.
export async function ensureModelDir(root: string, id: string): Promise<string> {
	const dir = modelDir(root, id)

	await mkdir(dir, { recursive: true, mode: 0o700 })

	return dir
}
