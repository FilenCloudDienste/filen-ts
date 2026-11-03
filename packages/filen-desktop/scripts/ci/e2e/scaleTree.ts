import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fail } from "../support.ts"
import type { Cloud, CloudEntry } from "./cloud.ts"
import { seededBytes, type Tree, writeTree } from "./fixtures.ts"
import { cloudSnapshot, diffSnapshots, type Snapshot, type SnapshotNode } from "./snapshot.ts"

// The permanent scale tree: 8,200 small files (0 to 4 KiB, one in twenty empty) in 300 directories three levels deep,
// about 8,500 entries, the same bytes whenever it is generated. It lives in the cloud outside the swept root, written
// by a reseed (e2eCloud.ts fixtures --reseed, dispatch input scale_reseed) and otherwise only ever read: chain P pulls
// it into a remoteToLocal pair (chains/realWorld.ts). Runs overlap, so a reseed never touches a tree one may be
// reading: it writes a new generation (scale-v1.<time>) and then the manifest, which names the current generation and
// records every entry of it as it was seeded ("path:size:uuid", a directory's path ending in "/"), so a run can tell a
// damaged tree from the one it knows without downloading it. Until the first reseed there is no manifest: the tree is
// unseeded, which is a warning, not a failure.

export const FIXTURES_ROOT = "filen-desktop-e2e-fixtures"
export const SCALE_NAME = "scale-v1"
export const SCALE_MANIFEST_NAME = `${SCALE_NAME}.manifest.json`
export const SCALE_MANIFEST = `${FIXTURES_ROOT}/${SCALE_MANIFEST_NAME}`
export const SCALE_UNSEEDED = `${FIXTURES_ROOT} has no ${SCALE_MANIFEST_NAME}: seed the scale tree with a dispatch with scale_reseed`
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
	version: 2
	// The current generation's directory below FIXTURES_ROOT.
	dir: string
	entries: string[]
}

// A generation's directory below FIXTURES_ROOT: the name and the time it was written.
export function scaleGeneration(at: Date): string {
	return `${SCALE_NAME}.${at.toISOString().replace(/[:.]/g, "-")}`
}

const isGeneration = (name: string) => name.startsWith(`${SCALE_NAME}.`) && name !== SCALE_MANIFEST_NAME && !name.includes("/")

export function manifestOf(dir: string, entries: readonly CloudEntry[]): ScaleManifest {
	return {
		version: 2,
		dir,
		entries: entries
			.map(entry => `${entry.path}${entry.isDir ? "/" : ""}:${String(entry.size)}:${entry.id}`)
			.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
	}
}

export interface ScaleCurrent {
	// The generation's path in the cloud.
	dir: string
	// Its entries as a list-only snapshot (cloudSnapshot listOnly: the uuid is the identity).
	snapshot: Snapshot
}

export function readManifest(text: string): ScaleCurrent {
	const parsed = JSON.parse(text) as Partial<ScaleManifest>

	if (parsed.version !== 2 || typeof parsed.dir !== "string" || !isGeneration(parsed.dir) || !Array.isArray(parsed.entries)) {
		fail(`${SCALE_MANIFEST_NAME} is not a version 2 manifest naming a ${SCALE_NAME}.<time> generation`)
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

	return { dir: `${FIXTURES_ROOT}/${parsed.dir}`, snapshot }
}

// The current generation as the manifest names it; null while none was ever seeded.
export async function currentScale(cloud: Cloud): Promise<ScaleCurrent | null> {
	const siblings = (await cloud.list(FIXTURES_ROOT, false)) ?? []

	if (!siblings.some(entry => !entry.isDir && entry.path === SCALE_MANIFEST_NAME)) {
		return null
	}

	return readManifest((await cloud.cat(SCALE_MANIFEST)).toString("utf8"))
}

// The current generation in the cloud against its manifest (uuids included: a rewrite shows) and against the layout
// (kinds and sizes); fails naming the first differences.
export async function verifyScale(cloud: Cloud, work: string, current: ScaleCurrent): Promise<string> {
	const listed = (await cloudSnapshot(cloud, current.dir, work, { listOnly: true })) ?? fail(`${current.dir} is gone`)
	const name = (differences: string[]) =>
		`${differences.slice(0, 10).join("; ")}${differences.length > 10 ? ` and ${String(differences.length - 10)} more` : ""}`
	const againstManifest = diffSnapshots(current.snapshot, listed, { identity: true })

	if (againstManifest.length > 0) {
		fail(`${current.dir} differs from its manifest (${String(againstManifest.length)}): ${name(againstManifest)}`)
	}

	const againstLayout = diffSnapshots(layoutSnapshot(), listed, { identity: false })

	if (againstLayout.length > 0) {
		fail(`${current.dir} is not the generated tree (${String(againstLayout.length)}): ${name(againstLayout)}`)
	}

	return `${current.dir}: ${String(listed.size)} entries match the manifest (uuids included) and the generated tree`
}

// The generations a reseed removes once its own is current: every other one but the generation the manifest named
// before it, which a run that started earlier may still be pulling. The plan job runs a reseed only while no other
// run is active, so no run can still read an older one.
export function staleGenerations(siblings: readonly CloudEntry[], keep: readonly string[]): string[] {
	return siblings.filter(entry => entry.isDir && isGeneration(entry.path) && !keep.includes(entry.path)).map(entry => entry.path)
}

// A new generation: the generated tree uploaded, listed and checked against the layout, the manifest pointed at it
// from that listing, then the stale generations to the trash. Nothing a run may read is changed before the manifest
// is: a reseed cut short leaves the current generation as it was (its partial upload goes with the next reseed).
export async function reseedScale(cloud: Cloud, work: string): Promise<string> {
	const local = mkdtempSync(path.join(work, "scale-"))

	try {
		const layout = scaleLayout()
		// A manifest that does not read is replaced like a missing one.
		const previous = await currentScale(cloud).catch(() => null)
		const generation = scaleGeneration(new Date())
		const dir = `${FIXTURES_ROOT}/${generation}`

		writeTree(local, scaleTree(layout))

		const started = Date.now()

		await cloud.upload(local, dir, RESEED)

		const entries = (await cloud.list(dir)) ?? fail(`${dir} is not there after the upload`)
		const differences = diffSnapshots(
			layoutSnapshot(layout),
			new Map(
				entries.map((entry): [string, SnapshotNode] => [
					entry.path,
					{ kind: entry.isDir ? "dir" : "file", size: entry.size, sha256: null, identity: null }
				])
			),
			{ identity: false }
		)

		if (differences.length > 0) {
			fail(`the uploaded tree is not the generated one: ${differences.slice(0, 10).join("; ")}`)
		}

		const file = path.join(work, SCALE_MANIFEST_NAME)

		writeFileSync(file, `${JSON.stringify(manifestOf(generation, entries), null, "\t")}\n`)
		await cloud.uploadFile(file, SCALE_MANIFEST)

		const keep = [generation, ...(previous === null ? [] : [previous.dir.slice(FIXTURES_ROOT.length + 1)])]
		const stale = staleGenerations((await cloud.list(FIXTURES_ROOT, false)) ?? [], keep)

		for (const old of stale) {
			await cloud.purge(`${FIXTURES_ROOT}/${old}`)
		}

		return `${generation}: ${String(entries.length)} entries uploaded in ${String(Math.round((Date.now() - started) / 1000))} s; manifest written; ${stale.length === 0 ? "nothing" : stale.join(", ")} to the trash`
	} finally {
		rmSync(local, { recursive: true, force: true })
	}
}
