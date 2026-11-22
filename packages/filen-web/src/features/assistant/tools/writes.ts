import type { Note, NoteType } from "@filen/sdk-rs"
import type { Playlist } from "@filen/shared"
import type { BulkOutcome, BulkProgress } from "@/lib/actions/bulk"
import { runBulkActivity } from "@/lib/activity/activity"
import type { ActivityKeys } from "@/lib/activity/activity.logic"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { isDirectoryItem, type DriveItem } from "@/features/drive/lib/item"
import { createDirectory, renameItem, restoreItems, setFavoritedItems, trashItems } from "@/features/drive/lib/actions"
import { driveActivity, DRIVE_RESTORE, DRIVE_TRASH, favoriteKeys } from "@/features/drive/lib/activity"
import { moveActivity } from "@/features/drive/lib/dnd"
import { isRootDotFilenItem } from "@/features/drive/lib/dotFilenGuard"
import { startCopyWithCard } from "@/features/transfers/lib/copyToast"
import {
	notesActivity,
	NOTES_ARCHIVE,
	NOTES_FAVORITE,
	NOTES_PIN,
	NOTES_RESTORE,
	NOTES_TRASH,
	NOTES_UNFAVORITE,
	NOTES_UNPIN
} from "@/features/notes/lib/activity"
import { archiveNotes, restoreNotes, setFavoritedNotes, setPinnedNotes, trashNotes, unarchiveNotes } from "@/features/notes/lib/bulk"
import { createNoteWithContent } from "@/features/notes/lib/import"
import { noteContentFromText } from "@/features/notes/lib/import.logic"
import { exceedsNoteSizeCap } from "@/features/notes/hooks/useNoteEditor.logic"
import { isNoteOwner, isNoteUndecryptable } from "@/features/notes/lib/sort"
import { findOwnedListingItem } from "@/features/drive/queries/drive"
import { isAudioItem } from "@/features/audio/lib/handoff"
import { addTracksWithToast } from "@/features/audio/lib/addTracks"
import { playlistsQueryGet } from "@/features/audio/queries/playlists"
import { isTrashed, itemAncestors, itemPath } from "@/features/assistant/tools/drive"
import {
	currentUserId,
	driveName,
	entityName,
	freshDriveItem,
	freshNote,
	livePath,
	noteTitle,
	optionalString,
	requiredString,
	resolveHandle,
	shareDirection,
	showDrive,
	type ToolAdapter,
	type ToolScope
} from "@/features/assistant/tools/entities"
import { AssistantToolError, throwIfStopped } from "@/features/assistant/tools/format"
import type { AssistantEntity } from "@/features/assistant/tools/handles"
import { NOTE_FLAG_ARGS, type NoteFlagArg } from "@/features/assistant/types"

// The assistant's writes. Each runs only once the user confirmed its card (the executor refuses an unconfirmed
// consequential call), through the action the user's own menu runs, so the activity toast, the listing patches and
// the error wording are the same. Nothing here deletes for good: removal is the restorable trash.

// A name the assistant may give a new or renamed item: a path separator would read as a directory the user never
// named, and a blank one is no name at all.
function nameProblem(name: string): string | null {
	const trimmed = name.trim()

	if (trimmed.length === 0) {
		return "The name is empty"
	}

	return trimmed.includes("/") || trimmed === "." || trimmed === ".." ? `"${trimmed}" is not a valid name` : null
}

// Why the assistant may not change a drive item, or null. Someone else's item is theirs to manage; the root `.filen`
// (Filen's own synced settings) is changed only after the user types its name, which a card cannot ask for.
export function itemProblem(item: DriveItem): string | null {
	const name = driveName(item)

	if (item.data.undecryptable) {
		return `"${name}" cannot be decrypted; only the user can change it, in the app`
	}

	if (shareDirection(item) === "in") {
		return `"${name}" is shared with the user; its owner manages it`
	}

	return isRootDotFilenItem(item) ? `"${name}" holds Filen's own settings; only the user can change it, in the app` : null
}

export async function driveItemsOf(scope: ToolScope, handles: readonly string[]): Promise<DriveItem[]> {
	const items: DriveItem[] = []
	const seen = new Set<string>()

	for (const handle of handles) {
		const entity = await resolveHandle(scope, handle, ["drive"])

		if (entity.kind !== "drive") {
			throw new AssistantToolError(`"${handle}" is not a file or directory`, { invalid: true })
		}

		const item = freshDriveItem(entity.item)
		const problem = itemProblem(item)

		if (problem !== null) {
			throw new AssistantToolError(problem)
		}

		if (!seen.has(item.data.uuid)) {
			seen.add(item.data.uuid)
			items.push(item)
		}
	}

	return items
}

