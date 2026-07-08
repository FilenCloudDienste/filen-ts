import { toast } from "sonner"
import { asErrorDTO } from "@/lib/sdk/errors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { i18n } from "@/lib/i18n"
import { sdkApi } from "@/lib/sdk/client"
import { runCreateDirectory, type CreateDirectoryDeps } from "@/lib/drive/create-directory"
import { runUpload, defaultUploadDeps, type RunUploadDeps } from "@/lib/drive/upload"
import { driveListingQueryUpdate } from "@/queries/drive"

// Directory upload: pick/drop a whole directory and recreate its sub-directory tree in the current
// listing, uploading every file into its recreated parent. The wasm SDK has no recursive-upload
// primitive, so this module walks the picked tree in JS, creates each sub-directory
// parent-before-child via runCreateDirectory (create-directory.ts — the RAW worker op only caches
// worker-side, it never patches the query cache, so a created sub-directory would stay invisible
// until a refetch), then fans the files out through runUpload (upload.ts) exactly like a plain
// multi-file upload.

// ---------------------------------------------------------------------------
// collectDirectoryUploads — normalize both directory-pick shapes into one flat file list (each
// carrying its directory-relative path) plus the unique sub-directory paths to recreate.
// ---------------------------------------------------------------------------

export interface CollectedFile {
	file: File
	relPath: string
}

export interface CollectedDirectoryUpload {
	// Every unique sub-directory path to recreate, INCLUDING empty ones — e.g. picking "myfolder"
	// containing "sub/a.txt" yields ["myfolder", "myfolder/sub"]. Unordered; runDirectoryUpload sorts
	// by depth before creating anything.
	dirs: string[]
	files: CollectedFile[]
}

// The two shapes a directory pick arrives in: a `webkitdirectory` file input's FileList, already
// flattened to File[] by the caller (upload-menu.tsx) — each File carries its own
// `webkitRelativePath`; or a drag-and-drop's top-level FileSystemEntry list (upload-dropzone.tsx),
// which this module walks itself. Both normalize to the same { dirs, files } shape.
export type DirectoryUploadInput = { kind: "files"; files: File[] } | { kind: "entries"; entries: FileSystemEntry[] }

export async function collectDirectoryUploads(input: DirectoryUploadInput): Promise<CollectedDirectoryUpload> {
	if (input.kind === "files") {
		return collectFromFiles(input.files)
	}

	return collectFromEntries(input.entries)
}

// A `webkitdirectory` FileList carries no directory entries of its own — only files, each stamped
// with `webkitRelativePath` (e.g. "myfolder/sub/a.txt"). The sub-directory set is every unique
// ancestor of every file's path.
//
// PLATFORM LIMITATION (not fixable from here): a completely empty directory — the top-level pick
// itself, or any nested sub-directory with zero files anywhere in its own subtree — has no file to
// derive its path from, so it is invisible to this API and can't be recreated. The DnD entries path
// below does not share this gap: a FileSystemDirectoryEntry is visited (and so still recorded)
// regardless of whether it turns out to have children.
function collectFromFiles(files: File[]): CollectedDirectoryUpload {
	const dirs = new Set<string>()
	const collected: CollectedFile[] = []

	for (const file of files) {
		const relPath = file.webkitRelativePath
		collected.push({ file, relPath })

		for (const ancestor of ancestorPaths(relPath)) {
			dirs.add(ancestor)
		}
	}

	return { dirs: [...dirs], files: collected }
}

// DnD directory entries carry the real tree structure: `dirs.add` runs for every directory entry
// this walks into regardless of whether it has children, so an empty sub-directory is still
// recreated (unlike the FileList path above).
async function collectFromEntries(entries: FileSystemEntry[]): Promise<CollectedDirectoryUpload> {
	const dirs = new Set<string>()
	const files: CollectedFile[] = []

	async function walk(entry: FileSystemEntry, relPath: string): Promise<void> {
		if (isDirectoryEntry(entry)) {
			dirs.add(relPath)

			const children = await readAllEntries(entry.createReader())

			await Promise.all(children.map(child => walk(child, `${relPath}/${child.name}`)))

			return
		}

		if (isFileEntry(entry)) {
			files.push({ file: await readFileEntry(entry), relPath })
		}
	}

	await Promise.all(entries.map(entry => walk(entry, entry.name)))

	return { dirs: [...dirs], files }
}

// FileSystemEntry's isDirectory/isFile are plain booleans, not literal-typed discriminants — TS
// can't narrow on them by itself, so these two predicates are the cast-free way to get from
// FileSystemEntry to its Directory/File subtype.
function isDirectoryEntry(entry: FileSystemEntry): entry is FileSystemDirectoryEntry {
	return entry.isDirectory
}

function isFileEntry(entry: FileSystemEntry): entry is FileSystemFileEntry {
	return entry.isFile
}

// FileSystemDirectoryReader.readEntries is callback-based AND paginated by spec (a large directory
// can need more than one call) — read until a call returns an empty batch.
function readEntriesBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
	return new Promise((resolve, reject) => {
		reader.readEntries(
			entries => {
				resolve(entries)
			},
			error => {
				reject(error)
			}
		)
	})
}

async function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
	const all: FileSystemEntry[] = []

	for (;;) {
		const batch = await readEntriesBatch(reader)

		if (batch.length === 0) {
			return all
		}

		all.push(...batch)
	}
}

function readFileEntry(entry: FileSystemFileEntry): Promise<File> {
	return new Promise((resolve, reject) => {
		entry.file(
			file => {
				resolve(file)
			},
			error => {
				reject(error)
			}
		)
	})
}

