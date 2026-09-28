import { toast } from "sonner"
import { dirnameOf, pathSegmentDepth, sumBytes } from "@filen/shared"
import { asErrorDTO } from "@/lib/sdk/errors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { i18n } from "@/lib/i18n"
import { log } from "@/lib/log"
import { sdkApi } from "@/lib/sdk/client"
import { runCreateDirectory, type CreateDirectoryDeps } from "@/features/drive/lib/createDirectory"
import { runUpload, defaultUploadDeps, type RunUploadDeps, type UploadOutcome } from "@/features/drive/lib/upload"
import {
	defaultHeicUploadDeps,
	heicUploadConversionEnabled,
	maybeConvertHeicUpload,
	type HeicUploadDeps
} from "@/features/drive/lib/heicUpload"
import { driveListingQueryUpdate } from "@/features/drive/queries/drive"
import { checkUploadQuota, quotaExceededMessage } from "@/features/drive/lib/quota"

// Directory upload: pick/drop a whole directory and recreate its sub-directory tree in the current
// listing, uploading every file into its recreated parent. The wasm SDK has no recursive-upload
// primitive, so this module walks the picked tree in JS, creates each sub-directory
// parent-before-child via runCreateDirectory (createDirectory.ts — the RAW worker op only caches
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
	// Entries the browser could not read (a file or sub-directory removed after the drop, an unreadable
	// sub-directory): each is left out, subtree and all, and counted as one failure in the summary.
	skipped: number
}

// The two shapes a directory pick arrives in: a `webkitdirectory` file input's FileList, already
// flattened to File[] by the caller (uploadMenu.tsx) — each File carries its own
// `webkitRelativePath`; or a drag-and-drop's top-level FileSystemEntry list (uploadDropzone.tsx),
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

	return { dirs: [...dirs], files: collected, skipped: 0 }
}