export function handleList(input: Record<string, unknown>, key: string): string[] {
	const value = input[key]

	return Array.isArray(value) ? value.map(String) : []
}

export interface Destination {
	uuid: string | null
	name: string
	entity: AssistantEntity
}

// A directory of the user's own drive to put items in: the root, or a directory they own.
export async function destinationOf(scope: ToolScope, handle: string): Promise<Destination> {
	const entity = await resolveHandle(scope, handle, ["root", "drive"])

	if (entity.kind === "root") {
		return { uuid: null, name: "/", entity }
	}

	if (entity.kind !== "drive") {
		throw new AssistantToolError(`"${handle}" is not a directory`, { invalid: true })
	}

	const item = freshDriveItem(entity.item)

	if (!isDirectoryItem(item)) {
		throw new AssistantToolError(`"${driveName(item)}" is a file, not a directory`, { invalid: true })
	}

	const problem = itemProblem(item)

	if (problem !== null) {
		throw new AssistantToolError(problem)
	}

	return { uuid: item.data.uuid, name: driveName(item), entity: { ...entity, item } }
}

// A directory can never go inside itself or one of its own subdirectories. The destination's chain is read from the
// info dialog's query; one that cannot be read refuses, since a move into its own subtree cannot be undone.
async function intoItselfProblem(items: readonly DriveItem[], destination: Destination): Promise<string | null> {
	const directories = new Set(items.filter(isDirectoryItem).map(item => item.data.uuid))

	if (destination.uuid === null || directories.size === 0 || destination.entity.kind !== "drive") {
		return null
	}

	const ancestors = await itemAncestors(destination.entity.item)

	if (ancestors === undefined) {
		return `Could not check where "${destination.name}" is; try again`
	}

	const chain = [destination.uuid, ...ancestors.map(ancestor => ancestor.data.uuid)]
	const inside = items.find(item => chain.includes(item.data.uuid))

	return inside === undefined ? null : `"${driveName(inside)}" cannot go inside itself`
}

async function moveOrCopyProblem(scope: ToolScope, input: Record<string, unknown>): Promise<string | null> {
	const items = await driveItemsOf(scope, handleList(input, "handles"))

	return intoItselfProblem(items, await destinationOf(scope, requiredString(input, "destination")))
}

// The note content a create_note call stores, in its type's form.
const NOTE_TYPES: Readonly<Record<string, NoteType>> = { text: "text", markdown: "md", rich: "rich", checklist: "checklist", code: "code" }

function noteRequest(input: Record<string, unknown>): { title: string; type: NoteType; content: string } {
	const type = NOTE_TYPES[optionalString(input, "type") ?? "text"] ?? "text"

	return {
		title: requiredString(input, "title").trim(),
		type,
		content: noteContentFromText(type, optionalString(input, "content") ?? "")
	}
}

interface NoteFlagChange {
	flag: NoteFlagArg
	on: boolean
}

function noteFlag(note: Note, flag: NoteFlagArg): boolean {
	switch (flag) {
		case "pinned":
			return note.pinned
		case "favorite":
			return note.favorite
		case "archived":
			return note.archive
	}
}

// The note a set_note_flags call names, as it is now, and the flags the call would change on it. Refused as its
// menu refuses: an undecryptable or trashed note offers none of these, and only the owner can archive (anyone
// may take a note out of the archive, pin or favorite it: those are their own).
async function noteFlagChanges(scope: ToolScope, input: Record<string, unknown>): Promise<{ note: Note; changes: NoteFlagChange[] }> {
	const entity = await resolveHandle(scope, requiredString(input, "handle"), ["note"])

	if (entity.kind !== "note") {
		throw new AssistantToolError("Not a note", { invalid: true })
	}

	const requested = NOTE_FLAG_ARGS.flatMap(flag => {
		const value = input[flag]

		return typeof value === "boolean" ? [{ flag, on: value }] : []
	})

	if (requested.length === 0) {
		throw new AssistantToolError("Pass at least one of pinned, favorite or archived", { invalid: true })
	}

	const note = freshNote(entity.note)
	const title = noteTitle(note)

	if (isNoteUndecryptable(note)) {
		throw new AssistantToolError(`"${title}" cannot be decrypted; only the user can change it, in the app`)
	}

	if (note.trash) {
		throw new AssistantToolError(`"${title}" is in the trash; only the user can restore or change it, in the app`)
	}

	const changes = requested.filter(change => noteFlag(note, change.flag) !== change.on)

	if (changes.some(change => change.flag === "archived" && change.on) && !isNoteOwner(note, currentUserId())) {
		throw new AssistantToolError(`"${title}" is shared with the user; only its owner can archive it`)
	}

	if (changes.length === 0) {
		throw new AssistantToolError(`"${title}" is already like that; nothing to change`)
	}

	return { note, changes }
}

