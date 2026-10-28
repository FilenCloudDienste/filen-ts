import type { Dir, File } from "@filen/sdk-rs"
import { VIDEOS_DIR_NAME, activeLibraryRoots, withoutLibraryRoot } from "@filen/shared/videos"
import { sdkApi } from "@/lib/sdk/client"
import { DOT_FILEN_DIR_NAME } from "@/lib/dotFilen"
import { ensureLibraryConfig, setLibraryAccount, updateLibraryConfig } from "@/features/videos/lib/library"
import { isScratchDebrisName } from "@/e2e-hooks/scratchDebris"

// `.filen/videos` (the synced library configuration and watch state) as a test found it, so the test can put
// the account back the way it was. The e2e account is shared by every run and browser: a Videos spec that leaves
// its library directory or watch progress behind changes what the next one starts from. Every lookup here lists
// the server afresh, never the app's memoized `.filen` directories, which a restore's deletes leave stale.

export interface VideosSyncFile {
	name: string
	uuid: string
	// Every version uuid the file had, head first.
	versions: string[]
	text: string
}

export interface VideosSyncSnapshot {
	// `.filen` and `.filen/videos`, null for one that didn't exist.
	dotFilen: string | null
	dir: string | null
	files: VideosSyncFile[]
}

function fileName(file: File): string {
	return file.meta.type === "decoded" ? file.meta.data.name : ""
}

function dirNamed(dirs: readonly Dir[], name: string): Dir | undefined {
	const wanted = name.toLowerCase()

	return dirs.find(dir => dir.meta.type === "decoded" && dir.meta.data.name.toLowerCase() === wanted)
}

async function findDotFilen(): Promise<Dir | undefined> {
	return dirNamed((await sdkApi.listDirectory({ kind: "root" })).dirs, DOT_FILEN_DIR_NAME)
}

async function findVideosDir(): Promise<string | null> {
	const dotFilen = await findDotFilen()

	if (dotFilen === undefined) {
		return null
	}

	return dirNamed((await sdkApi.listDirectory({ kind: "uuid", uuid: dotFilen.uuid })).dirs, VIDEOS_DIR_NAME)?.uuid ?? null
}

async function removeDirectory(uuid: string): Promise<void> {
	const directory = await sdkApi.getDirectory(uuid)

	if (directory !== undefined) {
		await sdkApi.deleteDirectoryPermanently(await sdkApi.trashDirectory(directory))
	}
}

async function listSyncFiles(dir: string): Promise<File[]> {
	return (await sdkApi.listDirectory({ kind: "uuid", uuid: dir })).files
}

async function readText(file: File): Promise<string> {
	return new TextDecoder().decode(await sdkApi.downloadFileBytes(file, crypto.randomUUID()))
}

export async function videosSyncSnapshot(): Promise<VideosSyncSnapshot> {
	const dotFilen = (await findDotFilen())?.uuid ?? null
	const dir = await findVideosDir()

	if (dir === null) {
		return { dotFilen, dir: null, files: [] }
	}

	const files = await Promise.all(
		(await listSyncFiles(dir)).map(async file => ({
			name: fileName(file),
			uuid: file.uuid,
			versions: (await sdkApi.listFileVersionsOp(file)).map(version => version.uuid),
			text: await readText(file)
		}))
	)

	// By name, so two snapshots of the same state compare equal whatever order the listing returned.
	return { dotFilen, dir, files: files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) }
}

// The current text of `.filen/videos/<name>`, read fresh from the server; null when there is no such file.
export async function videosSyncFileText(name: string): Promise<string | null> {
	const dir = await findVideosDir()

	if (dir === null) {
		return null
	}

	const file = (await listSyncFiles(dir)).find(candidate => fileName(candidate) === name)

	return file === undefined ? null : readText(file)
}

// Archived versions first: deleting a head that still has versions leaves the newest of them as an invisible head.
async function deleteVersionsExcept(file: File, keep: ReadonlySet<string>): Promise<void> {
	for (const version of await sdkApi.listFileVersionsOp(file)) {
		if (version.uuid !== file.uuid && !keep.has(version.uuid)) {
			await sdkApi.deleteFileVersionOp(version)
		}
	}
}

async function removeFile(file: File): Promise<void> {
	await deleteVersionsExcept(file, new Set())
	await sdkApi.deleteFilePermanently(await sdkApi.trashFile(file))
}

// Puts `.filen/videos` back as `snapshot` found it: files the test added go, files it saved over get their earlier
// version back as the head and lose the versions written since, and directories the test created go entirely.
// Run it from a page where Videos was not opened since the last load, so nothing saves its own copy back.
export async function videosSyncRestore(snapshot: VideosSyncSnapshot): Promise<void> {
	const dir = await findVideosDir()

	if (dir === null) {
		return
	}

	for (const file of await listSyncFiles(dir)) {
		const before = snapshot.dir === dir ? snapshot.files.find(candidate => candidate.name === fileName(file)) : undefined

		if (before === undefined) {
			await removeFile(file)

			continue
		}

		if (file.uuid === before.uuid) {
			continue
		}

		const keep = new Set(before.versions)
		const original = (await sdkApi.listFileVersionsOp(file)).find(version => version.uuid === before.uuid)
		const head =
			original === undefined
				? await sdkApi.uploadFileBytes(dir, new TextEncoder().encode(before.text), before.name, "application/json")
				: await sdkApi.restoreFileVersionOp(file, original)

		await deleteVersionsExcept(head, keep)
	}

	if (snapshot.dir === dir) {
		return
	}

	await removeDirectory(dir)

	const dotFilen = await findDotFilen()

	if (snapshot.dotFilen === null && dotFilen !== undefined) {
		const left = await sdkApi.listDirectory({ kind: "uuid", uuid: dotFilen.uuid })

		if (left.dirs.length === 0 && left.files.length === 0) {
			await removeDirectory(dotFilen.uuid)
		}
	}
}

// Library roots a killed run left behind, removed through the app's own configuration edit (a tombstone, as the
// Libraries dialog writes): roots whose directory is gone or trashed, and scratch-named ones older than
// `minAgeMs`. Without this a later run snapshots the leftover root and restores it, and they pile up. Returns how
// many were removed; nothing is read or written when `.filen/videos` doesn't exist.
export async function pruneDeadVideoRoots(minAgeMs: number): Promise<number> {
	if ((await findVideosDir()) === null) {
		return 0
	}

	setLibraryAccount(await sdkApi.videoIndexAccount())

	const { doc } = await ensureLibraryConfig(null)
	const cutoff = Date.now() - minAgeMs
	const dead: string[] = []

	for (const root of activeLibraryRoots(doc)) {
		const dir = await sdkApi.getDirectory(root.dirUuid)
		const name = dir?.meta.type === "decoded" ? dir.meta.data.name : ""

		if (dir === undefined || dir.parent === "trash" || (isScratchDebrisName(name) && Number(dir.timestamp) <= cutoff)) {
			dead.push(root.dirUuid)
		}
	}

	if (dead.length > 0) {
		const at = Date.now()

		await updateLibraryConfig((current, stamp) =>
			dead.reduce((next, dirUuid) => withoutLibraryRoot({ doc: next, dirUuid, stamp, at }), current)
		)
	}

	return dead.length
}
