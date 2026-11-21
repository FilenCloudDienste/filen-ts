import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { AssistantModelFiles } from "@filen/shared/dom/assistantModel/manifest"
import { createModelImporter } from "../main/assistant/importer.ts"
import { inspectModel } from "../assistant/modelDir.ts"

// The page's OPFS copy imported into the native engine's directory, chunk by chunk: kept only once its sha256 matches
// the pinned manifest, deleted on any mismatch (the download then fetches it), never mixed across shards or pages.

function bytes(seed: number, size: number): Uint8Array {
	return Uint8Array.from({ length: size }, (_, index) => (index * 7 + seed) % 253)
}

const FIRST = bytes(1, 30_000)
const SECOND = bytes(2, 12_000)
const MODEL: AssistantModelFiles = {
	id: "test-model",
	shards: [
		{ file: "m-00001-of-00002.gguf", size: FIRST.length, sha256: createHash("sha256").update(FIRST).digest("hex") },
		{ file: "m-00002-of-00002.gguf", size: SECOND.length, sha256: createHash("sha256").update(SECOND).digest("hex") }
	]
}
const [ONE, TWO] = MODEL.shards.map(shard => shard.file) as [string, string]

let root: string

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "filen-assistant-import-"))
})

afterEach(async () => {
	await rm(root, { recursive: true, force: true })
})

// Sends `data` as the page does: in order, `size` bytes at a time, the last chunk marked.
async function send(importer: ReturnType<typeof createModelImporter>, file: string, data: Uint8Array, size = 8_000, pageId = 1) {
	const results = []

	for (let at = 0; at < data.length || at === 0; at += size) {
		const chunk = data.subarray(at, Math.min(data.length, at + size))
		const result = await importer.chunk(pageId, MODEL, file, at, chunk, at + size >= data.length)

		results.push(result)

		if (!result.ok || result.value !== "more") {
			break
		}
	}

	return results
}

describe("assistant model import", () => {
	it("keeps each shard once its hash matches, recorded as verified", async () => {
		const importer = createModelImporter(root)

		expect((await send(importer, ONE, FIRST)).at(-1)).toEqual({ ok: true, value: "verified" })
		expect((await send(importer, TWO, SECOND)).at(-1)).toEqual({ ok: true, value: "verified" })
		expect(new Uint8Array(await readFile(path.join(root, MODEL.id, ONE)))).toEqual(FIRST)
		expect(await inspectModel(root, MODEL)).toEqual({ presentBytes: 42_000, verifiedBytes: 42_000, complete: true })
	})

	it("answers present for a shard the engine has verified already, and writes nothing", async () => {
		const importer = createModelImporter(root)

		await send(importer, ONE, FIRST)
		expect(await importer.chunk(1, MODEL, ONE, 0, FIRST.subarray(0, 10), false)).toEqual({ ok: true, value: "present" })
	})

	it("deletes a shard that does not match its pinned hash, so the download fetches it", async () => {
		const importer = createModelImporter(root)
		const damaged = FIRST.slice()

		damaged[100] = (damaged[100] ?? 0) ^ 1

		expect((await send(importer, ONE, damaged)).at(-1)).toMatchObject({ ok: false, error: "integrity" })
		await expect(stat(path.join(root, MODEL.id, ONE))).rejects.toThrow()
		expect(await inspectModel(root, MODEL)).toMatchObject({ verifiedBytes: 0 })
	})

	it("refuses a chunk out of order, one past the published size, and a file the manifest does not name", async () => {
		const importer = createModelImporter(root)

		expect(await importer.chunk(1, MODEL, ONE, 0, FIRST.subarray(0, 100), false)).toEqual({ ok: true, value: "more" })
		expect(await importer.chunk(1, MODEL, ONE, 200, FIRST.subarray(200, 300), false)).toMatchObject({ ok: false, error: "integrity" })
		await expect(stat(path.join(root, MODEL.id, ONE))).rejects.toThrow()

		const longer = new Uint8Array(SECOND.length + 1)

		expect((await send(importer, TWO, longer, longer.length)).at(-1)).toMatchObject({ ok: false, error: "integrity" })
		expect(await importer.chunk(1, MODEL, "other.gguf", 0, FIRST, true)).toMatchObject({ ok: false, error: "integrity" })
	})

	it("replaces a partial download of the shard and its hasher checkpoint", async () => {
		const dir = path.join(root, MODEL.id)

		await mkdir(dir, { recursive: true })
		await writeFile(path.join(dir, ONE), FIRST.subarray(0, 5000))
		await writeFile(path.join(dir, `${ONE}.sha256-state`), "state")

		expect((await send(createModelImporter(root), ONE, FIRST)).at(-1)).toEqual({ ok: true, value: "verified" })
		await expect(stat(path.join(dir, `${ONE}.sha256-state`))).rejects.toThrow()
	})

	it("keeps each page's shard apart, and drops a page's unfinished one when it goes", async () => {
		const importer = createModelImporter(root)

		await importer.chunk(1, MODEL, ONE, 0, FIRST.subarray(0, 100), false)
		// Another page's chunk never continues this page's shard.
		expect(await importer.chunk(2, MODEL, ONE, 100, FIRST.subarray(100, 200), false)).toMatchObject({ ok: false })
		await importer.abandon(1)
		await expect(stat(path.join(root, MODEL.id, ONE))).rejects.toThrow()
		expect(await importer.chunk(1, MODEL, ONE, 100, FIRST.subarray(100, 200), false)).toMatchObject({ ok: false, error: "integrity" })
	})
})