// The playlist a call adds to, as the playlists screen holds it now: one deleted since it was listed is gone,
// and a write to it would bring it back.
function playlistOf(entity: AssistantEntity): Playlist {
	if (entity.kind !== "playlist") {
		throw new AssistantToolError("Not a playlist", { invalid: true })
	}

	const entry = playlistsQueryGet()?.find(candidate => candidate.status === "ok" && candidate.playlist.uuid === entity.playlist.uuid)

	if (entry?.status !== "ok") {
		throw new AssistantToolError(`The playlist "${entity.playlist.name}" no longer exists`)
	}

	return entry.playlist
}

// A track to add, as the Add tracks dialog picks one: an audio file of the user's own drive that decrypts.
async function trackItemOf(scope: ToolScope, handle: string): Promise<DriveItem> {
	const entity = await resolveHandle(scope, handle, ["drive", "track"])
	const item =
		entity.kind === "drive"
			? freshDriveItem(entity.item)
			: entity.kind === "track"
				? findOwnedListingItem(entity.track.uuid)?.item
				: undefined

	if (item === undefined) {
		throw new AssistantToolError(`"${entityName(entity)}" was not found in the user's drive; search for it by name first`)
	}

	const problem = itemProblem(item)

	if (problem !== null) {
		throw new AssistantToolError(problem)
	}

	if (isTrashed(item)) {
		throw new AssistantToolError(`"${driveName(item)}" is in the trash; only the user can restore or change it, in the app`)
	}

	if (isDirectoryItem(item) || !isAudioItem(item)) {
		throw new AssistantToolError(`"${driveName(item)}" is not an audio file`, { invalid: true })
	}

	return item
}

interface PlaylistAddition {
	playlist: Playlist
	tracks: { handle: string; item: DriveItem }[]
}

// The tracks a call would add: each once, and none the playlist already holds.
async function playlistAddition(scope: ToolScope, input: Record<string, unknown>): Promise<PlaylistAddition> {
	const playlist = playlistOf(await resolveHandle(scope, requiredString(input, "playlist"), ["playlist"]))
	const existing = new Set(playlist.files.map(file => file.uuid))
	const tracks = new Map<string, { handle: string; item: DriveItem }>()

	for (const handle of handleList(input, "handles")) {
		const item = await trackItemOf(scope, handle)

		if (!existing.has(item.data.uuid) && !tracks.has(item.data.uuid)) {
			tracks.set(item.data.uuid, { handle, item })
		}
	}

	if (tracks.size === 0) {
		throw new AssistantToolError(`Every one of these is already in "${playlist.name}"; nothing to add`)
	}

	return { playlist, tracks: [...tracks.values()] }
}

// The arguments a checked call runs with, cut to what it changes: the card shows that and nothing else, and the
// call applies exactly that once confirmed.
export const WRITE_ARGS: Readonly<Record<string, (scope: ToolScope, input: Record<string, unknown>) => Promise<Record<string, unknown>>>> =
	{
		set_note_flags: async (scope, input) => {
			const { changes } = await noteFlagChanges(scope, input)

			return { handle: input["handle"], ...Object.fromEntries(changes.map(change => [change.flag, change.on])) }
		},
		add_tracks_to_playlist: async (scope, input) => {
			const { tracks } = await playlistAddition(scope, input)

			return { playlist: input["playlist"], handles: tracks.map(track => track.handle) }
		}
	}

