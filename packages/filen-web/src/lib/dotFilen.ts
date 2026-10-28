import type { Dir, DirMeta, SocketEvent } from "@filen/sdk-rs"
import { type } from "arktype"
import { dotFilenSubdirLookupNames, dotFilenSubdirRename, isDotFilenSubdirName, nameCollisionKey } from "@filen/shared"
import { sdkApi } from "@/lib/sdk/client"
import { accountQueryGet } from "@/queries/account"
import { runOp } from "@/lib/actions/outcome"
import { registerSocketHandler } from "@/lib/sdk/socket"
import { narrowItem } from "@/features/drive/lib/item"
import { isPhotoCandidate } from "@/features/photos/lib/predicate"
import { DOT_FILEN_DIR_NAME } from "@/lib/dotFilen.logic"
import { log } from "@/lib/log"
import { kvLoadOnce, kvSetJsonQuiet } from "@/lib/storage/kvBestEffort"

// The app's own directories under `.filen` at the drive root (DOT_FILEN_SUBDIRS in @filen/shared), resolved once
// per session and shared by every feature. Each level is found by name hash, one request that lists, decrypts and
// locks nothing. A read only finds; a write finds first and creates only a missing level. createDirectory is
// find-or-create, idempotent and case-insensitive server-side, so concurrent creates elsewhere still end on one
// directory.

export { DOT_FILEN_DIR_NAME } from "@/lib/dotFilen.logic"

// A lookup in flight can't match a directory event by uuid yet, so any event that could concern it counts while
// it is pending. Forgetting bumps the generation: a lookup started under an older one still answers its caller
// but isn't remembered.
interface Memo {
	// Resolved or being resolved, found or created.
	promise: Promise<string> | null
	// A find in flight; a find that comes back empty leaves nothing behind, so the next find or create asks again.
	finding: Promise<string | null> | null
	uuid: string | null
	// Created by this session rather than found.
	created: boolean
	// The last find came back empty, with no restore, create or socket gap since: a write creates without finding
	// again (createDirectory being find-or-create, a stale answer costs nothing). Reads still find.
	absent: boolean
	pending: number
	generation: number
}

function emptyMemo(): Memo {
	return {
		promise: null,
		finding: null,
		uuid: null,
		created: false,
		absent: false,
		pending: 0,
		generation: 0
	}
}

const dotFilen = emptyMemo()
const subdirs = new Map<string, Memo>()
const forgetListeners = new Map<string, Set<() => void>>()

function subdirMemo(name: string): Memo {
	let memo = subdirs.get(name)

	if (memo === undefined) {
		memo = emptyMemo()
		subdirs.set(name, memo)
	}

	return memo
}

// A rejected lookup clears its memo before propagating, so the next caller tries again instead of every later
// use failing for the session on one transient error.
function memoize(memo: Memo, resolve: () => Promise<string>): Promise<string> {
	if (memo.promise !== null) {
		return memo.promise
	}

	const generation = memo.generation

	memo.pending++

	const promise = resolve().then(
		uuid => {
			memo.pending--

			if (generation === memo.generation) {
				memo.uuid = uuid
			}

			return uuid
		},
		(error: unknown) => {
			memo.pending--

			// Only its own memo: a lookup forgotten mid-flight may already have a successor.
			if (memo.promise === promise) {
				memo.promise = null
			}

			throw error
		}
	)

	memo.promise = promise

	return promise
}

// A found directory is remembered like a created one; absence only for a write's sake (Memo.absent).
function memoizeFind(memo: Memo, find: () => Promise<string | null>): Promise<string | null> {
	if (memo.promise !== null) {
		return memo.promise
	}

	if (memo.finding !== null) {
		return memo.finding
	}

	const generation = memo.generation

	memo.pending++

	const finding = find()
		.then(uuid => {
			if (generation === memo.generation && memo.promise === null) {
				if (uuid === null) {
					memo.absent = true
				} else {
					memo.uuid = uuid
					memo.promise = Promise.resolve(uuid)
				}
			}

			return uuid
		})
		.finally(() => {
			memo.pending--

			if (memo.finding === finding) {
				memo.finding = null
			}
		})

	memo.finding = finding

	return finding
}

