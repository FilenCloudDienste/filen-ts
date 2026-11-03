import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fail } from "../support.ts"
import type { Cloud, CloudEntry } from "./cloud.ts"
import { seededBytes, type Tree, writeTree } from "./fixtures.ts"
import { cloudSnapshot, diffSnapshots, type Snapshot, type SnapshotNode } from "./snapshot.ts"

// The permanent scale tree: 8,200 small files (0 to 4 KiB, one in twenty empty) in 300 directories three levels deep,
// about 8,500 entries, the same bytes whenever it is generated. It lives in the cloud outside the swept root, seeded
// once (e2eCloud.ts fixtures --reseed, dispatch input scale_reseed) and only ever read: chain P pulls it into a
// remoteToLocal pair (chains/realWorld.ts). Its manifest, next to it, records every entry as it was seeded
// ("path:size:uuid", a directory's path ending in "/"), so a run can tell a damaged or reseeded tree from the one it
// knows without downloading it.

export const FIXTURES_ROOT = "filen-desktop-e2e-fixtures"
export const SCALE_NAME = "scale-v1"
export const SCALE_DIR = `${FIXTURES_ROOT}/${SCALE_NAME}`
export const SCALE_MANIFEST_NAME = `${SCALE_NAME}.manifest.json`
export const SCALE_MANIFEST = `${FIXTURES_ROOT}/${SCALE_MANIFEST_NAME}`
export const SCALE_FILES = 8200
// 6 at the top, 7 in each, 6 in each of those: 6 + 42 + 252.
const FANOUT = [6, 7, 6] as const
export const SCALE_DIRS = FANOUT[0] + FANOUT[0] * FANOUT[1] + FANOUT[0] * FANOUT[1] * FANOUT[2]
const MAX_FILE_BYTES = 4096
// A reseed: thousands of small files, many at a time.
const RESEED = { timeoutMs: 40 * 60 * 1000, transfers: 16 }

export interface ScaleLayout {
	// Every directory, parents first.
	dirs: string[]
	files: { path: string; size: number }[]
}

// The tree's shape: directories a<i>/b<j>/c<k>, file f<n> in the (n mod 300)th directory; sizes from the seed.
export function scaleLayout(): ScaleLayout {
	const dirs: string[] = []

	for (let a = 0; a < FANOUT[0]; a++) {
		dirs.push(`a${String(a)}`)

		for (let b = 0; b < FANOUT[1]; b++) {
			dirs.push(`a${String(a)}/b${String(b)}`)

			for (let c = 0; c < FANOUT[2]; c++) {
				dirs.push(`a${String(a)}/b${String(b)}/c${String(c)}`)
			}
		}
	}

	const files = Array.from({ length: SCALE_FILES }, (_, index) => ({
		path: `${dirs[index % dirs.length] ?? fail("no directory")}/f${String(index).padStart(4, "0")}.txt`,
		size: index % 20 === 0 ? 0 : 1 + (seededBytes(`${SCALE_NAME}/size/${String(index)}`, 2).readUInt16BE(0) % MAX_FILE_BYTES)
	}))

	return { dirs, files }
}

export function scaleBytes(relPath: string, size: number): Buffer {
	return seededBytes(`${SCALE_NAME}/${relPath}`, size)
}

// The whole tree in memory (about 16 MiB).
export function scaleTree(layout: ScaleLayout = scaleLayout()): Tree {
	return { files: new Map(layout.files.map(file => [file.path, scaleBytes(file.path, file.size)])), emptyDirs: [] }
}

// The tree's kinds and sizes, nothing hashed: what a listing must show.
export function layoutSnapshot(layout: ScaleLayout = scaleLayout()): Snapshot {
	const snapshot: Snapshot = new Map()

	for (const dir of layout.dirs) {
		snapshot.set(dir, { kind: "dir", size: 0, sha256: null, identity: null })
	}

	for (const file of layout.files) {
		snapshot.set(file.path, { kind: "file", size: file.size, sha256: null, identity: null })
	}

	return snapshot
}

export interface ScaleManifest {
	version: 1
	entries: string[]
}

export function manifestOf(entries: readonly CloudEntry[]): ScaleManifest {
	return {
		version: 1,
		entries: entries
			.map(entry => `${entry.path}${entry.isDir ? "/" : ""}:${String(entry.size)}:${entry.id}`)
			.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
	}
}