// Checks a write needs before its card shows, so the user never confirms a call that then fails; each adapter checks
// again when it runs, against the rows as they are then.
export const WRITE_PRECHECKS: Readonly<Record<string, (scope: ToolScope, input: Record<string, unknown>) => Promise<string | null>>> = {
	set_favorite: async (scope, input) => {
		await driveItemsOf(scope, handleList(input, "handles"))

		return null
	},
	create_directory: async (scope, input) => {
		await destinationOf(scope, requiredString(input, "parent"))

		return nameProblem(requiredString(input, "name"))
	},
	rename_item: async (scope, input) => {
		await driveItemsOf(scope, [requiredString(input, "handle")])

		return nameProblem(requiredString(input, "new_name"))
	},
	move_items: moveOrCopyProblem,
	copy_items: moveOrCopyProblem,
	trash_items: async (scope, input) => {
		await trashTargets(scope, handleList(input, "handles"))

		return null
	},
	restore_items: async (scope, input) => {
		await restoreTargets(scope, handleList(input, "handles"))

		return null
	},
	create_note: (_scope, input) => {
		const { title, content } = noteRequest(input)

		return Promise.resolve(
			title.length === 0 ? "The title is empty" : exceedsNoteSizeCap(content) ? "The text is too long for a note" : null
		)
	}
}

// The path a card names a destination by: two directories may share a name, never a path.
export async function destinationPath(entity: AssistantEntity): Promise<string | undefined> {
	if (entity.kind === "root") {
		return "/"
	}

	if (entity.kind !== "drive") {
		return undefined
	}

	const item = freshDriveItem(entity.item)

	return livePath(entity, item) ?? (await itemPath(item).catch(() => undefined))
}

// A run's result for the model: the names it changed and, for any that failed, why. One where nothing succeeded
// fails the call, so the card says so too.
export function bulkResult<T>(
	outcome: BulkOutcome<T>,
	name: (item: T) => string
): { done: string[]; failed?: { name: string; error: string }[] } {
	const [first] = outcome.failed

	if (outcome.succeeded.length === 0 && first !== undefined) {
		throw new AssistantToolError(errorLabel(first.error))
	}

	return {
		done: outcome.succeeded.map(name),
		...(outcome.failed.length > 0
			? { failed: outcome.failed.map(failure => ({ name: name(failure.item), error: errorLabel(failure.error) })) }
			: {})
	}
}

export const setFavoriteTool: ToolAdapter = async (input, scope) => {
	const items = await driveItemsOf(scope, handleList(input, "handles"))
	const favorite = input["favorite"] === true

	throwIfStopped(scope)

	const outcome = await runBulkActivity(
		driveActivity(items, favoriteKeys(favorite), (targets, onSettled) => setFavoritedItems(targets, favorite, onSettled))
	)
	const { done, failed } = bulkResult(outcome, driveName)

	return { value: { updated: done, favorite, ...(failed === undefined ? {} : { failed }) } }
}

export const createDirectoryTool: ToolAdapter = async (input, scope) => {
	const parent = await destinationOf(scope, requiredString(input, "parent"))
	const name = requiredString(input, "name").trim()
	const problem = nameProblem(name)

	if (problem !== null) {
		throw new AssistantToolError(problem)
	}

	throwIfStopped(scope)

	const outcome = await createDirectory(parent.uuid, name)

	if (outcome.status === "error") {
		throw new AssistantToolError(errorLabel(outcome.dto))
	}

	const path = await destinationPath(parent.entity)
	const createdPath = path === undefined ? undefined : `${path === "/" ? "" : path}/${driveName(outcome.item)}`

	return {
		value: {
			created: { handle: showDrive(scope, outcome.item, createdPath), name: driveName(outcome.item) },
			in: path ?? parent.name
		}
	}
}

export const renameItemTool: ToolAdapter = async (input, scope) => {
	const [item] = await driveItemsOf(scope, [requiredString(input, "handle")])
	const newName = requiredString(input, "new_name").trim()
	const problem = nameProblem(newName)

	if (item === undefined) {
		throw new AssistantToolError("Nothing to rename", { invalid: true })
	}

	if (problem !== null) {
		throw new AssistantToolError(problem)
	}

	throwIfStopped(scope)

	const outcome = await renameItem(item, newName)

	if (outcome.status === "error") {
		throw new AssistantToolError(errorLabel(outcome.dto))
	}

	return { value: { renamed: { handle: showDrive(scope, outcome.item), from: driveName(item), name: driveName(outcome.item) } } }
}

export const moveItemsTool: ToolAdapter = async (input, scope) => {
	const items = await driveItemsOf(scope, handleList(input, "handles"))
	const destination = await destinationOf(scope, requiredString(input, "destination"))
	const problem = await intoItselfProblem(items, destination)

	if (problem !== null) {
		throw new AssistantToolError(problem)
	}

	throwIfStopped(scope)

	const path = await destinationPath(destination.entity)
	const outcome = await runBulkActivity(moveActivity(items, { uuid: destination.uuid, name: destination.name }))
	const { done, failed } = bulkResult(outcome, driveName)

	return { value: { moved: done, to: path ?? destination.name, ...(failed === undefined ? {} : { failed }) } }
}