// DnD directory entries carry the real tree structure: `dirs.add` runs for every directory entry
// this reads regardless of whether it has children, so an empty sub-directory is still recreated
// (unlike the FileList path above). One entry the browser fails to read is skipped rather than
// failing the walk, so it never strands the rest of the tree; a directory whose listing fails is not
// recreated as an empty copy. Only when nothing at all was readable does the walk reject, with the
// first error, since there is then no upload to run.
async function collectFromEntries(entries: FileSystemEntry[]): Promise<CollectedDirectoryUpload> {
	const dirs = new Set<string>()
	const files: CollectedFile[] = []
	let skipped = 0
	let firstError: { error: unknown } | undefined

	function skip(relPath: string, e: unknown): void {
		log.warn("upload", "directory walk: skipped unreadable entry", relPath, e)

		skipped += 1
		firstError ??= { error: e }
	}

	async function walk(entry: FileSystemEntry, relPath: string): Promise<void> {
		if (isDirectoryEntry(entry)) {
			let children: FileSystemEntry[]

			try {
				children = await readAllEntries(entry.createReader())
			} catch (e) {
				skip(relPath, e)

				return
			}

			dirs.add(relPath)

			await Promise.all(children.map(child => walk(child, `${relPath}/${child.name}`)))

			return
		}

		if (isFileEntry(entry)) {
			try {
				files.push({ file: await readFileEntry(entry), relPath })
			} catch (e) {
				skip(relPath, e)
			}
		}
	}

	await Promise.all(entries.map(entry => walk(entry, entry.name)))

	if (dirs.size === 0 && files.length === 0 && firstError !== undefined) {
		throw firstError.error
	}

	return { dirs: [...dirs], files, skipped }
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

// The final path segment — the `name` runCreateDirectory creates. Exported alongside dirnameOf for
// import.ts's own reuse.
export function basenameOf(relPath: string): string {
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

// ---------------------------------------------------------------------------
// runDirectoryUpload — create the collected sub-directories parent-before-child, uploading every
// file into its recreated parent as soon as that parent exists. Never throws: a sub-directory whose
// parent failed (or was itself skipped) skips its whole subtree — dirs and files alike — recording the
// miss rather than aborting; a single failure never strands the rest of the batch (mirrors
// startUploads' own per-file independence, one level up).
// ---------------------------------------------------------------------------

export interface RunDirectoryUploadDeps {
	createDirectory: CreateDirectoryDeps
	upload: RunUploadDeps
	heic: HeicUploadDeps
}

export async function runDirectoryUpload(
	deps: RunDirectoryUploadDeps,
	args: { rootParentUuid: string | null; dirs: string[]; files: CollectedFile[]; skipped?: number }
): Promise<void> {
	const { rootParentUuid, dirs, files, skipped = 0 } = args

	if (dirs.length === 0 && files.length === 0 && skipped === 0) {
		return
	}

	// relPath -> its create, settling to the uuid runCreateDirectory returned (a created or
	// idempotently matched directory), or undefined when this path, or an ancestor, failed. Each
	// directory waits only for its own parent, and each file only for its own directory, so siblings
	// are created concurrently and uploads start while the rest of the tree is still being created; the
	// SDK throttles the real request concurrency. Registered in depth order so every parent's entry
	// already exists when a child looks it up; a lookup miss can only be a path that was never
	// collected, which resolves straight to failure.
	const dirUuids = new Map<string, Promise<string | undefined>>()
	// Filen names are case-insensitive: two local paths differing only by case name the same remote
	// directory, so the later create waits for the earlier and idempotently matches it instead of
	// racing it. Keyed by the case-folded path, the value being the last create on that key.
	const nameClaims = new Map<string, Promise<unknown>>()
	const createdUuids: string[] = []
	let failedDirs = 0

	function parentUuidOf(relPath: string): Promise<string | null | undefined> {
		const parentPath = dirnameOf(relPath)

		return parentPath === null ? Promise.resolve(rootParentUuid) : (dirUuids.get(parentPath) ?? Promise.resolve(undefined))
	}

	const orderedDirs = [...dirs].sort((a, b) => pathSegmentDepth(a) - pathSegmentDepth(b))

	for (const relPath of orderedDirs) {
		const name = basenameOf(relPath)
		const claimKey = relPath.toLowerCase()
		const earlierClaim = nameClaims.get(claimKey)

		const created = (async (): Promise<string | undefined> => {
			const parentUuid = await parentUuidOf(relPath)

			if (parentUuid === undefined) {
				failedDirs += 1

				return undefined
			}

			await earlierClaim

			const outcome = await runCreateDirectory(deps.createDirectory, parentUuid, name)

			if (outcome.status === "error") {
				failedDirs += 1

				return undefined
			}

			createdUuids.push(outcome.item.data.uuid)

			return outcome.item.data.uuid
		})()

		dirUuids.set(relPath, created)
		nameClaims.set(claimKey, created)
	}

	// One preference read for the whole walk (see heicUploadConversionEnabled), started alongside the
	// directory creates; the conversion itself stays inside the fan-out below so a converted file
	// uploads as soon as IT is ready.
	const convertHeic = heicUploadConversionEnabled(
		deps.heic,
		files.map(entry => entry.file)
	)

	// Files fan out in parallel — no JS queue/semaphore, same rationale as startUploads: the SDK's own
	// Tower layer throttles real upload concurrency, never reimplemented here.
	const [fileOutcomes] = await Promise.all([
		Promise.all(
			files.map(async ({ file, relPath }): Promise<UploadOutcome["status"]> => {
				const parentUuid = await parentUuidOf(relPath)

				if (parentUuid === undefined) {
					return "error"
				}

				// renameToJpg only rewrites file.name; `relPath` is untouched and still resolved the parent above.
				const prepared = await maybeConvertHeicUpload(deps.heic.convert, file, await convertHeic)

				return (await runUpload(deps.upload, { parentUuid, file: prepared })).status
			})
		),
		// A directory with no file under it is still awaited, so its outcome is counted.
		Promise.all(dirUuids.values())
	])

	const uploadedFiles = fileOutcomes.filter(status => status === "success").length

	if (createdUuids.length > 0 || uploadedFiles > 0) {
		deps.upload.invalidateDirectorySizes?.(rootParentUuid, createdUuids)
	}

	const succeeded = createdUuids.length + uploadedFiles
	const failed = failedDirs + skipped + fileOutcomes.filter(status => status === "error").length

	// Everything that ran was cancelled by the user: nothing to report.
	if (succeeded === 0 && failed === 0) {
		return
	}

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
	upload: defaultUploadDeps,
	heic: defaultHeicUploadDeps
}

// Both call sites (uploadMenu.tsx's directory picker, uploadDropzone.tsx's DnD drop) fire this
// off with `void`, and the tree walk below (collectDirectoryUploads) can run for a while on a large
// local directory with nothing else on screen changing — no transfer row exists yet, since none of the
// files/dirs it discovers are known until the walk finishes. A loading toast is the spinner/indicator
// for that gap: shown the instant the walk starts, replaced by the real error toast in place (same
// `id`, so it's a swap, not a second toast) if the walk itself fails, or dismissed once it resolves and
// the (now known) tree starts actually uploading — runDirectoryUpload's own success/failure summary
// toast takes over from there.
export async function startDirectoryUpload(input: DirectoryUploadInput, rootParentUuid: string | null): Promise<void> {
	const scanningToastId = toast.loading(i18n.t("transfers:transfersScanningDirectory"))
	let collected: CollectedDirectoryUpload

	try {
		collected = await collectDirectoryUploads(input)
	} catch (e) {
		// A hard walk failure (the browser couldn't even enumerate the dropped/picked tree) — nothing
		// partial to report here, unlike runDirectoryUpload's own per-item failures above.
		toast.error(errorLabel(asErrorDTO(e)), { id: scanningToastId })

		return
	}

	// Checked before any sub-directory is created, so a blocked upload leaves nothing behind.
	const verdict = await checkUploadQuota(sumBytes(collected.files.map(entry => entry.file.size)))

	if (verdict.status === "exceeds") {
		toast.error(quotaExceededMessage(verdict), { id: scanningToastId })

		return
	}

	toast.dismiss(scanningToastId)

	await runDirectoryUpload(defaultDirectoryUploadDeps, { rootParentUuid, ...collected })
}
