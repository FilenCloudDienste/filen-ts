import { createElement, Fragment } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { PlusIcon } from "lucide-react"
import type { Note, NoteTag, NoteType } from "@filen/sdk-rs"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { copyText } from "@/lib/copyText"
import type { VoidActionOutcome } from "@/lib/actions/outcome"
import { runOutcomeActivity } from "@/lib/activity/activity"
import type { ActivityKeys, ActivityValues } from "@/lib/activity/activity.logic"
import {
	togglePinned,
	toggleFavorited,
	duplicateNote,
	archiveNote,
	restoreNote,
	trashNote,
	setNoteType,
	resolveNoteContent,
	createNote
} from "@/features/notes/lib/actions"
import { exportNote } from "@/features/notes/lib/export"
import { tagDisplayName } from "@/features/notes/lib/sort"
import { addTagToNote, removeTagFromNote, setNoteTagFavorited } from "@/features/notes/lib/tags"
import {
	NOTES_ARCHIVE,
	NOTES_CHANGE_TYPE,
	NOTES_DUPLICATE,
	NOTES_FAVORITE,
	NOTES_PIN,
	NOTES_RESTORE,
	NOTES_TAG,
	NOTES_TRASH,
	NOTES_UNFAVORITE,
	NOTES_UNPIN,
	NOTES_UNTAG,
	createFailedAs,
	noteActivityName,
	runNoteCreateActivity
} from "@/features/notes/lib/activity"
import { useIsOnline } from "@/lib/useIsOnline"
import { useNoteInflight } from "@/features/notes/store/useNotesInflight"
import {
	noteMenuActions,
	noteTagSubmenuEntries,
	tagMenuActions,
	applyNoteOfflineGate,
	applyTagOfflineGate,
	NOTE_TYPE_SUBMENU,
	type NoteActionDescriptor,
	type NoteActionDialogKind,
	type NoteTagDialogKind,
	type NoteActionId
} from "@/features/notes/components/noteMenu.logic"
import {
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubTrigger,
	ContextMenuSubContent,
	ContextMenuCheckboxItem
} from "@/components/ui/context-menu"
import {
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubTrigger,
	DropdownMenuSubContent,
	DropdownMenuCheckboxItem
} from "@/components/ui/dropdown-menu"

export interface NoteMenuContentProps {
	note: Note
	allTags: readonly NoteTag[]
	currentUserId: bigint | undefined
	// Fires for every "dialog"-run descriptor (rename/delete/leave) and the tags submenu's inline "new
	// tag" entry (createTag) — the mounting surface's own dialog host (useNoteDialogHost) turns this into
	// an open dialog. Every "direct"/"submenu" descriptor resolves fully in place below.
	onAction: (kind: NoteActionDialogKind, note: Note) => void
	// Fires after a successful duplicate — the sidebar navigates to the new copy; the editor header
	// (which duplicates the note it's currently showing) does the same. Optional: a caller with no
	// reason to navigate (none exists yet) simply omits it.
	onDuplicated?: ((duplicated: Note) => void) | undefined
	// Present ONLY when the mounting surface wants the "Hide completed items" toggle rendered (the
	// editor header's own ⋯ menu, checklist notes only); the list row's menu never passes this, so the
	// toggle is editor-origin only, matching mobile (a view-local preference has no reason to clutter the
	// row menu, which never even renders the checklist body).
	hideCompletedChecklist?: { checked: boolean; onToggle: () => void } | undefined
}

interface MenuFamily {
	Item: typeof DropdownMenuItem
	Separator: typeof DropdownMenuSeparator
	Sub: typeof DropdownMenuSub
	SubTrigger: typeof DropdownMenuSubTrigger
	SubContent: typeof DropdownMenuSubContent
	CheckboxItem: typeof DropdownMenuCheckboxItem
}

// Visual grouping only (mirrors drive's SEPARATOR_BEFORE) — a rule before the lifecycle-changing group
// (archive/restore/trash/leave) and before the trashed-variant's own deletePermanently.
const SEPARATOR_BEFORE = new Set<NoteActionId>(["archive", "restore", "trash", "leave", "deletePermanently"])

