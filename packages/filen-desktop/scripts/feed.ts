import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import type { Readable } from "node:stream"

// The electron-updater manifests (latest*.yml) as electron-builder writes them: flat top-level scalars plus one
// `files` list of flat maps. Only that shape is read, so anything else fails parsing instead of being skipped.

export interface FeedFile {
	url: string
	sha512: string
	size: number
	isAdminRightsRequired: boolean
}

export interface Feed {
	top: Map<string, string>
	files: FeedFile[]
}

export const feedManifests = {
	mac: ["latest-mac.yml"],
	win: ["latest.yml"],
	linux: ["latest-linux.yml", "latest-linux-arm64.yml"]
} as const

export type FeedPlatform = keyof typeof feedManifests

export function isFeedPlatform(value: string | undefined): value is FeedPlatform {
	return value !== undefined && Object.hasOwn(feedManifests, value)
}

function unquote(value: string): string {
	const trimmed = value.trim()

	if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
		return trimmed.slice(1, -1).replaceAll("''", "'")
	}

	if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
		return trimmed.slice(1, -1)
	}

	return trimmed
}

const topLine = /^([A-Za-z][\w-]*):(?:\s+(.*))?$/
const entryStart = /^\s+-\s+([A-Za-z][\w-]*):\s+(.*)$/
const entryLine = /^\s+([A-Za-z][\w-]*):\s+(.*)$/

function toFile(fields: Map<string, string>, manifest: string): FeedFile {
	const url = fields.get("url")
	const sha512 = fields.get("sha512")
	const size = Number(fields.get("size"))

	if (!url || !sha512 || !Number.isSafeInteger(size)) {
		throw new Error(`${manifest}: a files entry lacks url, sha512 or size`)
	}

	return { url, sha512, size, isAdminRightsRequired: fields.get("isAdminRightsRequired") === "true" }
}

export function parseFeed(text: string, manifest: string): Feed {
	const top = new Map<string, string>()
	const files: FeedFile[] = []
	let entry: Map<string, string> | null = null

	for (const line of text.split("\n")) {
		if (line.trim() === "") {
			continue
		}

		const start = entryStart.exec(line)

		if (start) {
			if (entry) {
				files.push(toFile(entry, manifest))
			}

			entry = new Map([[start[1] ?? "", unquote(start[2] ?? "")]])

			continue
		}

		const field = entryLine.exec(line)

		if (field && entry) {
			entry.set(field[1] ?? "", unquote(field[2] ?? ""))

			continue
		}

		const key = topLine.exec(line)

		if (!key) {
			throw new Error(`${manifest}: unexpected line "${line}"`)
		}

		if (entry) {
			files.push(toFile(entry, manifest))
			entry = null
		}

		top.set(key[1] ?? "", unquote(key[2] ?? ""))
	}

	if (entry) {
		files.push(toFile(entry, manifest))
	}

	if (files.length === 0) {
		throw new Error(`${manifest}: no files entries`)
	}

	return { top, files }
}

export async function hashStream(stream: Readable): Promise<{ sha512: string; size: number }> {
	const hash = createHash("sha512")
	let size = 0

	for await (const chunk of stream) {
		const buffer = chunk as Buffer

		hash.update(buffer)
		size += buffer.length
	}

	return { sha512: hash.digest("base64"), size }
}

export async function hashFile(path: string): Promise<{ sha512: string; size: number } | null> {
	const info = await stat(path).catch(() => null)

	if (!info?.isFile()) {
		return null
	}

	return hashStream(createReadStream(path))
}

/**
 * Rewrites every sha512/size in a manifest from the files on disk (the root `sha512` follows `path`). Line-based, so
 * the rest of the manifest keeps electron-builder's exact bytes. Returns the new text and the urls that changed.
 */
export function rewriteFeed(
	text: string,
	actual: ReadonlyMap<string, { sha512: string; size: number }>
): { text: string; changed: string[] } {
	const changed = new Set<string>()
	const lines = text.split("\n")
	const root = parseFeed(text, "manifest").top.get("path")
	let url: string | null = null

	const out = lines.map(line => {
		const start = entryStart.exec(line)

		if (start) {
			url = start[1] === "url" ? unquote(start[2] ?? "") : null

			return line
		}

		const field = entryLine.exec(line)

		if (field && url !== null) {
			const real = actual.get(url)
			const indent = line.slice(0, line.indexOf(field[1] ?? ""))

			if (real && field[1] === "sha512" && unquote(field[2] ?? "") !== real.sha512) {
				changed.add(url)

				return `${indent}sha512: ${real.sha512}`
			}

			if (real && field[1] === "size" && Number(field[2]) !== real.size) {
				changed.add(url)

				return `${indent}size: ${real.size}`
			}

			return line
		}

		url = null

		const key = topLine.exec(line)
		const real = root === undefined ? undefined : actual.get(root)

		if (key?.[1] === "sha512" && root !== undefined && real && unquote(key[2] ?? "") !== real.sha512) {
			changed.add(root)

			return `sha512: ${real.sha512}`
		}

		return line
	})

	return { text: out.join("\n"), changed: [...changed] }
}