// `name` under `parent` (null: the drive root) when it exists, creating nothing.
async function findLevel(parent: string | null, name: string): Promise<string | null> {
	return (await runOp(sdkApi.findDirectoryUuid(parent, name))) ?? null
}

// A subdirectory under each name it is looked up under (dotFilenSubdirLookupNames), the canonical one first.
async function findSubdirLevel(parent: string, name: string): Promise<string | null> {
	for (const candidate of dotFilenSubdirLookupNames(name)) {
		const found = await findLevel(parent, candidate)

		if (found !== null) {
			return found
		}
	}

	return null
}

async function createLevel(parent: string | null, name: string): Promise<Dir> {
	return await runOp(sdkApi.createDirectory(parent, name))
}

// Subdirectories this device already found under their canonical name, by uuid (a uuid is never reused across
// accounts), so a found one is fetched for its name once per device rather than once per session.
const CANONICAL_KEY = "dotFilen.canonicalSubdirs.v1"
const MAX_CANONICAL = 32
const canonical = new Set<string>()
const loadCanonical = kvLoadOnce(
	CANONICAL_KEY,
	type("string[]"),
	uuids => {
		for (const uuid of uuids) {
			canonical.add(uuid)
		}
	},
	"dotFilen",
	"canonical subdirectories"
)

// A subdirectory found under another case or a legacy name is renamed to its canonical one, once and best-effort:
// a failure is logged and the directory is used as it is. `held` is the Dir a create returned (it carries its name,
// so nothing is fetched); a found one is fetched unless this device already saw it canonical.
async function canonicalizeSubdir(name: string, uuid: string, held: Dir | null): Promise<void> {
	try {
		await loadCanonical()

		if (canonical.has(uuid)) {
			return
		}

		canonical.add(uuid)

		const dir = held ?? (await sdkApi.getDirectory(uuid))

		if (dir?.meta.type !== "decoded") {
			return
		}

		const rename = dotFilenSubdirRename(dir.meta.data.name, name)

		if (rename !== null) {
			await runOp(sdkApi.renameDirectory(dir, rename))
		}

		void kvSetJsonQuiet(CANONICAL_KEY, [...canonical].slice(-MAX_CANONICAL), "dotFilen", "canonical subdirectories")
	} catch (error) {
		canonical.delete(uuid)
		log.warn("dotFilen", `could not rename .filen/${name} to its canonical name`, error)
	}
}

// Finds, then creates what's missing. After a find that came back empty, and under a `.filen` this session created,
// it creates straight away (createDirectory returns one made since elsewhere).
function memoizeCreate(memo: Memo, name: string, underDotFilen: boolean): Promise<string> {
	const resolve = async (find: boolean): Promise<string> => {
		const generation = memo.generation
		const parent = underDotFilen ? await dotFilenUuid() : null
		const shouldFind = find && !memo.absent && !(underDotFilen && dotFilen.created)
		const found = shouldFind ? await (parent === null ? findLevel(null, name) : findSubdirLevel(parent, name)) : null

		if (found !== null) {
			if (underDotFilen) {
				void canonicalizeSubdir(name, found, null)
			}

			return found
		}

		const dir = await createLevel(parent, name)

		if (generation === memo.generation) {
			memo.created = true
		}

		// createDirectory is find-or-create: it may hand back one made elsewhere under another case.
		if (underDotFilen) {
			void canonicalizeSubdir(name, dir.uuid, dir)
		}

		return dir.uuid
	}

	const finding = memo.promise === null ? memo.finding : null

	if (finding !== null) {
		return finding.then(found => found ?? memoize(memo, () => resolve(false)))
	}

	return memoize(memo, () => resolve(true))
}