// Direct server writes, each run as an activity in its own words. Keyed off the note as the menu saw it:
// a pin or favorite says which way it flips.
const ACTIVITY_ACTIONS: Partial<
	Record<NoteActionId, { keys: (note: Note) => ActivityKeys; run: (note: Note) => Promise<VoidActionOutcome> }>
> = {
	pin: { keys: note => (note.pinned ? NOTES_UNPIN : NOTES_PIN), run: togglePinned },
	favorite: { keys: note => (note.favorite ? NOTES_UNFAVORITE : NOTES_FAVORITE), run: toggleFavorited },
	archive: { keys: () => NOTES_ARCHIVE, run: archiveNote },
	restore: { keys: () => NOTES_RESTORE, run: restoreNote },
	trash: { keys: () => NOTES_TRASH, run: trashNote }
}

function runNoteActivity(note: Note, keys: ActivityKeys, run: (note: Note) => Promise<VoidActionOutcome>, values?: ActivityValues): void {
	void runOutcomeActivity(note, { keys, name: noteActivityName, run, ...(values !== undefined ? { values } : {}) })
}

// Shared per-note action list, rendered by BOTH the sidebar row's right-click menu and the editor
// header's ⋯ trigger (see NoteContextMenuContent/NoteDropdownMenuContent below) — one descriptor list
// (noteMenuActions), one mapping from descriptor to menu row, mirrors drive's ItemMenuEntries exactly.
function NoteMenuEntries({
	note,
	allTags,
	currentUserId,
	onAction,
	onDuplicated,
	hideCompletedChecklist,
	family
}: NoteMenuContentProps & { family: MenuFamily }) {
	const { t } = useTranslation(["notes", "common"])
	const isOnline = useIsOnline()
	// Every action waits while the note's own edits are still queued (mobile parity): the content cache
	// and the server copy both predate them, so a retype, duplicate or export would act on stale text.
	// Subscribed only while the menu is open (its content mounts on open).
	const isInflight = useNoteInflight(note.uuid)
	const offlineGated = applyNoteOfflineGate(noteMenuActions(note, currentUserId), isOnline)
	const descriptors = isInflight ? offlineGated.map(descriptor => ({ ...descriptor, enabled: false })) : offlineGated
	const { Item, Separator, Sub, SubTrigger, SubContent, CheckboxItem } = family

	async function runDirect(descriptor: Extract<NoteActionDescriptor, { run: "direct" }>): Promise<void> {
		const activity = ACTIVITY_ACTIONS[descriptor.id]

		if (activity) {
			runNoteActivity(note, activity.keys(note), activity.run)
			return
		}

		switch (descriptor.id) {
			case "duplicate": {
				runNoteActivity(note, NOTES_DUPLICATE, async target => {
					const outcome = await duplicateNote(target)

					if (outcome.status === "success") {
						onDuplicated?.(outcome.item)
					}

					return outcome
				})
				return
			}
			// A file save, not a server write: only a failure toasts.
			case "export": {
				const outcome = await exportNote(note)

				if (outcome.status === "error") {
					toast.error(errorLabel(outcome.dto))
				}

				return
			}
			case "copyId": {
				await copyText(note.uuid, t("noteCopyIdToast"))

				return
			}
			case "copyContent": {
				try {
					const content = await resolveNoteContent(note)
					await navigator.clipboard.writeText(content)
					toast.success(t("noteCopyContentToast"))
				} catch (e) {
					toast.error(errorLabel(e))
				}

				return
			}
		}
	}

	function handleTagToggle(tag: NoteTag, nextChecked: boolean): void {
		runNoteActivity(
			note,
			nextChecked ? NOTES_TAG : NOTES_UNTAG,
			target => (nextChecked ? addTagToNote(target, tag) : removeTagFromNote(target, tag)),
			{ tag: tagDisplayName(tag) }
		)
	}

	function handleTypeSelect(noteType: NoteType, label: string): void {
		if (noteType === note.noteType) {
			return
		}

		runNoteActivity(note, NOTES_CHANGE_TYPE, target => setNoteType(target, noteType), { type: label })
	}

	function renderTagsSubmenu() {
		const entries = noteTagSubmenuEntries(note, allTags)

		return (
			<>
				{entries.length === 0 ? (
					<Item disabled>{t("noteTagsSubmenuEmpty")}</Item>
				) : (
					entries.map(({ tag, checked }) => (
						<CheckboxItem
							key={tag.uuid}
							checked={checked}
							onCheckedChange={next => {
								handleTagToggle(tag, next)
							}}
						>
							{tagDisplayName(tag)}
						</CheckboxItem>
					))
				)}
				<Separator />
				<Item
					disabled={!isOnline}
					title={!isOnline ? t("common:offlineActionDisabled") : undefined}
					onClick={() => {
						onAction("createTag", note)
					}}
				>
					<PlusIcon aria-hidden="true" />
					{t("noteActionCreateTag")}
				</Item>
			</>
		)
	}

	function renderDescriptor(descriptor: NoteActionDescriptor, index: number) {
		const separator = index > 0 && SEPARATOR_BEFORE.has(descriptor.id) ? <Separator /> : null
		const disabled = descriptor.enabled === false
		const disabledTitle = !disabled
			? undefined
			: isInflight
				? t("noteSyncing")
				: !isOnline
					? t("common:offlineActionDisabled")
					: undefined

		if (descriptor.run === "submenu") {
			return (
				<Fragment key={descriptor.id}>
					{separator}
					<Sub>
						<SubTrigger
							disabled={disabled}
							title={disabledTitle}
						>
							{createElement(descriptor.icon, { "aria-hidden": true })}
							{t(descriptor.labelKey)}
						</SubTrigger>
						<SubContent>
							{descriptor.submenu === "tags"
								? renderTagsSubmenu()
								: NOTE_TYPE_SUBMENU.map(entry => (
										<CheckboxItem
											key={entry.noteType}
											checked={note.noteType === entry.noteType}
											onCheckedChange={() => {
												handleTypeSelect(entry.noteType, t(entry.labelKey))
											}}
										>
											{t(entry.labelKey)}
										</CheckboxItem>
									))}
						</SubContent>
					</Sub>
				</Fragment>
			)
		}

		return (
			<Fragment key={descriptor.id}>
				{separator}
				<Item
					variant={descriptor.destructive ? "destructive" : "default"}
					disabled={disabled}
					title={disabledTitle}
					onClick={() => {
						if (descriptor.run === "direct") {
							void runDirect(descriptor)
							return
						}

						onAction(descriptor.dialogKind, note)
					}}
				>
					{createElement(descriptor.icon, { "aria-hidden": true })}
					{t(descriptor.labelKey)}
				</Item>
			</Fragment>
		)
	}

	return (
		<>
			{descriptors.map((descriptor, index) => renderDescriptor(descriptor, index))}
			{hideCompletedChecklist ? (
				<>
					<Separator />
					<CheckboxItem
						checked={hideCompletedChecklist.checked}
						onCheckedChange={() => {
							hideCompletedChecklist.onToggle()
						}}
					>
						{t("noteActionHideCompletedChecklist")}
					</CheckboxItem>
				</>
			) : null}
		</>
	)
}