// The containing directory's relPath, or null for a top-level entry with no ancestor — "a/b/c.txt"
// -> "a/b", "a.txt" -> null. Shared by the dir-creation loop (a dir's own parent) and the file
// fan-out (a file's containing dir) in runDirectoryUpload below.
function dirnameOf(relPath: string): string | null {
	const index = relPath.lastIndexOf("/")

	return index === -1 ? null : relPath.slice(0, index)
}

// The final path segment — the `name` runCreateDirectory creates.
function basenameOf(relPath: string): string {
	const index = relPath.lastIndexOf("/")

	return index === -1 ? relPath : relPath.slice(index + 1)
}

// Every proper ancestor path of a relPath (order irrelevant — runDirectoryUpload re-sorts by depth).
function ancestorPaths(relPath: string): string[] {
	const ancestors: string[] = []
	let current = dirnameOf(relPath)

	while (current !== null) {
		ancestors.push(current)
		current = dirnameOf(current)
	}

	return ancestors
}

// Segment count — the depth-ascending sort key so every parent is created before any of its
// children ("a" < "a/b" < "a/b/c").
function depthOf(relPath: string): number {
	return relPath.split("/").length
}

// ---------------------------------------------------------------------------
// runDirectoryUpload — create the collected sub-directories parent-before-child, then upload every
// file into its recreated parent. Never throws: a sub-directory whose parent failed (or was itself
// skipped) skips its whole subtree — dirs and files alike — recording the miss rather than aborting;
// a single failure never strands the rest of the batch (mirrors startUploads' own per-file
// independence, one level up).
// ---------------------------------------------------------------------------

export interface RunDirectoryUploadDeps {
	createDirectory: CreateDirectoryDeps
	upload: RunUploadDeps
}

export async function runDirectoryUpload(
	deps: RunDirectoryUploadDeps,
	args: { rootParentUuid: string | null; dirs: string[]; files: CollectedFile[] }
): Promise<void> {
	const { rootParentUuid, dirs, files } = args

	if (dirs.length === 0 && files.length === 0) {
		return
	}

	// relPath -> the uuid runCreateDirectory returned for it; a path present here created (or
	// idempotently matched an existing directory) successfully. Processing in depth-ascending order
	// means every ancestor's own outcome is already settled by the time a deeper path is resolved, so
	// a plain Map (rather than a per-path ancestor walk) is enough: `undefined` here can only mean
	// "this exact path never got created" — a real ancestor that failed or was itself skipped —
	// because a `parentPath === null` lookup resolves straight to rootParentUuid (string | null,
	// never undefined) instead of going through this map at all.
	const dirUuids = new Map<string, string>()
	const failedDirPaths = new Set<string>()
	let createdDirs = 0

	const orderedDirs = [...dirs].sort((a, b) => depthOf(a) - depthOf(b))

	for (const relPath of orderedDirs) {
		const parentPath = dirnameOf(relPath)
		const parentUuid = parentPath === null ? rootParentUuid : dirUuids.get(parentPath)

		if (parentUuid === undefined) {
			failedDirPaths.add(relPath)
			continue
		}

		const outcome = await runCreateDirectory(deps.createDirectory, parentUuid, basenameOf(relPath))

		if (outcome.status === "error") {
			failedDirPaths.add(relPath)
			continue
		}

		dirUuids.set(relPath, outcome.item.data.uuid)
		createdDirs += 1
	}

	// Files fan out in parallel — no JS queue/semaphore, same rationale as startUploads: the SDK's own
	// Tower layer throttles real upload concurrency, never reimplemented here.
	const fileOutcomes = await Promise.all(
		files.map(async ({ file, relPath }): Promise<boolean> => {
			const parentPath = dirnameOf(relPath)
			const parentUuid = parentPath === null ? rootParentUuid : dirUuids.get(parentPath)

			if (parentUuid === undefined) {
				return false
			}

			const outcome = await runUpload(deps.upload, { parentUuid, file })

			return outcome.status === "success"
		})
	)

	let uploadedFiles = 0

	for (const ok of fileOutcomes) {
		if (ok) {
			uploadedFiles += 1
		}
	}

	const succeeded = createdDirs + uploadedFiles
	const failed = failedDirPaths.size + (fileOutcomes.length - uploadedFiles)

	if (failed === 0) {
		toast.success(i18n.t("transfers:transfersDirectoryUploadSummaryComplete", { count: succeeded }))

		return
	}

	toast.error(i18n.t("transfers:transfersDirectoryUploadSummaryCompleteWithFailures", { count: succeeded, failed }))
}

// ---------------------------------------------------------------------------
// startDirectoryUpload — the menu/dropzone's one call: collect, then run with the real deps. Mirrors
// startUploads' own collect-then-run-with-real-deps shape (upload.ts), one level up (a whole tree
// instead of a flat file list).
// ---------------------------------------------------------------------------

const defaultDirectoryUploadDeps: RunDirectoryUploadDeps = {
	createDirectory: {
		createDirectory: (parentUuid, name) => sdkApi.createDirectory(parentUuid, name),
		patchListing: driveListingQueryUpdate
	},
	upload: defaultUploadDeps
}

export async function startDirectoryUpload(input: DirectoryUploadInput, rootParentUuid: string | null): Promise<void> {
	let collected: CollectedDirectoryUpload

	try {
		collected = await collectDirectoryUploads(input)
	} catch (e) {
		// A hard walk failure (the browser couldn't even enumerate the dropped/picked tree) — nothing
		// partial to report here, unlike runDirectoryUpload's own per-item failures above.
		toast.error(errorLabel(asErrorDTO(e)))

		return
	}

	await runDirectoryUpload(defaultDirectoryUploadDeps, { rootParentUuid, ...collected })
}