function dotFilenUuid(): Promise<string> {
	return memoizeCreate(dotFilen, DOT_FILEN_DIR_NAME, false)
}

// `.filen/<name>`, created when missing, memoized until forgotten.
export function getDotFilenSubdir(name: string): Promise<string> {
	return memoizeCreate(subdirMemo(name), name, true)
}

// `.filen/<name>` when it exists, else null; never creates either level. For reads: a feature's directory is
// created by its first write.
export function findDotFilenSubdir(name: string): Promise<string | null> {
	return memoizeFind(subdirMemo(name), async () => {
		const parent = await memoizeFind(dotFilen, () => findLevel(null, DOT_FILEN_DIR_NAME))

		const found = parent === null ? null : await findSubdirLevel(parent, name)

		if (found !== null) {
			void canonicalizeSubdir(name, found, null)
		}

		return found
	})
}

// The root `.filen`'s uuid as resolved this session, or null when it isn't known (yet). Never looks it up.
export function knownDotFilenUuid(): string | null {
	return dotFilen.uuid
}

// The resolved uuid of `.filen/<name>`, or null when it isn't known (yet).
export function dotFilenSubdirUuid(name: string): string | null {
	return subdirs.get(name)?.uuid ?? null
}

// Whether `uuid` is `.filen` or one of its resolved subdirectories. Synchronous, for socket handlers.
export function isDotFilenSystemDir(uuid: string): boolean {
	if (uuid === dotFilen.uuid) {
		return true
	}

	for (const memo of subdirs.values()) {
		if (memo.uuid === uuid) {
			return true
		}
	}

	return false
}

function clearMemo(memo: Memo): void {
	memo.generation++
	memo.promise = null
	memo.finding = null
	memo.uuid = null
	memo.created = false
	memo.absent = false
}

function notifyForgotten(name: string): void {
	for (const listener of forgetListeners.get(name) ?? []) {
		listener()
	}
}

// Whether a subdirectory other than `name` is resolved or being resolved under the current `.filen`.
function hasSibling(name: string): boolean {
	for (const [other, memo] of subdirs) {
		if (other !== name && (memo.uuid !== null || memo.pending > 0)) {
			return true
		}
	}

	return false
}

// The subdirectory was trashed, deleted, moved or renamed, or an op found it gone. With no sibling resolved under
// it, `.filen` is looked up again too (a gone subdirectory may mean a gone parent); a sibling vouches for it.
export function forgetDotFilenSubdir(name: string): void {
	clearMemo(subdirMemo(name))

	if (!hasSibling(name)) {
		clearMemo(dotFilen)
	}

	notifyForgotten(name)
}

// `.filen` itself went: every subdirectory with it, and every feature is told.
function forgetAll(): void {
	clearMemo(dotFilen)

	for (const name of new Set([...subdirs.keys(), ...forgetListeners.keys()])) {
		clearMemo(subdirMemo(name))
		notifyForgotten(name)
	}
}

// Called whenever `.filen/<name>` is forgotten, so a feature drops what it derived from it.
export function onDotFilenSubdirForgotten(name: string, listener: () => void): () => void {
	let listeners = forgetListeners.get(name)

	if (listeners === undefined) {
		listeners = new Set()
		forgetListeners.set(name, listeners)
	}

	listeners.add(listener)

	return () => {
		listeners.delete(listener)
	}
}

function keepsName(meta: DirMeta, name: string): boolean {
	return meta.type === "decoded" && nameCollisionKey(meta.data.name) === nameCollisionKey(name)
}

// A subdirectory's name check also accepts its legacy names, so a legacy directory being resolved or renamed to
// its canonical name stays the one a memo names.
function keepsSubdirName(meta: DirMeta, name: string): boolean {
	return meta.type === "decoded" && isDotFilenSubdirName(meta.data.name, name)
}

