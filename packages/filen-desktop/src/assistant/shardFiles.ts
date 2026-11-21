import { createHash } from "node:crypto"
import { createReadStream, closeSync, fstatSync, fsyncSync, ftruncateSync, openSync, readSync, rmSync, statSync, writeSync } from "node:fs"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import type { ShardFile, ShardStore } from "@filen/shared/dom/assistantModel/download"
import type { AssistantModelFile, AssistantModelFiles } from "@filen/shared/dom/assistantModel/manifest"
import { checkpointName, readVerified, replaceVerified } from "./modelDir.ts"

// The shared download's store over plain files in the engine's process (synchronous calls, as on OPFS sync access
// handles; the process does nothing else meanwhile).

// A full disk raises the name the shared download maps to "storage-full", from the write itself.
function writeError(error: unknown): unknown {
	const code = (error as NodeJS.ErrnoException | null)?.code

	if (code === "ENOSPC" || code === "EDQUOT") {
		const quota = new Error("Storage is full")

		quota.name = "QuotaExceededError"

		return quota
	}

	return error
}

class FdFile implements ShardFile {
	private readonly fd: number

	constructor(fd: number) {
		this.fd = fd
	}

	getSize(): number {
		return fstatSync(this.fd).size
	}

	truncate(size: number): void {
		ftruncateSync(this.fd, size)
	}

	read(buffer: Uint8Array, { at }: { at: number }): number {
		return readSync(this.fd, buffer, 0, buffer.length, at)
	}

	write(buffer: Uint8Array, { at }: { at: number }): number {
		try {
			return writeSync(this.fd, buffer, 0, buffer.length, at)
		} catch (error) {
			throw writeError(error)
		}
	}

	flush(): void {
		try {
			fsyncSync(this.fd)
		} catch (error) {
			throw writeError(error)
		}
	}
}

// Read and write at any offset, created owner-only when missing: "a" would append every write, "w" empty the file.
function openPositional(file: string): number {
	try {
		return openSync(file, "r+")
	} catch (error) {
		if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
			throw writeError(error)
		}

		return openSync(file, "w+", 0o600)
	}
}

function sizeOnDisk(file: string): number {
	try {
		return statSync(file).size
	} catch {
		return 0
	}
}

export interface EngineShardStore extends ShardStore {
	// Drops a shard that no longer matches: its file and its entry in the record.
	discard(shard: AssistantModelFile): void
}

function writeVerified(dir: string, verified: ReadonlyMap<string, string>): void {
	try {
		replaceVerified(dir, verified)
	} catch (error) {
		throw writeError(error)
	}
}

export async function shardStore(dir: string, model: AssistantModelFiles): Promise<EngineShardStore> {
	const verified = await readVerified(dir)
	const sizes = new Map(model.shards.map(shard => [shard.file, sizeOnDisk(path.join(dir, shard.file))]))

	return {
		isVerified: shard => sizes.get(shard.file) === shard.size && verified.get(shard.file) === shard.sha256,
		sizeOnDisk: shard => sizes.get(shard.file) ?? 0,
		markVerified: shard => {
			verified.set(shard.file, shard.sha256)
			sizes.set(shard.file, shard.size)
			writeVerified(dir, verified)

			return Promise.resolve()
		},
		discard: shard => {
			verified.delete(shard.file)
			sizes.set(shard.file, 0)
			writeVerified(dir, verified)
			rmSync(path.join(dir, shard.file), { force: true })
		},
		withFile: async (shard, run) => {
			const file = openPositional(path.join(dir, shard.file))
			let state: number

			try {
				state = openPositional(path.join(dir, checkpointName(shard)))
			} catch (error) {
				closeSync(file)

				throw error
			}

			let complete = false

			try {
				const result = await run(new FdFile(file), new FdFile(state))

				complete = fstatSync(state).size === 0

				return result
			} finally {
				closeSync(file)
				closeSync(state)

				if (complete) {
					rmSync(path.join(dir, checkpointName(shard)), { force: true })
				}
			}
		}
	}
}

export async function hashFile(file: string): Promise<string> {
	const hash = createHash("sha256")

	await pipeline(createReadStream(file), hash)

	return hash.digest("hex")
}
