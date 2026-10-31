import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { DesktopSyncMode } from "@filen/shared/desktop"
import type { Snapshot } from "./snapshot.ts"

// The trees the chains sync and the changes they expect. Bytes are deterministic per seed, so an expected tree is known
// without reading anything back.

export interface Tree {
	// relPath ("/"-separated) -> bytes
	files: Map<string, Buffer>
	// Directories that exist with nothing in them.
	emptyDirs: string[]
}

const MIB = 1024 * 1024

// `size` bytes of a SHA-256 counter stream over `seed`.
export function seededBytes(seed: string, size: number): Buffer {
	const blocks: Buffer[] = []

	for (let counter = 0; blocks.length * 32 < size; counter++) {
		blocks.push(
			createHash("sha256")
				.update(`${seed}:${String(counter)}`)
				.digest()
		)
	}

	return Buffer.concat(blocks).subarray(0, size)
}

// The shape every pair syncs: a nested file, an empty file, one of more than one chunk, unicode and space names and an
// empty directory. `dotEntries` adds a hidden file and directory, which an excludeDotFiles pair keeps on its seeded side.
export function fixtureTree(seed: string, dotEntries: boolean): Tree {
	const text = (name: string) => Buffer.from(`${seed} ${name}\n${seededBytes(`${seed}/${name}`, 96).toString("hex")}\n`)
	const files = new Map<string, Buffer>([
		["docs/notes.txt", text("notes")],
		["docs/empty.txt", Buffer.alloc(0)],
		["media/blob.bin", seededBytes(`${seed}/blob`, 1.5 * MIB)],
		["nested/a/b/c.txt", text("c")],
		["Ünïcødé ✓ name.txt".normalize("NFC"), text("unicode")],
		["space name.txt", text("space")]
	])

	if (dotEntries) {
		files.set(".hidden.txt", text("hidden"))
		files.set(".dotdir/inside.txt", text("inside"))
	}

	return { files, emptyDirs: ["empty-dir"] }
}

export function writeTree(root: string, tree: Tree): void {
	mkdirSync(root, { recursive: true })

	for (const [relPath, bytes] of tree.files) {
		const file = path.join(root, ...relPath.split("/"))

		mkdirSync(path.dirname(file), { recursive: true })
		writeFileSync(file, bytes)
	}

	for (const dir of tree.emptyDirs) {
		mkdirSync(path.join(root, ...dir.split("/")), { recursive: true })
	}
}

// A tree as a snapshot without identities: what both sides must hold by content.
export function treeSnapshot(tree: Tree): Snapshot {
	const snapshot: Snapshot = new Map()
	const addParents = (relPath: string) => {
		for (let dir = path.posix.dirname(relPath); dir !== "."; dir = path.posix.dirname(dir)) {
			snapshot.set(dir, { kind: "dir", size: 0, sha256: null, identity: null })
		}
	}

	for (const [relPath, bytes] of tree.files) {
		addParents(relPath)
		snapshot.set(relPath, {
			kind: "file",
			size: bytes.length,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			identity: null
		})
	}

	for (const dir of tree.emptyDirs) {
		addParents(dir)
		snapshot.set(dir, { kind: "dir", size: 0, sha256: null, identity: null })
	}

	return snapshot
}

export interface PairFixture {
	name: string
	mode: DesktopSyncMode
	// Where the tree starts: on disk, or in the cloud.
	seed: "local" | "cloud"
}

// Chain P: three pairs set up through the 4.x app on a clean machine. No dot entries: what 4.x does with them by
// default is not what this chain tests.
export const PREVIOUS_PAIRS: readonly PairFixture[] = [
	{ name: "e2e-twoway", mode: "twoWay", seed: "local" },
	{ name: "e2e-l2r", mode: "localToRemote", seed: "local" },
	{ name: "e2e-r2l", mode: "remoteToLocal", seed: "cloud" }
]

// Paths (relative to a pair root) whose content or identity may differ from the baseline after the update, per pair.
// Chain P expects no change at all: N-1 -> N must neither transfer nor rewrite anything.
export const PREVIOUS_DELTAS: Readonly<Record<string, readonly string[]>> = {}