// A manifest as a list-only snapshot (cloudSnapshot listOnly: the uuid is the identity).
export function manifestSnapshot(text: string): Snapshot {
	const parsed = JSON.parse(text) as Partial<ScaleManifest>

	if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
		fail(`${SCALE_MANIFEST_NAME} is not a version 1 manifest`)
	}

	const snapshot: Snapshot = new Map()

	for (const line of parsed.entries) {
		const uuidAt = line.lastIndexOf(":")
		const sizeAt = line.lastIndexOf(":", uuidAt - 1)
		const name = line.slice(0, sizeAt)
		const size = Number(line.slice(sizeAt + 1, uuidAt))
		const id = line.slice(uuidAt + 1)

		if (sizeAt <= 0 || !Number.isInteger(size) || id === "") {
			fail(`${SCALE_MANIFEST_NAME}: not "path:size:uuid": ${line}`)
		}

		const isDir = name.endsWith("/")

		snapshot.set(isDir ? name.slice(0, -1) : name, { kind: isDir ? "dir" : "file", size, sha256: null, identity: id })
	}

	return snapshot
}

// The tree in the cloud against its manifest (uuids included: a reseed or a rewrite shows) and against the layout
// (kinds and sizes); fails naming the first differences.
export async function verifyScale(cloud: Cloud, work: string): Promise<string> {
	const siblings = (await cloud.list(FIXTURES_ROOT, false)) ?? []
	const missing = [SCALE_NAME, SCALE_MANIFEST_NAME].filter(name => !siblings.some(entry => entry.path === name))

	if (missing.length > 0) {
		fail(`${FIXTURES_ROOT} has no ${missing.join(" or ")}: seed it with a dispatch with scale_reseed`)
	}

	const manifest = manifestSnapshot((await cloud.cat(SCALE_MANIFEST)).toString("utf8"))
	const listed = (await cloudSnapshot(cloud, SCALE_DIR, work, { listOnly: true })) ?? fail(`${SCALE_DIR} is gone`)
	const name = (differences: string[]) =>
		`${differences.slice(0, 10).join("; ")}${differences.length > 10 ? ` and ${String(differences.length - 10)} more` : ""}`
	const againstManifest = diffSnapshots(manifest, listed, { identity: true })

	if (againstManifest.length > 0) {
		fail(`${SCALE_DIR} differs from its manifest (${String(againstManifest.length)}): ${name(againstManifest)}`)
	}

	const againstLayout = diffSnapshots(layoutSnapshot(), listed, { identity: false })

	if (againstLayout.length > 0) {
		fail(`${SCALE_DIR} is not the generated tree (${String(againstLayout.length)}): ${name(againstLayout)}`)
	}

	return `${String(listed.size)} entries match the manifest (uuids included) and the generated tree`
}

// The tree written anew: the old one to the trash, the generated tree uploaded, listed and checked
// against the layout, the manifest written from that listing.
export async function reseedScale(cloud: Cloud, work: string): Promise<string> {
	const local = mkdtempSync(path.join(work, "scale-"))

	try {
		const layout = scaleLayout()

		writeTree(local, scaleTree(layout))
		// The manifest is replaced below (a new version); until then it no longer matches, so a reseed cut short fails
		// every verification instead of passing on half a tree.
		await cloud.purge(SCALE_DIR)

		const started = Date.now()

		await cloud.upload(local, SCALE_DIR, RESEED)

		const entries = (await cloud.list(SCALE_DIR)) ?? fail(`${SCALE_DIR} is not there after the upload`)
		const listed = new Map(entries.map(entry => [entry.path, entry]))
		const differences = diffSnapshots(
			layoutSnapshot(layout),
			new Map(
				[...listed].map(([relPath, entry]): [string, SnapshotNode] => [
					relPath,
					{ kind: entry.isDir ? "dir" : "file", size: entry.size, sha256: null, identity: null }
				])
			),
			{ identity: false }
		)

		if (differences.length > 0) {
			fail(`the uploaded tree is not the generated one: ${differences.slice(0, 10).join("; ")}`)
		}

		const file = path.join(work, SCALE_MANIFEST_NAME)

		writeFileSync(file, `${JSON.stringify(manifestOf(entries), null, "\t")}\n`)
		await cloud.uploadFile(file, SCALE_MANIFEST)

		return `${String(entries.length)} entries uploaded in ${String(Math.round((Date.now() - started) / 1000))} s; manifest written`
	} finally {
		rmSync(local, { recursive: true, force: true })
	}
}