// Mid-lookup, a directory renamed to one of the names being looked up is still ours if it was.
function keepsPendingName(meta: DirMeta): boolean {
	if (keepsName(meta, DOT_FILEN_DIR_NAME)) {
		return true
	}

	for (const [name, memo] of subdirs) {
		if (memo.pending > 0 && keepsSubdirName(meta, name)) {
			return true
		}
	}

	return false
}

// A directory event against the memos. `parent` is the directory it left or sits in, when the event says;
// `renamed` its new metadata for a rename. A lookup still out can't be matched by uuid, so an event that could be
// the directory it resolves forgets that lookup (and only that one).
function forgetDirectory({ uuid, parent, renamed }: { uuid: string; parent: string | null; renamed: DirMeta | null }): void {
	if (uuid === dotFilen.uuid) {
		if (renamed === null || !keepsName(renamed, DOT_FILEN_DIR_NAME)) {
			forgetAll()
		}

		return
	}

	const uncertain = renamed === null || !keepsPendingName(renamed)

	if (dotFilen.pending > 0 && uncertain) {
		clearMemo(dotFilen)

		for (const [name, memo] of subdirs) {
			if (memo.pending > 0) {
				clearMemo(memo)
				notifyForgotten(name)
			}
		}

		return
	}

	for (const [name, memo] of subdirs) {
		const isIt = uuid === memo.uuid && (renamed === null || !keepsSubdirName(renamed, name))
		const mayBeIt = memo.pending > 0 && uncertain && (parent === null || parent === dotFilen.uuid)

		if (isIt || mayBeIt) {
			forgetDotFilenSubdir(name)
		}
	}
}

function isDotFilenAtRoot(dir: Dir): boolean {
	if (!keepsName(dir.meta, DOT_FILEN_DIR_NAME)) {
		return false
	}

	const root = accountQueryGet()?.rootDirUuid

	return root === undefined || dir.parent === root
}

// The subdirectory names `dir` could be one of: under the known `.filen`, or, while `.filen` is still being looked
// up, under any parent but the drive root (only those lookups are concerned).
function subdirNamesFor(dir: Dir): { name: string; memo: Memo }[] {
	const underDotFilen = dotFilen.uuid !== null && dir.parent === dotFilen.uuid
	const mayBeUnderDotFilen = dotFilen.uuid === null && dotFilen.pending > 0 && dir.parent !== accountQueryGet()?.rootDirUuid

	if (!underDotFilen && !mayBeUnderDotFilen) {
		return []
	}

	return [...new Set([...subdirs.keys(), ...forgetListeners.keys()])]
		.filter(name => keepsSubdirName(dir.meta, name))
		.map(name => ({ name, memo: subdirMemo(name) }))
		.filter(({ memo }) => underDotFilen || memo.pending > 0)
}

// A restored `.filen` or subdirectory may now stand beside the one a memo names (created while it sat in the trash)
// and holds what was saved into it, so the next lookup finds again and features re-read.
function restoreDirectory(dir: Dir): void {
	if (isDotFilenAtRoot(dir)) {
		forgetAll()

		return
	}

	for (const { name, memo } of subdirNamesFor(dir)) {
		clearMemo(memo)
		notifyForgotten(name)
	}
}

// A `.filen` or subdirectory created elsewhere: an empty find from before no longer holds.
function createdElsewhere(dir: Dir): void {
	if (isDotFilenAtRoot(dir)) {
		dotFilen.absent = false

		for (const memo of subdirs.values()) {
			memo.absent = false
		}

		return
	}

	for (const { memo } of subdirNamesFor(dir)) {
		memo.absent = false
	}
}

function anythingKnown(): boolean {
	return dotFilen.uuid !== null || dotFilen.pending > 0 || [...subdirs.values()].some(memo => memo.uuid !== null || memo.pending > 0)
}

