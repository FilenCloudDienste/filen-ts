import { createHash } from "node:crypto"
import { createReadStream, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import type { Cloud } from "./cloud.ts"

// What a tree holds, by relative path ("/"-separated, NFC): kind, size, content hash and an identity that changes when
// an item is rewritten even with the same bytes (on disk inode and mtime, in the cloud the uuid and modification time).
// Two snapshots are compared with or without identities; the differences are named, never just counted.

export interface SnapshotNode {
	kind: "file" | "dir"
	size: number
	sha256: string | null
	identity: string | null
}

export type Snapshot = Map<string, SnapshotNode>

async function sha256Of(file: string): Promise<string> {
	const hash = createHash("sha256")

	await pipeline(createReadStream(file), hash)

	return hash.digest("hex")
}

export interface LocalSnapshotOptions {
	// Entries left out, with everything below them (the sync engine's own bin, say).
	skip?: (relPath: string) => boolean
}

export async function localSnapshot(root: string, options: LocalSnapshotOptions = {}): Promise<Snapshot> {
	const snapshot: Snapshot = new Map()
	const walk = async (dir: string, prefix: string): Promise<void> => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const relPath = (prefix === "" ? entry.name : `${prefix}/${entry.name}`).normalize("NFC")

			if (options.skip?.(relPath) === true) {
				continue
			}

			const full = path.join(dir, entry.name)
			const stat = statSync(full, { bigint: true })
			const identity = `${String(stat.ino)}@${String(stat.mtimeNs)}`

			if (entry.isDirectory()) {
				snapshot.set(relPath, { kind: "dir", size: 0, sha256: null, identity: null })
				await walk(full, relPath)
			} else if (entry.isFile()) {
				snapshot.set(relPath, { kind: "file", size: Number(stat.size), sha256: await sha256Of(full), identity })
			}
		}
	}

	await walk(root, "")

	return snapshot
}

// The cloud tree below `dir`: the listing gives kinds, sizes and identities, a download the hashes. null when `dir`
// does not exist.
export async function cloudSnapshot(cloud: Cloud, dir: string, work: string): Promise<Snapshot | null> {
	const entries = await cloud.list(dir)

	if (entries === null) {
		return null
	}

	const copy = mkdtempSync(path.join(work, "cloud-"))

	try {
		await cloud.download(dir, copy)

		const local = await localSnapshot(copy)
		const snapshot: Snapshot = new Map()

		for (const entry of entries) {
			const relPath = entry.path.normalize("NFC")
			const identity = `${entry.id}@${entry.modTime}`

			snapshot.set(
				relPath,
				entry.isDir
					? { kind: "dir", size: 0, sha256: null, identity: null }
					: { kind: "file", size: entry.size, sha256: local.get(relPath)?.sha256 ?? null, identity }
			)
		}

		return snapshot
	} finally {
		rmSync(copy, { recursive: true, force: true })
	}
}

export interface DiffOptions {
	// Also compare identities (rewritten, re-uploaded).
	identity: boolean
	// Paths allowed to differ in any way, with everything below them (the expected deltas).
	allowed?: readonly string[]
}

// Every difference of `actual` from `expected`, one line each; empty when they match.
export function diffSnapshots(expected: Snapshot, actual: Snapshot, options: DiffOptions): string[] {
	const allowedPaths = options.allowed ?? []
	const allowed = { has: (relPath: string) => allowedPaths.some(path => relPath === path || relPath.startsWith(`${path}/`)) }
	const differences: string[] = []

	for (const [relPath, want] of expected) {
		if (allowed.has(relPath)) {
			continue
		}

		const got = actual.get(relPath)

		if (got === undefined) {
			differences.push(`missing ${relPath}`)
		} else if (got.kind !== want.kind) {
			differences.push(`${relPath}: a ${got.kind}, expected a ${want.kind}`)
		} else if (got.size !== want.size || got.sha256 !== want.sha256) {
			differences.push(`${relPath}: content changed (${String(want.size)} -> ${String(got.size)} bytes)`)
		} else if (options.identity && want.identity !== null && got.identity !== want.identity) {
			differences.push(`${relPath}: rewritten (identity changed)`)
		}
	}

	for (const relPath of actual.keys()) {
		if (!expected.has(relPath) && !allowed.has(relPath)) {
			differences.push(`unexpected ${relPath}`)
		}
	}

	return differences
}

// A snapshot as JSON lines for an artifact (no content, hashes only).
export function snapshotText(snapshot: Snapshot): string {
	return [...snapshot.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([relPath, node]) => JSON.stringify({ path: relPath, ...node }))
		.join("\n")
}

// Every file at or below `root` (a file or a directory; at most `maxBytes` each) holding any of `values`, as UTF-8 or
// UTF-16LE (Chromium's localStorage keeps strings either way); paths relative to `root` ("" for a file root), never
// what matched.
export function filesHolding(root: string, values: readonly string[], maxBytes = 64 * 1024 * 1024): string[] {
	const needles = values.filter(value => value.length >= 4).flatMap(value => [Buffer.from(value, "utf8"), Buffer.from(value, "utf16le")])
	const hits: string[] = []
	const kind = statSync(root, { throwIfNoEntry: false })
	const files =
		kind === undefined
			? []
			: kind.isDirectory()
				? readdirSync(root, { withFileTypes: true, recursive: true })
						.filter(entry => entry.isFile())
						.map(entry => path.join(entry.parentPath, entry.name))
				: [root]

	for (const file of files) {
		try {
			if (statSync(file).size > maxBytes) {
				continue
			}

			const bytes = readFileSync(file)

			if (needles.some(needle => bytes.includes(needle))) {
				hits.push(path.relative(root, file))
			}
		} catch {
			// Removed while scanned.
		}
	}

	return hits
}