// A copy runs as a transfer with its own progress card, as the menu's Copy to starts one: the call reports it
// started, not finished.
export const copyItemsTool: ToolAdapter = async (input, scope) => {
	const items = await driveItemsOf(scope, handleList(input, "handles"))
	const destination = await destinationOf(scope, requiredString(input, "destination"))
	const problem = await intoItselfProblem(items, destination)

	if (problem !== null) {
		throw new AssistantToolError(problem)
	}

	throwIfStopped(scope)

	const path = await destinationPath(destination.entity)

	if (startCopyWithCard(items, { uuid: destination.uuid, name: destination.name }) === null) {
		throw new AssistantToolError("The copy could not start")
	}

	return {
		value: { copying: items.map(driveName), to: path ?? destination.name, note: "The copy runs as a transfer; it shows in Transfers." }
	}
}

interface TrashTargets {
	items: DriveItem[]
	notes: Note[]
}

async function trashTargets(scope: ToolScope, handles: readonly string[]): Promise<TrashTargets> {
	const notes = new Map<string, Note>()
	const driveHandles: string[] = []

	for (const handle of handles) {
		const entity = await resolveHandle(scope, handle, ["drive", "note"])

		if (entity.kind === "note") {
			const note = freshNote(entity.note)

			// The menu offers Trash only to a note's owner (a participant gets Leave), so the assistant does the same.
			if (!isNoteOwner(note, currentUserId())) {
				throw new AssistantToolError(`"${noteTitle(note)}" is shared with the user; its owner manages it`)
			}

			notes.set(note.uuid, note)
		} else {
			driveHandles.push(handle)
		}
	}

	return { items: await driveItemsOf(scope, driveHandles), notes: [...notes.values()] }
}

// To the restorable trash only, as the menu's Move to trash does; never for good.
export const trashItemsTool: ToolAdapter = async (input, scope) => {
	const { items, notes } = await trashTargets(scope, handleList(input, "handles"))

	throwIfStopped(scope)

	const [driveOutcome, notesOutcome] = await Promise.all([
		items.length === 0 ? null : runBulkActivity(driveActivity(items, DRIVE_TRASH, trashItems)),
		notes.length === 0 ? null : runBulkActivity(notesActivity(notes, NOTES_TRASH, trashNotes))
	])
	const outcome: BulkOutcome<string> = {
		succeeded: [...(driveOutcome?.succeeded.map(driveName) ?? []), ...(notesOutcome?.succeeded.map(noteTitle) ?? [])],
		failed: [
			...(driveOutcome?.failed.map(failure => ({ item: driveName(failure.item), error: failure.error })) ?? []),
			...(notesOutcome?.failed.map(failure => ({ item: noteTitle(failure.item), error: failure.error })) ?? [])
		]
	}
	const { done, failed } = bulkResult(outcome, name => name)

	return { value: { trashed: done, restorable: true, ...(failed === undefined ? {} : { failed }) } }
}

// What restore_items brings back: only what is in the trash now, and only the user's own notes (only the owner
// trashes one, so only the owner restores it).
async function restoreTargets(scope: ToolScope, handles: readonly string[]): Promise<TrashTargets> {
	const notes = new Map<string, Note>()
	const items = new Map<string, DriveItem>()

	for (const handle of handles) {
		const entity = await resolveHandle(scope, handle, ["drive", "note"])

		if (entity.kind === "note") {
			const note = freshNote(entity.note)

			if (!note.trash) {
				throw new AssistantToolError(`"${noteTitle(note)}" is not in the trash`)
			}

			if (!isNoteOwner(note, currentUserId())) {
				throw new AssistantToolError(`"${noteTitle(note)}" is shared with the user; its owner manages it`)
			}

			notes.set(note.uuid, note)
		} else if (entity.kind === "drive") {
			const item = freshDriveItem(entity.item)

			if (!isTrashed(item)) {
				throw new AssistantToolError(`"${driveName(item)}" is not in the trash`)
			}

			const problem = itemProblem(item)

			if (problem !== null) {
				throw new AssistantToolError(problem)
			}

			items.set(item.data.uuid, item)
		}
	}

	return { items: [...items.values()], notes: [...notes.values()] }
}

