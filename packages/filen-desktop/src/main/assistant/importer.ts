import { createHash, type Hash } from "node:crypto"
import { open, rm, type FileHandle } from "node:fs/promises"
import path from "node:path"
import type { DesktopAssistantImport, DesktopAssistantResult } from "@filen/shared/desktop"
import type { AssistantModelFile, AssistantModelFiles } from "@filen/shared/dom/assistantModel/manifest"
import { checkpointName, ensureModelDir, readVerified, replaceVerified, sizeOf } from "../../assistant/modelDir.ts"
import { failure } from "../../shared/assistantProtocol.ts"

// The page's own (OPFS) copy of a model, imported into the native engine's directory instead of downloading it again:
// the page sends each shard it verified in order, in chunks, and main writes and hashes them as they arrive. A shard
// counts once its sha256 matches the pinned manifest's; anything else is deleted, and the download fetches it. One
// shard at a time per page; a page that goes takes its unfinished shard with it.

interface Session {
	pageId: number
	modelId: string
	file: string
	path: string
	handle: FileHandle
	hash: Hash
	next: number
}

export interface ModelImporter {
	chunk(
		pageId: number,
		model: AssistantModelFiles,
		file: string,
		offset: number,
		bytes: Uint8Array,
		last: boolean
	): Promise<DesktopAssistantResult<DesktopAssistantImport>>
	// Drops `pageId`'s unfinished shard (all of them without one).
	abandon(pageId?: number): Promise<void>
}

export function createModelImporter(modelsRoot: string): ModelImporter {
	const sessions = new Map<number, Session>()

	async function drop(session: Session): Promise<void> {
		sessions.delete(session.pageId)
		await session.handle.close().catch(() => undefined)
		await rm(session.path, { force: true }).catch(() => undefined)
	}

	async function begin(pageId: number, model: AssistantModelFiles, shard: AssistantModelFile): Promise<Session | "present"> {
		const dir = await ensureModelDir(modelsRoot, model.id)
		const target = path.join(dir, shard.file)

		if ((await readVerified(dir)).get(shard.file) === shard.sha256 && (await sizeOf(target)) === shard.size) {
			return "present"
		}

		// A partial download of it is replaced, and its hasher checkpoint with it.
		await rm(path.join(dir, checkpointName(shard)), { force: true })

		const session: Session = {
			pageId,
			modelId: model.id,
			file: shard.file,
			path: target,
			handle: await open(target, "w", 0o600),
			hash: createHash("sha256"),
			next: 0
		}

		sessions.set(pageId, session)

		return session
	}

	// The page's shard this chunk continues; null when it continues none (and the page's unfinished one goes).
	async function sessionFor(pageId: number, model: AssistantModelFiles, file: string, offset: number): Promise<Session | null> {
		const session = sessions.get(pageId)

		if (session !== undefined && session.modelId === model.id && session.file === file && session.next === offset) {
			return session
		}

		if (session !== undefined) {
			await drop(session)
		}

		return null
	}

	return {
		chunk: async (pageId, model, file, offset, bytes, last) => {
			const shard = model.shards.find(entry => entry.file === file)

			if (shard === undefined) {
				return failure("integrity", `${file} is not a shard of ${model.id}`)
			}

			let session: Session | null

			if (offset === 0) {
				// The page starts a shard over: what it sent of another goes.
				const previous = sessions.get(pageId)

				if (previous !== undefined) {
					await drop(previous)
				}

				const started = await begin(pageId, model, shard)

				if (started === "present") {
					return { ok: true, value: "present" }
				}

				session = started
			} else {
				session = await sessionFor(pageId, model, file, offset)
			}

			if (session === null) {
				return failure("integrity", `${file} arrived out of order`)
			}

			if (offset + bytes.byteLength > shard.size) {
				await drop(session)

				return failure("integrity", `${file} is longer than published`)
			}

			try {
				await session.handle.write(bytes, 0, bytes.byteLength, offset)
			} catch (error) {
				await drop(session)

				const code = (error as NodeJS.ErrnoException | null)?.code

				return failure(code === "ENOSPC" || code === "EDQUOT" ? "storage-full" : "failed", `${file}: ${String(code)}`)
			}

			session.hash.update(bytes)
			session.next += bytes.byteLength

			if (!last) {
				return { ok: true, value: "more" }
			}

			const complete = session.next === shard.size && session.hash.digest("hex") === shard.sha256

			if (!complete) {
				await drop(session)

				return failure("integrity", `${file} does not match its published hash`)
			}

			sessions.delete(pageId)
			await session.handle.sync()
			await session.handle.close()

			const dir = path.dirname(session.path)
			const verified = await readVerified(dir)

			verified.set(shard.file, shard.sha256)
			replaceVerified(dir, verified)

			return { ok: true, value: "verified" }
		},
		abandon: async pageId => {
			for (const session of [...sessions.values()]) {
				if (pageId === undefined || session.pageId === pageId) {
					await drop(session)
				}
			}
		}
	}
}
