import type { Note, NoteType } from "@filen/sdk-rs"
import type { BulkOutcome } from "@/lib/actions/bulk"
import { runBulkActivity } from "@/lib/activity/activity"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { isDirectoryItem, type DriveItem } from "@/features/drive/lib/item"
import { createDirectory, renameItem, setFavoritedItems, trashItems } from "@/features/drive/lib/actions"
import { driveActivity, DRIVE_TRASH, favoriteKeys } from "@/features/drive/lib/activity"
import { moveActivity } from "@/features/drive/lib/dnd"
import { isRootDotFilenItem } from "@/features/drive/lib/dotFilenGuard"
import { startCopyWithCard } from "@/features/transfers/lib/copyToast"
import { notesActivity, NOTES_TRASH } from "@/features/notes/lib/activity"
import { trashNotes } from "@/features/notes/lib/bulk"
import { createNoteWithContent } from "@/features/notes/lib/import"
import { noteContentFromText } from "@/features/notes/lib/import.logic"
import { exceedsNoteSizeCap } from "@/features/notes/hooks/useNoteEditor.logic"
import { isNoteOwner } from "@/features/notes/lib/sort"
import { itemAncestors, itemPath } from "@/features/assistant/tools/drive"
import {
	currentUserId,
	driveName,
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
function itemProblem(item: DriveItem): string | null {
	const name = driveName(item)

	if (item.data.undecryptable) {
		return `"${name}" cannot be decrypted; only the user can change it, in the app`
	}

	if (shareDirection(item) === "in") {
		return `"${name}" is shared with the user; its owner manages it`
	}

	return isRootDotFilenItem(item) ? `"${name}" holds Filen's own settings; only the user can change it, in the app` : null
}

async function driveItemsOf(scope: ToolScope, handles: readonly string[]): Promise<DriveItem[]> {
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

function handleList(input: Record<string, unknown>, key: string): string[] {
	const value = input[key]

	return Array.isArray(value) ? value.map(String) : []
}

interface Destination {
	uuid: string | null
	name: string
	entity: AssistantEntity
}

// A directory of the user's own drive to put items in: the root, or a directory they own.
async function destinationOf(scope: ToolScope, handle: string): Promise<Destination> {
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
function bulkResult<T>(outcome: BulkOutcome<T>, name: (item: T) => string): { done: string[]; failed?: { name: string; error: string }[] } {
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