// Back from the trash to where each item was, as the trash screen's and the notes menu's Restore run it.
export const restoreItemsTool: ToolAdapter = async (input, scope) => {
	const { items, notes } = await restoreTargets(scope, handleList(input, "handles"))

	throwIfStopped(scope)

	const [driveOutcome, notesOutcome] = await Promise.all([
		items.length === 0 ? null : runBulkActivity(driveActivity(items, DRIVE_RESTORE, restoreItems)),
		notes.length === 0 ? null : runBulkActivity(notesActivity(notes, NOTES_RESTORE, restoreNotes))
	])
	const outcome: BulkOutcome<string> = {
		succeeded: [...(driveOutcome?.succeeded.map(driveName) ?? []), ...(notesOutcome?.succeeded.map(noteTitle) ?? [])],
		failed: [
			...(driveOutcome?.failed.map(failure => ({ item: driveName(failure.item), error: failure.error })) ?? []),
			...(notesOutcome?.failed.map(failure => ({ item: noteTitle(failure.item), error: failure.error })) ?? [])
		]
	}
	const { done, failed } = bulkResult(outcome, name => name)

	return { value: { restored: done, ...(failed === undefined ? {} : { failed }) } }
}

export const createNoteTool: ToolAdapter = async (input, scope) => {
	const { title, type, content } = noteRequest(input)

	if (title.length === 0) {
		throw new AssistantToolError("The title is empty")
	}

	if (exceedsNoteSizeCap(content)) {
		throw new AssistantToolError("The text is too long for a note")
	}

	throwIfStopped(scope)

	const outcome = await createNoteWithContent(title, type, content)

	if (outcome.status === "error") {
		throw new AssistantToolError(errorLabel(outcome.dto))
	}

	const note = outcome.item

	return { value: { created: { handle: scope.show({ kind: "note", note }, noteTitle(note)), title: noteTitle(note) } } }
}

const NOTE_FLAG_RUNS: Readonly<
	Record<
		NoteFlagArg,
		{ on: ActivityKeys; off: ActivityKeys; run: (notes: Note[], on: boolean, onSettled: BulkProgress) => Promise<BulkOutcome<Note>> }
	>
> = {
	pinned: { on: NOTES_PIN, off: NOTES_UNPIN, run: setPinnedNotes },
	favorite: { on: NOTES_FAVORITE, off: NOTES_UNFAVORITE, run: setFavoritedNotes },
	archived: {
		on: NOTES_ARCHIVE,
		off: NOTES_RESTORE,
		run: (notes, on, onSettled) => (on ? archiveNotes(notes, onSettled) : unarchiveNotes(notes, onSettled))
	}
}

// Each change as the note's menu or the notes bar runs it, with its own activity toast; never trash or delete.
export const setNoteFlagsTool: ToolAdapter = async (input, scope) => {
	const { note, changes } = await noteFlagChanges(scope, input)

	throwIfStopped(scope)

	const done: string[] = []
	const failed: { change: string; error: string }[] = []

	for (const { flag, on } of changes) {
		const { run, ...keys } = NOTE_FLAG_RUNS[flag]
		const outcome = await runBulkActivity(
			notesActivity([freshNote(note)], on ? keys.on : keys.off, (notes, onSettled) => run(notes, on, onSettled))
		)
		const [failure] = outcome.failed

		if (failure === undefined) {
			done.push(`${flag}: ${String(on)}`)
		} else {
			failed.push({ change: `${flag}: ${String(on)}`, error: errorLabel(failure.error) })
		}
	}

	const [first] = failed

	if (done.length === 0 && first !== undefined) {
		throw new AssistantToolError(first.error)
	}

	const now = freshNote(note)

	return {
		value: {
			updated: noteTitle(now),
			pinned: now.pinned,
			favorite: now.favorite,
			archived: now.archive,
			...(failed.length > 0 ? { failed } : {})
		}
	}
}

// As the Add tracks dialog adds them, toasts included.
export const addTracksToPlaylistTool: ToolAdapter = async (input, scope) => {
	const { playlist, tracks } = await playlistAddition(scope, input)

	throwIfStopped(scope)

	const outcome = await addTracksWithToast(
		playlist,
		tracks.map(track => track.item)
	)

	if (outcome.status === "error") {
		throw new AssistantToolError(errorLabel(outcome.error))
	}

	return { value: { added: tracks.map(track => driveName(track.item)), count: outcome.added, playlist: playlist.name } }
}