// Files seen landing in a system directory this session that can't be photos, so a later event naming only the
// file's uuid (a new version retiring it, a trash, a delete) is known not to concern a photos listing. A file that
// leaves, is renamed or is trashed is dropped again. Bounded: each save retires one uuid and adds the next.
const MAX_SYSTEM_FILES = 512
const systemFiles = new Set<string>()

export function noteDotFilenFile(uuid: string): void {
	systemFiles.delete(uuid)
	systemFiles.add(uuid)

	if (systemFiles.size > MAX_SYSTEM_FILES) {
		const oldest = systemFiles.values().next()

		if (oldest.done !== true) {
			systemFiles.delete(oldest.value)
		}
	}
}

export function isDotFilenSystemFile(uuid: string): boolean {
	return systemFiles.has(uuid)
}

// The only handler of `.filen` directory events: features learn of them through onDotFilenSubdirForgotten, so the
// order handlers are registered in doesn't matter.
export function handleDotFilenDriveEvent(event: Extract<SocketEvent, { type: "drive" }>): void {
	const inner = event.inner

	switch (inner.type) {
		case "fileNew":
		case "fileRestore":
		case "fileMove":
		case "fileArchiveRestored":
			if (isDotFilenSystemDir(inner.file.parent) && !isPhotoCandidate(narrowItem(inner.file))) {
				noteDotFilenFile(inner.file.uuid)
			} else {
				systemFiles.delete(inner.file.uuid)
			}

			return

		case "fileTrash":
		case "fileMetadataChanged":
			systemFiles.delete(inner.uuid)

			return

		case "folderTrash":
			forgetDirectory({ uuid: inner.uuid, parent: inner.parent, renamed: null })

			return

		case "folderDeletedPermanent":
			forgetDirectory({ uuid: inner.uuid, parent: null, renamed: null })

			return

		case "folderMove":
			forgetDirectory({ uuid: inner.dir.uuid, parent: null, renamed: null })

			return

		case "folderRestore":
			restoreDirectory(inner.dir)

			return

		case "folderSubCreated":
			createdElsewhere(inner.dir)

			return

		case "folderMetadataChanged":
			forgetDirectory({ uuid: inner.uuid, parent: null, renamed: inner.meta })

			return

		case "deleteAll":
			if (anythingKnown()) {
				forgetAll()
			}

			return

		default:
			return
	}
}

// Events missed in a socket gap (or one that couldn't be decoded) may have trashed, moved or created what the memos
// say, so every level is found again on its next use. Features re-read on reconnect themselves, so none is told.
function forgetAfterGap(): void {
	clearMemo(dotFilen)

	for (const memo of subdirs.values()) {
		clearMemo(memo)
	}

	sdkApi.forgetFoundDirectories().catch(() => undefined)
}

// Set by a drop, so the authSuccess that ends it forgets again what a lookup during the gap remembered. The first
// authSuccess of a session forgets nothing.
let sawReconnecting = false

export function handleDotFilenReconnecting(): void {
	sawReconnecting = true

	forgetAfterGap()
}

export function handleDotFilenAuthSuccess(): void {
	if (!sawReconnecting) {
		return
	}

	sawReconnecting = false

	forgetAfterGap()
}

// Called once by the authed shell's socket host.
export function registerDotFilenSocketHandlers(): () => void {
	const unregister = [
		registerSocketHandler("drive", handleDotFilenDriveEvent),
		registerSocketHandler("driveMalformed", forgetAfterGap),
		registerSocketHandler("reconnecting", handleDotFilenReconnecting),
		registerSocketHandler("authSuccess", handleDotFilenAuthSuccess)
	]

	return () => {
		for (const off of unregister) {
			off()
		}
	}
}

// Logout: nothing resolved under the signed-out account survives, and a lookup still in flight answers its own
// callers only.
export function resetDotFilen(): void {
	sawReconnecting = false
	clearMemo(dotFilen)

	for (const memo of subdirs.values()) {
		clearMemo(memo)
	}

	systemFiles.clear()
}
