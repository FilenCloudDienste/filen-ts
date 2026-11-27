import { contactDisplayName, driveItemName, shareRoleKind, type BlockedUsers, type Playlist } from "@filen/shared"
import type { Chat, Note } from "@filen/sdk-rs"
import type { AssistantSignal, AssistantToolProgress } from "@filen/shared/assistant"
import { i18n } from "@/lib/i18n"
import { queryClient } from "@/queries/client"
import { accountQueryGet } from "@/queries/account"
import { contactsQueryRead } from "@/features/contacts/queries/contacts"
import { heldBlockedUsers } from "@/features/contacts/hooks/useBlockedUsers"
import { cachedQueriesWithPrefix } from "@/queries/patch"
import {
	DRIVE_LISTING_KEY_PREFIX,
	driveListingQueryOptions,
	findCachedListingItem,
	findOwnedListingItem,
	type DriveListingParams
} from "@/features/drive/queries/drive"
import { getSharerIdentity, isDirectoryItem, type DriveItem } from "@/features/drive/lib/item"
import { filterSharedInByBlocked } from "@/features/drive/components/directoryListing.logic"
import type { DriveVariant } from "@/features/drive/lib/preferences"
import { notesQueryFind, notesQueryGet } from "@/features/notes/queries/notes"
import { isNoteUndecryptable } from "@/features/notes/lib/sort"
import { chatsQueryGet } from "@/features/chats/queries/chats"
import { chatTitle, otherParticipants } from "@/features/chats/lib/sort"
import { chatsWithoutBlockedOneOnOne } from "@/features/chats/components/chatsSidebar.logic"
import { filterNotesByBlockedOwner } from "@/features/notes/components/notesSidebar.logic"
import { playlistsQueryGet } from "@/features/audio/queries/playlists"
import { AssistantToolError, matchScore, sameName, searchTokens } from "@/features/assistant/tools/format"
import type { AssistantEntity, AssistantEntityKind, AssistantHandleRegistry } from "@/features/assistant/tools/handles"
import type { AssistantHandleRef } from "@/features/assistant/runtime/executor"
import type { UserCalendar } from "@/features/assistant/tools/dates"

// What an adapter gets for one call. `show` registers an item and records that the result mentions it,
// which is what the guard learns handles from. `progress` reports how far a long call got, for its step.
export interface ToolScope {
	registry: AssistantHandleRegistry
	signal: AssistantSignal | undefined
	// The turn's calendar, which date filters resolve by.
	calendar: UserCalendar
	show: (entity: AssistantEntity, name: string) => string
	progress?: ((progress: AssistantToolProgress) => void) | undefined
	// The user detached the open document from this turn's question.
	withoutDocument?: boolean
}

export interface ToolOutput {
	value: Record<string, unknown>
}

export type ToolAdapter = (input: Record<string, unknown>, scope: ToolScope) => Promise<ToolOutput>

// The loop's signal as a DOM AbortSignal, for the download it may stop.
export function abortSignalOf(signal: AssistantSignal | undefined): AbortSignal | undefined {
	if (signal === undefined || signal instanceof AbortSignal) {
		return signal
	}

	const controller = new AbortController()

	if (signal.aborted) {
		controller.abort()
	} else {
		signal.addEventListener(
			"abort",
			() => {
				controller.abort()
			},
			{ once: true }
		)
	}

	return controller.signal
}

