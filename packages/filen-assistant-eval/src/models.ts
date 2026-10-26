import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { type } from "arktype"

const repoPin = {
	repo: "string",
	revision: "string"
} as const

const modelSchema = type({
	id: "string",
	label: "string",
	enabled: "boolean",
	file: "string",
	url: "string.url",
	sha256: /^[0-9a-f]{64}$/,
	sizeBytes: "number.integer",
	source: repoPin,
	baseModel: repoPin,
	license: {
		name: "string",
		url: "string.url",
		// Commercial use and redistribution in the apps without revenue caps or usage restrictions.
		shippable: "boolean"
	},
	chatWrapper: "'qwen3.5' | 'lfm2' | 'auto'",
	"contextOptions?": {
		batchSize: "number.integer"
	},
	"note?": "string"
})

const manifestSchema = type({
	models: modelSchema.array()
})

export type ModelEntry = typeof modelSchema.infer

export const PACKAGE_ROOT = new URL("..", import.meta.url).pathname

export async function loadManifest(): Promise<ModelEntry[]> {
	const raw: unknown = JSON.parse(await readFile(join(PACKAGE_ROOT, "models.json"), "utf8"))

	return manifestSchema.assert(raw).models
}

async function sha256Of(path: string): Promise<string> {
	const hash = createHash("sha256")

	await pipeline(createReadStream(path), hash)

	return hash.digest("hex")
}

async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false
	)
}

// Downloads into the gitignored cache and verifies the pinned sha256, so a moved or replaced
// upstream file can never silently change what is measured.
export async function ensureModel({ model, dir }: { model: ModelEntry; dir: string }): Promise<string> {
	const path = join(dir, model.file)

	if (await exists(path)) {
		return path
	}

	await mkdir(dir, {
		recursive: true
	})

	const partial = `${path}.part`
	const response = await fetch(model.url)

	if (!response.ok || response.body === null) {
		throw new Error(`Download of ${model.id} failed: HTTP ${response.status}`)
	}

	console.log(`Downloading ${model.id} (${(model.sizeBytes / 1e9).toFixed(2)} GB)`)

	await pipeline(Readable.fromWeb(response.body), createWriteStream(partial))

	const digest = await sha256Of(partial)

	if (digest !== model.sha256) {
		await rm(partial)

		throw new Error(`Checksum mismatch for ${model.id}: expected ${model.sha256}, got ${digest}`)
	}

	await rename(partial, path)

	return path
}