// Right-click surface — rendered inside a per-row <ContextMenu> (notesSidebar.tsx's row wrapper).
export function NoteContextMenuContent(props: NoteMenuContentProps) {
	return (
		<ContextMenuContent>
			<NoteMenuEntries
				{...props}
				family={{
					Item: ContextMenuItem,
					Separator: ContextMenuSeparator,
					Sub: ContextMenuSub,
					SubTrigger: ContextMenuSubTrigger,
					SubContent: ContextMenuSubContent,
					CheckboxItem: ContextMenuCheckboxItem
				}}
			/>
		</ContextMenuContent>
	)
}

export interface TagMenuContentProps {
	tag: NoteTag
	// Fires for the two "dialog"-run tag descriptors (renameTag/deleteTag) — the sidebar's dialog host
	// (useNoteDialogHost.openTagDialog) turns this into an open dialog. The favorite toggle resolves in
	// place below, same split as NoteMenuEntries' own direct-vs-dialog rule.
	onTagAction: (kind: NoteTagDialogKind, tag: NoteTag) => void
	// Fires once the newly created, auto-tagged note is ready; the sidebar navigates to it (same shape
	// as NoteMenuContentProps.onDuplicated).
	onCreateNoteInTag: (created: Note) => void
}

// Right-click surface for a tags-view group row (notesSidebar.tsx's TagGroupRow) — create-note/rename/
// favorite/delete only. Context-menu family only: tag rows keep no hover ⋯ trigger (the count badge
// owns that slot), mirroring old-web where tag management was right-click-only too.
export function TagContextMenuContent({ tag, onTagAction, onCreateNoteInTag }: TagMenuContentProps) {
	const { t } = useTranslation(["notes", "common"])
	const isOnline = useIsOnline()
	const descriptors = applyTagOfflineGate(tagMenuActions(tag), isOnline)

	function handleFavoriteToggle(): void {
		const favorite = !tag.favorite

		void runOutcomeActivity(tag, {
			keys: favorite ? NOTES_FAVORITE : NOTES_UNFAVORITE,
			name: tagDisplayName,
			run: target => setNoteTagFavorited(target, favorite)
		})
	}

	// Untitled, default-type note (mirrors the sidebar header's own "New note" — no type/title prompt),
	// tagged with THIS tag before the caller navigates to it. addTagToNote failing after a successful
	// create still leaves a real (untagged) note behind, so that failure says the tagging failed.
	async function handleCreateNoteInTag(): Promise<void> {
		const created = await runNoteCreateActivity(t("notesCreating"), async () => {
			const outcome = await createNote()

			if (outcome.status === "error") {
				return createFailedAs(outcome, t("notesCreateError"))
			}

			return createFailedAs(
				await addTagToNote(outcome.item, tag),
				t("notesTagFailed", { count: 1, name: noteActivityName(outcome.item), tag: tagDisplayName(tag) })
			)
		})

		if (created !== null) {
			onCreateNoteInTag(created)
		}
	}

	return (
		<ContextMenuContent>
			{descriptors.map(descriptor => (
				<ContextMenuItem
					key={descriptor.id}
					variant={descriptor.run === "dialog" && descriptor.destructive === true ? "destructive" : "default"}
					disabled={descriptor.enabled === false}
					title={descriptor.enabled === false && !isOnline ? t("common:offlineActionDisabled") : undefined}
					onClick={() => {
						if (descriptor.run === "direct") {
							if (descriptor.id === "tagCreateNote") {
								void handleCreateNoteInTag()
								return
							}

							handleFavoriteToggle()
							return
						}

						onTagAction(descriptor.dialogKind, tag)
					}}
				>
					{createElement(descriptor.icon, { "aria-hidden": true })}
					{t(descriptor.labelKey)}
				</ContextMenuItem>
			))}
		</ContextMenuContent>
	)
}

// ⋯ trigger surface — rendered inside a <DropdownMenu> (a row's own trigger button, or the editor
// header's ⋮ button, noteEditorPane.tsx).
export function NoteDropdownMenuContent(props: NoteMenuContentProps) {
	return (
		<DropdownMenuContent align="end">
			<NoteMenuEntries
				{...props}
				family={{
					Item: DropdownMenuItem,
					Separator: DropdownMenuSeparator,
					Sub: DropdownMenuSub,
					SubTrigger: DropdownMenuSubTrigger,
					SubContent: DropdownMenuSubContent,
					CheckboxItem: DropdownMenuCheckboxItem
				}}
			/>
		</DropdownMenuContent>
	)
}