export function optionalString(input: Record<string, unknown>, key: string): string | undefined {
	const value = input[key]

	return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

export function requiredString(input: Record<string, unknown>, key: string): string {
	return optionalString(input, key) ?? ""
}

export function currentUserId(): bigint | undefined {
	return accountQueryGet()?.id
}

// The blocked set the sidebars filter by, as the contacts cache holds it; fail-open like useBlockedUsers.
export function blockedUsers(): BlockedUsers {
	return heldBlockedUsers()
}

export function driveName(item: DriveItem): string {
	return item.data.undecryptable ? i18n.t("common:cannotDecryptTitle") : driveItemName(item)
}

export function noteTitle(note: Note): string {
	if (isNoteUndecryptable(note)) {
		return i18n.t("common:cannotDecryptTitle")
	}

	return note.title !== undefined && note.title.length > 0 ? note.title : i18n.t("notes:noteUntitled")
}

export function chatName(chat: Chat): string {
	return chatTitle(chat, currentUserId(), i18n.t("common:cannotDecryptTitle"), i18n.t("chats:chatJustYou"))
}

// Who a draft to `chat` reaches, by address: a contact chooses their own display name and a group's owner
// its name, but an account's address is its own.
export function chatRecipients(chat: Chat): string[] {
	return otherParticipants(chat, currentUserId()).map(participant => participant.email)
}

export function participantName(participant: { email: string; nickName: string | undefined }): string {
	return contactDisplayName(participant)
}

// The live rows behind a snapshot: a rename or a socket patch since the model saw the handle wins. A
// current listing's row first (queued edits applied); a shared row lives only in its own listings.
export function freshDriveItem(item: DriveItem): DriveItem {
	return findOwnedListingItem(item.data.uuid)?.item ?? findCachedListingItem(item.data.uuid) ?? item
}

export function freshNote(note: Note): Note {
	return notesQueryFind(note.uuid) ?? note
}

export function freshChat(chat: Chat): Chat {
	return chatsQueryGet()?.find(candidate => candidate.uuid === chat.uuid) ?? chat
}

export function freshPlaylist(playlist: Playlist): Playlist {
	const entry = playlistsQueryGet()?.find(candidate => candidate.status === "ok" && candidate.playlist.uuid === playlist.uuid)

	return entry?.status === "ok" ? entry.playlist : playlist
}

// A handle's live entity: names, recipients and flags as they are now, which a card must show.
export function freshEntity(entity: AssistantEntity): AssistantEntity {
	switch (entity.kind) {
		case "drive":
			return { ...entity, item: freshDriveItem(entity.item) }
		case "note":
			return { ...entity, note: freshNote(entity.note) }
		case "chat":
			return { ...entity, chat: freshChat(entity.chat) }
		case "playlist":
			return { ...entity, playlist: freshPlaylist(entity.playlist) }
		default:
			return entity
	}
}

// The path a drive handle was found at, while it still describes `live` (its fresh row): a move or a rename
// since then, of the item or of a directory above it, leaves it naming where the item used to be.
export function livePath(entity: { item: DriveItem; path?: string }, live: DriveItem): string | undefined {
	return entity.path !== undefined &&
		live.data.parent === entity.item.data.parent &&
		driveItemName(live) === driveItemName(entity.item) &&
		ancestorsStillAt(entity.path, live.data.parent)
		? entity.path
		: undefined
}

// Whether the directories above `parent` (the item's own, included) still carry the names `path` gives them,
// as far as the cached listings hold them: a rename or a move of one patches its cached row. What is not
// cached cannot be checked without a request and counts as unchanged.
export function ancestorsStillAt(path: string, parent: string): boolean {
	const segments = path.split("/").filter(segment => segment.length > 0)
	const root = rootDirUuid()
	// The segment naming `uuid`: the item's own name is the last one.
	let index = segments.length - 2
	let uuid = parent

	while (uuid !== root) {
		const row = findOwnedListingItem(uuid)?.item

		if (row === undefined) {
			return true
		}

		if (index < 0 || driveItemName(row) !== segments[index]) {
			return false
		}

		index--
		uuid = row.data.parent
	}

	return index === -1
}

// A directory's path from the cached listings alone, each row's parent walked up to the root: no request. Undefined
// once a directory on the way is not cached, or sits in the trash itself.
export function cachedDirectoryPath(uuid: string): string | undefined {
	const root = rootDirUuid()
	const names: string[] = []
	let current = uuid

	while (current !== root) {
		const row = findOwnedListingItem(current)?.item

		// The cap breaks a cycle stale rows could form.
		if (root === undefined || row?.type !== "directory" || names.length > 256) {
			return undefined
		}

		names.push(driveItemName(row))
		current = row.data.parent
	}

	return `/${names.reverse().join("/")}`
}

// Where restoring a trashed item puts it, by path, while the cached listings hold that directory. `trashedFrom`
// counts only while the row is in the trash.
export function cachedRestorePath(item: DriveItem): string | undefined {
	if (item.type !== "directory" && item.type !== "file") {
		return undefined
	}

	const { parent, trashedFrom } = item.data

	return parent === "trash" && trashedFrom !== undefined ? cachedDirectoryPath(trashedFrom) : undefined
}

export function rootDirUuid(): string | undefined {
	return accountQueryGet()?.rootDirUuid
}

// A directory listing through the same query, key and freshness rule the drive screen uses.
export function readDriveListing(uuid: string | null): Promise<DriveItem[]> {
	return queryClient.query(driveListingQueryOptions("drive", uuid === rootDirUuid() ? null : uuid))
}

// No event keeps the flat and shared listings current, so their screens read them on every mount; a turn's
// retries and follow-ups reuse one read this long instead.
export const UNSYNCED_LISTING_REUSE_MS = 60_000

// Recents, favorites, trash, links or a shared listing, through its screen's own query. `path` is the shared
// listings' uuid chain (see AssistantEntity).
export function readUnsyncedListing(
	variant: Exclude<DriveVariant, "drive">,
	uuid: string | null = null,
	path: readonly string[] = []
): Promise<DriveItem[]> {
	return queryClient.query({ ...driveListingQueryOptions(variant, uuid, path), staleTime: UNSYNCED_LISTING_REUSE_MS })
}

// Which way an item is shared: "in" for someone else's item, "out" for one of the user's own that the shared-out
// listing returned; null for a plain item. A nested shared directory carries no role of its own when it was
// rebuilt without the spread, and only the shared-in listing returns nested shared rows.
export function shareDirection(item: DriveItem): "in" | "out" | null {
	if (item.type === "directory" || item.type === "file") {
		return null
	}

	return shareRoleKind(item.data.sharingRole) === "receiver" ? "out" : "in"
}

// The address of whoever shared an item with the user.
export function sharedByOf(item: DriveItem): { sharedBy?: string } {
	const email = shareDirection(item) === "in" ? getSharerIdentity(item)?.email : undefined

	return email === undefined ? {} : { sharedBy: email }
}

// The Shared with me screen's listing (its root, or a directory in it by its uuid chain), without the items of
// users the user blocked, as the screen hides them. The blocked set is the contacts query's, read as the screen
// reads it.
export async function readSharedInListing(uuid: string | null, chain: readonly string[] = []): Promise<DriveItem[]> {
	const [items] = await Promise.all([readUnsyncedListing("sharedIn", uuid, chain), contactsQueryRead().catch(() => undefined)])

	return filterSharedInByBlocked(items, blockedUsers())
}

export function joinPath(parent: string, name: string): string {
	return parent === "/" || parent === "" ? `/${name}` : `${parent}/${name}`
}

// Filen compares names case-insensitively but keeps accents apart: "Résumé" and "Resume" are two items.
function exactName(a: string, b: string): boolean {
	return a.trim().normalize("NFC").toLowerCase() === b.trim().normalize("NFC").toLowerCase()
}

// The one item in `items` named `segment`: written exactly so first, else by the accent-folded name when only
// one item matches that way, else, for a name the reply screen defanged ("Photos[.]old") and the model copied
// back from its earlier reply, written exactly so once re-fanged.
function itemNamed(items: readonly DriveItem[], segment: string): DriveItem | undefined {
	const exact = items.find(item => exactName(driveItemName(item), segment))

	if (exact !== undefined) {
		return exact
	}

	const folded = items.filter(item => sameName(driveItemName(item), segment))

	if (folded.length === 1) {
		return folded[0]
	}

	const refanged = segment.replace(/\[\.\]/g, ".").replace(/\[@\]/g, "@")

	return refanged === segment ? undefined : items.find(item => exactName(driveItemName(item), refanged))
}

// An absolute path ("/Documents/Invoices") walked through the listings the drive screen would read. With
// `file`, its last segment may name a file (the paths search_items returns).
export async function resolveDrivePath(path: string, { file = false }: { file?: boolean } = {}): Promise<AssistantEntity> {
	const segments = path.split("/").filter(segment => segment.trim().length > 0)
	let entity: AssistantEntity = { kind: "root" }
	let uuid: string | null = null
	let walked = "/"

	for (const [index, segment] of segments.entries()) {
		const last = index === segments.length - 1
		const items = (await readDriveListing(uuid)).filter(
			item => !item.data.undecryptable && (item.type === "directory" || (file && last && item.type === "file"))
		)
		const found = itemNamed(items, segment)

		if (found === undefined) {
			throw new AssistantToolError(file ? `No file or directory at "${path}"` : `No directory at "${path}"`)
		}

		walked = joinPath(walked, driveItemName(found))
		uuid = found.data.uuid
		entity = { kind: "drive", item: found, path: walked }
	}

	return entity
}

const KIND_LABELS: Record<AssistantEntityKind, string> = {
	root: "the drive root",
	drive: "a file or directory",
	note: "a note",
	chat: "a chat",
	playlist: "a playlist",
	track: "a track",
	help: "an app_help result",
	syncPair: "a sync pair"
}

const LOOKUP_TOOLS: Record<AssistantEntityKind, string> = {
	root: "list_directory",
	drive: "search_items or list_directory",
	note: "list_notes",
	chat: "list_chats",
	playlist: "list_playlists",
	track: "open_playlist",
	help: "app_help",
	syncPair: "get_desktop_status"
}

export function entityName(entity: AssistantEntity): string {
	switch (entity.kind) {
		case "root":
			return "/"
		case "drive":
			return driveName(entity.item)
		case "note":
			return noteTitle(entity.note)
		case "chat":
			return chatName(entity.chat)
		case "playlist":
			return entity.playlist.name
		case "track":
			return entity.track.name
		case "help":
			return entity.title
		case "syncPair":
			return entity.name
	}
}

function entityKindLabel(entity: AssistantEntity): string {
	switch (entity.kind) {
		case "root":
			return "directory"
		case "drive":
			return driveKind(entity.item)
		default:
			return entity.kind
	}
}

function entityUuid(entity: AssistantEntity): string {
	switch (entity.kind) {
		case "root":
			return ""
		case "drive":
			return entity.item.data.uuid
		case "note":
			return entity.note.uuid
		case "chat":
			return entity.chat.uuid
		case "playlist":
			return entity.playlist.uuid
		case "track":
			return entity.track.uuid
		case "help":
			return entity.id
		case "syncPair":
			return entity.pairId
	}
}

// The My Drive rows the cached listings hold that `match` keeps, with their paths where every ancestor is
// cached too. Paths are built only for the rows kept: a large account caches far more rows than any lookup
// needs, and this runs on the main thread.
export function* cachedDriveRows(match: (item: DriveItem) => boolean): Generator<{ item: DriveItem; path: string | undefined }> {
	const rows = new Map<string, DriveItem>()

	for (const query of cachedQueriesWithPrefix(DRIVE_LISTING_KEY_PREFIX)) {
		const params = query.queryKey[2] as DriveListingParams | undefined

		if (params?.variant !== "drive") {
			continue
		}

		for (const item of (query.state.data as DriveItem[] | undefined) ?? []) {
			rows.set(item.data.uuid, item)
		}
	}

	const root = rootDirUuid()
	const paths = new Map<string, string | undefined>()

	function pathOf(uuid: string): string | undefined {
		if (uuid === root) {
			return "/"
		}

		if (paths.has(uuid)) {
			return paths.get(uuid)
		}

		// Marked first, so a cyclic cache can't recurse forever.
		paths.set(uuid, undefined)

		const row = rows.get(uuid)
		const parent = row === undefined ? undefined : pathOf(row.data.parent)
		const path = row === undefined || parent === undefined ? undefined : joinPath(parent, driveItemName(row))

		paths.set(uuid, path)

		return path
	}

	for (const item of rows.values()) {
		if (match(item)) {
			yield { item, path: pathOf(item.data.uuid) }
		}
	}
}

// What a name could mean, of the items whose names match `tokens`: the items this conversation has seen,
// then what the caches already hold. Lazy, so a lookup stops at its first few. Chats and notes the
// sidebars hide (a blocked user's) are not offered.
function* candidatePool(scope: ToolScope, kinds: readonly AssistantEntityKind[], tokens: readonly string[]): Generator<AssistantEntity> {
	const matches = (name: string) => matchScore(name, tokens) >= tokens.length

	for (const { entity } of scope.registry.entries()) {
		if (kinds.includes(entity.kind) && matches(entityName(entity)) && entityVisible(entity)) {
			yield entity
		}
	}

	if (kinds.includes("drive")) {
		for (const { item, path } of cachedDriveRows(item => matches(driveName(item)))) {
			yield path === undefined ? { kind: "drive", item } : { kind: "drive", item, path }
		}
	}

	if (kinds.includes("note")) {
		for (const note of filterNotesByBlockedOwner(notesQueryGet() ?? [], blockedUsers())) {
			if (!note.trash && matches(noteTitle(note))) {
				yield { kind: "note", note }
			}
		}
	}

	if (kinds.includes("chat")) {
		for (const chat of chatsWithoutBlockedOneOnOne(chatsQueryGet() ?? [], currentUserId(), blockedUsers())) {
			if (matches(chatName(chat))) {
				yield { kind: "chat", chat }
			}
		}
	}

	if (kinds.includes("playlist")) {
		for (const entry of playlistsQueryGet() ?? []) {
			if (entry.status === "ok" && matches(entry.playlist.name)) {
				yield { kind: "playlist", playlist: entry.playlist }
			}
		}
	}
}

// A chat or note the sidebars hide because a blocked user owns it (a one-on-one chat with them, a note they
// shared) is out of the assistant's reach too.
export function entityVisible(entity: AssistantEntity): boolean {
	switch (entity.kind) {
		case "chat":
			return chatsWithoutBlockedOneOnOne([entity.chat], currentUserId(), blockedUsers()).length > 0
		case "note":
			return filterNotesByBlockedOwner([entity.note], blockedUsers()).length > 0
		default:
			return true
	}
}

const CANDIDATE_LIMIT = 5

// The item behind a handle the model passed, if it is one of `kinds`. A path stands in for a drive
// handle; a name where a handle belongs answers with the handles whose names match, so the model can
// call again with one.
export async function resolveHandle(scope: ToolScope, handle: string, kinds: readonly AssistantEntityKind[]): Promise<AssistantEntity> {
	const wanted = handle.trim()
	const expected = kinds.map(kind => KIND_LABELS[kind]).join(" or ")

	if (wanted.startsWith("/") && kinds.includes("drive")) {
		const entity = await resolveDrivePath(wanted, { file: true })

		if (!kinds.includes(entity.kind)) {
			throw new AssistantToolError(`"${wanted}" is ${KIND_LABELS[entity.kind]}, not ${expected}`, { invalid: true })
		}

		return entity
	}

	const entry = scope.registry.get(wanted)

	if (entry !== undefined) {
		if (!kinds.includes(entry.entity.kind)) {
			throw new AssistantToolError(`"${wanted}" is ${KIND_LABELS[entry.entity.kind]}, not ${expected}`, { invalid: true })
		}

		if (!entityVisible(entry.entity)) {
			throw new AssistantToolError(`"${wanted}" is not available`)
		}

		return entry.entity
	}

	const lookup = LOOKUP_TOOLS[kinds.find(kind => kind !== "root") ?? "drive"]
	const tokens = searchTokens(wanted)

	if (/^[a-z]\d+$/i.test(wanted) || tokens.length === 0) {
		throw new AssistantToolError(`Unknown handle "${wanted}". Find it first with ${lookup}.`, { invalid: true })
	}

	const seen = new Set<string>()
	const candidates: { ref: AssistantHandleRef; kind: string }[] = []

	for (const entity of candidatePool(scope, kinds, tokens)) {
		const uuid = entityUuid(entity)
		const name = entityName(entity)

		if (candidates.length >= CANDIDATE_LIMIT) {
			break
		}

		if (seen.has(uuid)) {
			continue
		}

		seen.add(uuid)
		candidates.push({ ref: { handle: scope.show(entity, name), name }, kind: entityKindLabel(entity) })
	}

	throw new AssistantToolError(
		candidates.length > 0
			? `"${wanted}" is a name, not a handle. Matching handles: ${candidates.map(({ ref, kind }) => `${ref.handle} "${ref.name}" (${kind})`).join(", ")}. Call again with the handle.`
			: `No item "${wanted}". Find it first with ${lookup}.`,
		{ invalid: true, candidates: candidates.map(({ ref }) => ref) }
	)
}

export function showDrive(scope: ToolScope, item: DriveItem, path?: string): string {
	return scope.show(path === undefined ? { kind: "drive", item } : { kind: "drive", item, path }, driveName(item))
}

export function driveKind(item: DriveItem): "file" | "directory" {
	return isDirectoryItem(item) ? "directory" : "file"
}
