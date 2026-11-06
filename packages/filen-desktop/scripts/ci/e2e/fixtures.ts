import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { DesktopSyncMode, DesktopSyncUnsyncableReason } from "@filen/shared/desktop"
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

// The fixture's 0-byte file.
export const EMPTY_FILE = "docs/empty.txt"

const BLOB_BYTES = 1.5 * MIB
// A tree's multi-chunk file per seed. Every side and client rule of a pair asks for a new tree of the same seed, and
// hashing 1.5 MiB again each time is most of what building one costs. Shared by every tree of its seed, never written.
const blobs = new Map<string, Buffer>()

function blobOf(seed: string): Buffer {
	let blob = blobs.get(seed)

	if (blob === undefined) {
		blob = seededBytes(`${seed}/blob`, BLOB_BYTES)
		blobs.set(seed, blob)
	}

	return blob
}

// The shape every pair syncs: a nested file, an empty file, one of more than one chunk, unicode and space names and an
// empty directory. `dotEntries` adds a hidden file and directory, which an excludeDotFiles pair keeps on its seeded side.
export function fixtureTree(seed: string, dotEntries: boolean): Tree {
	const text = (name: string) => Buffer.from(`${seed} ${name}\n${seededBytes(`${seed}/${name}`, 96).toString("hex")}\n`)
	const files = new Map<string, Buffer>([
		["docs/notes.txt", text("notes")],
		[EMPTY_FILE, Buffer.alloc(0)],
		["media/blob.bin", blobOf(seed)],
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

// The old client's sync modes, as its pair config names them.
export type LegacyMode = "twoWay" | "localToCloud" | "cloudToLocal" | "localBackup" | "cloudBackup"

export interface LegacyPairFixture extends PairFixture {
	legacyMode: LegacyMode
	excludeDotFiles: boolean
	localTrashDisabled: boolean
}

// Chain L: one pair per 3.x mode, the two switches mixed. Every tree has dot entries; with excludeDotFiles they stay on
// the seeded side.
export const LEGACY_PAIRS: readonly LegacyPairFixture[] = [
	{ name: "e2e-twoway", legacyMode: "twoWay", mode: "twoWay", excludeDotFiles: true, localTrashDisabled: false, seed: "local" },
	{ name: "e2e-l2c", legacyMode: "localToCloud", mode: "localToRemote", excludeDotFiles: false, localTrashDisabled: true, seed: "local" },
	{ name: "e2e-c2l", legacyMode: "cloudToLocal", mode: "remoteToLocal", excludeDotFiles: true, localTrashDisabled: true, seed: "cloud" },
	{ name: "e2e-lbak", legacyMode: "localBackup", mode: "localBackup", excludeDotFiles: false, localTrashDisabled: false, seed: "local" },
	{ name: "e2e-cbak", legacyMode: "cloudBackup", mode: "remoteBackup", excludeDotFiles: true, localTrashDisabled: false, seed: "cloud" }
]

// What each side of a pair holds once the old client converged: the seeded side the whole tree, the other side the
// tree without dot entries when they are excluded, and without the empty file where the old client leaves 0-byte files
// out (LegacyPin.syncsEmptyFiles).
export function legacySideTree(pair: LegacyPairFixture, side: "local" | "cloud", syncsEmptyFiles = true): Tree {
	const tree = fixtureTree(`legacy/${pair.name}`, pair.seed === side || !pair.excludeDotFiles)

	if (!syncsEmptyFiles && pair.seed !== side) {
		tree.files.delete(EMPTY_FILE)
	}

	return tree
}

// The old client's local trash directory in a pair root.
export const LEGACY_LOCAL_TRASH = ".filen.trash.local"

// What a pair's local root holds once the old client converged: its side's tree, and in a pair the old client filled
// by downloads its local trash directory, empty. filen-sync 0.3.7 writes every download to
// <root>/.filen.trash.local/<uuid> and moves it into place, whatever localTrashDisabled says; deletions would add to it
// with local trash on, and the fixtures make none.
export function legacyLocalTree(pair: LegacyPairFixture, syncsEmptyFiles = true): Tree {
	const tree = legacySideTree(pair, "local", syncsEmptyFiles)

	return pair.seed === "cloud" ? { files: tree.files, emptyDirs: [...tree.emptyDirs, LEGACY_LOCAL_TRASH] } : tree
}

// The edits made while the old client is closed: one on disk, one in the cloud. N's first passes carry exactly these.
export const LEGACY_EDITS = {
	local: { pair: "e2e-twoway", path: "docs/notes.txt", bytes: seededBytes("legacy/edit-local", 3000) },
	cloud: { pair: "e2e-c2l", path: "media/blob.bin", bytes: seededBytes("legacy/edit-cloud", 1.25 * MIB) }
} as const

// The deletions made while the old client is closed, in the two-way pair: one file deleted on disk, another in the
// cloud. N imports none of the old client's sync state, so it finds each on one side only and copies it back (accepted:
// such a deletion is not carried over). Neither is the 0-byte file nor an edited path.
export const LEGACY_DELETIONS = {
	local: { pair: "e2e-twoway", path: "nested/a/b/c.txt" },
	cloud: { pair: "e2e-twoway", path: "space name.txt" }
} as const

export interface LegacyDelta {
	pair: string
	side: "local" | "cloud"
	path: string
	// `rules`: the root .filenignore the migration writes for an excludeDotFiles pair (holding the dot-file rules), and
	// for a pair that pushes, its upload. `edit`: a closed-app edit arriving on the other side. `binned`: the old local
	// trash, which the engine's first pass moves into the pair's bin (gone from the root, with everything in it).
	// `filled`: the empty file an old client that leaves 0-byte files out never brought over, which N carries.
	// `restored`: a closed-app deletion undone, the file back on the side it was deleted from (LEGACY_DELETIONS).
	change: "rules" | "edit" | "binned" | "filled" | "restored"
}

// Everything N may change against the old client's converged state plus the closed-app edits and deletions; anything
// else differing fails.
// The rule file is one of the two differences a migration may make visible (the other is the localTrashNowOn notice of
// pairs that had local trash off, which the overview carries).
export const LEGACY_DELTAS: readonly LegacyDelta[] = [
	...LEGACY_PAIRS.filter(pair => pair.excludeDotFiles).map((pair): LegacyDelta => ({
		pair: pair.name,
		side: "local",
		path: ".filenignore",
		change: "rules"
	})),
	...LEGACY_PAIRS.filter(
		pair => pair.excludeDotFiles && (pair.mode === "twoWay" || pair.mode === "localToRemote" || pair.mode === "localBackup")
	).map((pair): LegacyDelta => ({ pair: pair.name, side: "cloud", path: ".filenignore", change: "rules" })),
	{ pair: LEGACY_EDITS.cloud.pair, side: "local", path: LEGACY_EDITS.cloud.path, change: "edit" },
	...LEGACY_PAIRS.filter(pair => legacyLocalTree(pair).emptyDirs.includes(LEGACY_LOCAL_TRASH)).map((pair): LegacyDelta => ({
		pair: pair.name,
		side: "local",
		path: LEGACY_LOCAL_TRASH,
		change: "binned"
	})),
	{ pair: LEGACY_DELETIONS.local.pair, side: "local", path: LEGACY_DELETIONS.local.path, change: "restored" },
	{ pair: LEGACY_DELETIONS.cloud.pair, side: "cloud", path: LEGACY_DELETIONS.cloud.path, change: "restored" }
]

// What is wrong with the closed-app deletions after N's first passes: each file must be back on both sides with its
// original bytes. `local` holds each pair's tree on disk, `cloud` the chain's cloud directory (paths under the pair).
export function restoredProblems(local: ReadonlyMap<string, Snapshot>, cloud: Snapshot): string[] {
	return Object.values(LEGACY_DELETIONS).flatMap(({ pair, path: relPath }) => {
		const fixture = LEGACY_PAIRS.find(item => item.name === pair)
		const bytes = fixture === undefined ? undefined : legacySideTree(fixture, "local").files.get(relPath)
		const want = bytes === undefined ? null : createHash("sha256").update(bytes).digest("hex")
		const sides: [string, Snapshot | undefined, string][] = [
			["disk", local.get(pair), relPath],
			["cloud", cloud, `${pair}/${relPath}`]
		]

		return sides.flatMap(([side, tree, key]) => {
			const node = tree?.get(key)

			return node?.kind === "file" && want !== null && node.sha256 === want
				? []
				: [`${side} ${pair}/${relPath}: ${node === undefined ? "missing" : "not its original bytes"}`]
		})
	})
}

// The empty file per pair on the side an old client that leaves 0-byte files out (LegacyPin.syncsEmptyFiles) never
// filled: N's first passes put it there (a held pair's once it starts), every mode carrying it to its other side.
export function legacyEmptyFills(syncsEmptyFiles: boolean): LegacyDelta[] {
	return syncsEmptyFiles
		? []
		: LEGACY_PAIRS.map(pair => ({
				pair: pair.name,
				side: pair.seed === "local" ? "cloud" : "local",
				path: EMPTY_FILE,
				change: "filled"
			}))
}

// How N's activity names the transfer that brings a delta to its side (a fill, a restored deletion).
export function arrivalActivity(delta: LegacyDelta): string {
	return `${delta.pair}:${delta.side === "cloud" ? "uploaded" : "downloaded"}:${delta.path}`
}

// The closed-app edit in the two-way pair is a conflict for N, which imports none of the old client's sync history:
// both sides hold the path and they differ. The engine holds it for the user (no copy is made until it is resolved),
// so the disk keeps the edit and the cloud the old bytes. Exactly these conflicts, per pair, and no other.
export const LEGACY_CONFLICTS: Readonly<Record<string, readonly string[]>> = {
	[LEGACY_EDITS.local.pair]: [LEGACY_EDITS.local.path]
}

// Chain P's names pair (chains/realWorld.ts): names a real drive holds, seeded on both sides of one two-way pair, and
// what each OS's engine must make of them. The outcomes are those of the engine's names fix (sdk-rs 0.5.19: one
// device-legality check for cloud names, an NFD local name kept as spelled and uploaded, NFC name hashing, a trailing dot
// never renamed in the cloud); E2E_NAMES_CHECK=0 turns the check off.
//   synced      on both sides with the same bytes; a cloud-seeded item keeps its uuid and exact name
//   unsyncable  reported by the pair (at `reportedAs`, else its own path) and left on its side alone
//   ignored     a built-in ignore rule: left on its side, not reported as unsyncable
export const NAMES_PAIR = "e2e-names"

export type NameOs = "linux" | "win" | "mac"
export type NameOutcome = "synced" | "unsyncable" | "ignored"

export interface NameFixture {
	// As seeded: the exact spelling ("/"-separated, NFD where it says so).
	path: string
	side: "local" | "cloud"
	// Seeded on that OS only.
	only?: NameOs
	outcome: NameOutcome | Readonly<Record<NameOs, NameOutcome>>
	// The path the pair reports or ignores instead of `path` (a directory above it).
	reportedAs?: string
	// The bytes: `size` seeded bytes of the path, or a link's target's (`link`).
	size?: number
	// A symlink (a junction for a directory on Windows) to `target`: in the root (relative to it) or outside it ("@out/").
	link?: { target: string; dir: boolean }
	// macOS has no attribute: Windows only.
	hidden?: boolean
}

// What Windows cannot hold (a device name, a forbidden character, a trailing dot) is pulled everywhere else.
const WINDOWS_ONLY_REFUSES: Readonly<Record<NameOs, NameOutcome>> = { linux: "synced", win: "unsyncable", mac: "synced" }
const LONG_CLOUD_DIRS = Array.from({ length: 6 }, (_, index) => `long-dir-${String(index)}-`.padEnd(45, "x"))
const LONG_LOCAL_DIRS = Array.from({ length: 4 }, (_, index) => `deep-${String(index)}-`.padEnd(59, "y"))
// The built-in ignore rules (sdk-rs DEFAULT_IGNORE_PATTERNS), one entry each; a directory rule by a file inside it.
const DEFAULT_IGNORED = [
	".DS_Store",
	"._resource",
	".Spotlight-V100/x",
	".fseventsd/x",
	".TemporaryItems/x",
	".DocumentRevisions-V100/x",
	".Trashes/x",
	"Thumbs.db",
	"ehthumbs.db",
	"ehthumbs_vista.db",
	"desktop.ini",
	"$RECYCLE.BIN/x",
	"System Volume Information/x",
	"~$budget.xlsx",
	".~lock.doc.odt#",
	"a.swp",
	"a.swo",
	"a.swn",
	".#notes.org",
	"x.crdownload"
]

export const NAME_FIXTURES: readonly NameFixture[] = [
	// Cloud: written by rclone, whose filen backend checks no name.
	{ path: "aux.c", side: "cloud", outcome: WINDOWS_ONLY_REFUSES },
	{ path: "CON", side: "cloud", outcome: WINDOWS_ONLY_REFUSES },
	{ path: "Q&A: what?.txt", side: "cloud", outcome: WINDOWS_ONLY_REFUSES },
	{ path: "trailing dot.", side: "cloud", outcome: WINDOWS_ONLY_REFUSES },
	{ path: "bad:dir/child.txt", side: "cloud", outcome: WINDOWS_ONLY_REFUSES, reportedAs: "bad:dir" },
	{ path: "bad:dir/sub/grand.txt", side: "cloud", outcome: WINDOWS_ONLY_REFUSES, reportedAs: "bad:dir" },
	{ path: "naïve.txt", side: "cloud", outcome: "synced" },
	{ path: [...LONG_CLOUD_DIRS, `${"long-file-".padEnd(196, "z")}.txt`].join("/"), side: "cloud", outcome: "synced" },
	{ path: "Notes.md", side: "cloud", outcome: "synced" },
	// Local.
	{ path: "Report.txt", side: "local", outcome: "synced" },
	{ path: "café.txt", side: "local", outcome: "synced" },
	{ path: "Résumé/cv.txt", side: "local", outcome: "synced" },
	{ path: "🎉 party 👩‍💻.txt", side: "local", outcome: "synced" },
	{ path: "rtl ‏mark.txt", side: "local", outcome: "synced" },
	{ path: "invoice ‮txt.exe", side: "local", outcome: "synced" },
	{ path: `${"n".repeat(251)}.txt`, side: "local", outcome: "synced" },
	{ path: [...LONG_LOCAL_DIRS, `${"file-".padEnd(56, "w")}.txt`].join("/"), side: "local", outcome: "synced" },
	...DEFAULT_IGNORED.map((path): NameFixture => {
		const dir = path.endsWith("/x") ? path.slice(0, -2) : undefined

		return { path, side: "local", outcome: "ignored", ...(dir === undefined ? {} : { reportedAs: dir }) }
	}),
	{ path: ".env", side: "local", outcome: "synced" },
	{ path: ".config/x", side: "local", outcome: "synced" },
	// Links: followed and synced as what they lead to, but a directory link inside the root is an alias of its target.
	{ path: "real-dir/inside.txt", side: "local", outcome: "synced" },
	{ path: "alias-dir", side: "local", outcome: "unsyncable", link: { target: "real-dir", dir: true } },
	{ path: "linked-out", side: "local", outcome: "synced", link: { target: "@out/outside", dir: true } },
	{ path: "file-link.txt", side: "local", outcome: "synced", link: { target: "real-dir/inside.txt", dir: false } },
	// Windows: a name NTFS holds but longer than the 255 bytes a cloud name may take, and a hidden file.
	{ path: `${"文件名".repeat(32)}.txt`, side: "local", only: "win", outcome: "unsyncable" },
	{ path: "hidden.txt", side: "local", only: "win", outcome: "synced", hidden: true },
	// macOS: a colon (a slash in Finder) and a directory with a trailing space, both refused as cloud names.
	{ path: "Invoice 1:2.pdf", side: "local", only: "mac", outcome: "unsyncable" },
	{ path: "Folder /x.txt", side: "local", only: "mac", outcome: "unsyncable", reportedAs: "Folder " },
	// Linux: two names the cloud folds into one, and a character the cloud refuses.
	{ path: "Data.txt", side: "local", only: "linux", outcome: "unsyncable" },
	{ path: "data.txt", side: "local", only: "linux", outcome: "unsyncable" },
	{ path: "What?.txt", side: "local", only: "linux", outcome: "unsyncable" },
	{ path: "big.bin", side: "local", outcome: "synced", size: 48 * MIB }
]

// The file a link leads outside the root to, under "@out/" (the chain's work directory).
export const NAMES_OUTSIDE_FILE = "outside.txt"

// The fixtures seeded on `os`, with that OS's outcome.
export function namesFor(os: NameOs): (NameFixture & { expect: NameOutcome })[] {
	return NAME_FIXTURES.filter(fixture => fixture.only === undefined || fixture.only === os).map(fixture => ({
		...fixture,
		expect: typeof fixture.outcome === "string" ? fixture.outcome : fixture.outcome[os]
	}))
}

// A fixture's bytes: its own, or for a link to a file, its target's.
export function nameBytes(fixture: NameFixture): Buffer {
	if (fixture.link !== undefined && !fixture.link.dir) {
		return nameBytes({ path: fixture.link.target, side: fixture.side, outcome: "synced" })
	}

	return seededBytes(`names/${fixture.path}`, fixture.size ?? 64)
}

// The bytes of the file a directory link outside the root leads to.
export function outsideBytes(): Buffer {
	return seededBytes(`names/@out/${NAMES_OUTSIDE_FILE}`, 64)
}

// The unsyncable paths `os` must report (NFC, as the engine keys them).
export function expectedUnsyncable(os: NameOs): string[] {
	return [
		...new Set(
			namesFor(os)
				.filter(fixture => fixture.expect === "unsyncable")
				.map(fixture => (fixture.reportedAs ?? fixture.path).normalize("NFC"))
		)
	].sort()
}

// Why `os` must report its unsyncable cloud-seeded paths: a cloud name this device can't store (sdk-rs
// RemoteNameNotStorable). The device-seeded ones are left to the engine's own reasons.
export function expectedCloudReasons(os: NameOs): Map<string, DesktopSyncUnsyncableReason> {
	return new Map(
		namesFor(os)
			.filter(fixture => fixture.side === "cloud" && fixture.expect === "unsyncable")
			.map((fixture): [string, DesktopSyncUnsyncableReason] => [
				(fixture.reportedAs ?? fixture.path).normalize("NFC"),
				"remoteNameNotStorable"
			])
	)
}

// The phase on N: a case rename on each side and an edit of the cloud's NFD file, each leaving exactly one cloud item.
export const NAMES_RENAMES = {
	local: { from: "Report.txt", to: "report.txt" },
	cloud: { from: "Notes.md", to: "notes.md" },
	edit: { path: "naïve.txt", bytes: seededBytes("names/edit-nfd", 3000) }
} as const
