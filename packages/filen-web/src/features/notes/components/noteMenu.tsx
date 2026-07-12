import { createElement, Fragment } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { PlusIcon } from "lucide-react"
import type { Note, NoteTag, NoteType } from "@filen/sdk-rs"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { asErrorDTO } from "@/lib/sdk/errors"
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
import { addTagToNote, removeTagFromNote, setNoteTagFavorited } from "@/features/notes/lib/tags"
import {
	noteMenuActions,
	noteTagSubmenuEntries,
	tagMenuActions,
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
	const { t } = useTranslation("notes")
	const descriptors = noteMenuActions(note, currentUserId)
	const { Item, Separator, Sub, SubTrigger, SubContent, CheckboxItem } = family

	async function runDirect(descriptor: Extract<NoteActionDescriptor, { run: "direct" }>): Promise<void> {
		switch (descriptor.id) {
			case "duplicate": {
				const outcome = await duplicateNote(note)

				if (outcome.status === "error") {
					toast.error(errorLabel(outcome.dto))
					return
				}

				onDuplicated?.(outcome.item)
				return
			}
			case "export": {
				const outcome = await exportNote(note)

				if (outcome.status === "error") {
					toast.error(errorLabel(outcome.dto))
				}

				return
			}
			case "copyId": {
				try {
					await navigator.clipboard.writeText(note.uuid)
					toast.success(t("noteCopyIdToast"))
				} catch (e) {
					toast.error(errorLabel(asErrorDTO(e)))
				}

				return
			}
			case "copyContent": {
				try {
					const content = await resolveNoteContent(note)
					await navigator.clipboard.writeText(content)
					toast.success(t("noteCopyContentToast"))
				} catch (e) {
					toast.error(errorLabel(asErrorDTO(e)))
				}

				return
			}
			case "pin": {
				const outcome = await togglePinned(note)

				if (outcome.status === "error") {
					toast.error(errorLabel(outcome.dto))
				}

				return
			}
			case "favorite": {
				const outcome = await toggleFavorited(note)

				if (outcome.status === "error") {
					toast.error(errorLabel(outcome.dto))
				}

				return
			}
			case "archive": {
				const outcome = await archiveNote(note)

				if (outcome.status === "error") {
					toast.error(errorLabel(outcome.dto))
				}

				return
			}
			case "restore": {
				const outcome = await restoreNote(note)

				if (outcome.status === "error") {
					toast.error(errorLabel(outcome.dto))
				}

				return
			}
			case "trash": {
				const outcome = await trashNote(note)

				if (outcome.status === "error") {
					toast.error(errorLabel(outcome.dto))
				}

				return
			}
		}
	}

	async function handleTagToggle(tag: NoteTag, nextChecked: boolean): Promise<void> {
		const outcome = nextChecked ? await addTagToNote(note, tag) : await removeTagFromNote(note, tag)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
		}
	}

	async function handleTypeSelect(noteType: NoteType): Promise<void> {
		if (noteType === note.noteType) {
			return
		}

		const outcome = await setNoteType(note, noteType)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
		}
	}

	function renderDescriptor(descriptor: NoteActionDescriptor, index: number) {
		const separator = index > 0 && SEPARATOR_BEFORE.has(descriptor.id) ? <Separator /> : null

		if (descriptor.run === "submenu") {
			if (descriptor.submenu === "tags") {
				const entries = noteTagSubmenuEntries(note, allTags)

				return (
					<Fragment key={descriptor.id}>
						{separator}
						<Sub>
							<SubTrigger>
								{createElement(descriptor.icon, { "aria-hidden": true })}
								{t(descriptor.labelKey)}
							</SubTrigger>
							<SubContent>
								{entries.length === 0 ? (
									<Item disabled>{t("noteTagsSubmenuEmpty")}</Item>
								) : (
									entries.map(({ tag, checked }) => (
										<CheckboxItem
											key={tag.uuid}
											checked={checked}
											onCheckedChange={next => {
												void handleTagToggle(tag, next)
											}}
										>
											{tag.name ?? tag.uuid}
										</CheckboxItem>
									))
								)}
								<Separator />
								<Item
									onClick={event => {
										event.stopPropagation()
										onAction("createTag", note)
									}}
								>
									<PlusIcon aria-hidden="true" />
									{t("noteActionCreateTag")}
								</Item>
							</SubContent>
						</Sub>
					</Fragment>
				)
			}

			return (
				<Fragment key={descriptor.id}>
					{separator}
					<Sub>
						<SubTrigger>
							{createElement(descriptor.icon, { "aria-hidden": true })}
							{t(descriptor.labelKey)}
						</SubTrigger>
						<SubContent>
							{NOTE_TYPE_SUBMENU.map(entry => (
								<CheckboxItem
									key={entry.noteType}
									checked={note.noteType === entry.noteType}
									onCheckedChange={() => {
										void handleTypeSelect(entry.noteType)
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
					onClick={event => {
						// Stop propagation — the portaled popup's synthetic events still bubble through the
						// REACT tree even though the DOM node lives elsewhere (same rationale as drive's
						// itemMenu.tsx), so without this a row click would also reselect/toggle underneath.
						event.stopPropagation()

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
	const { t } = useTranslation("notes")
	const descriptors = tagMenuActions(tag)

	async function handleFavoriteToggle(): Promise<void> {
		const outcome = await setNoteTagFavorited(tag, !tag.favorite)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
		}
	}

	// Untitled, default-type note (mirrors the sidebar header's own "New note" — no type/title prompt),
	// tagged with THIS tag before the caller navigates to it. addTagToNote failing after a successful
	// create still leaves a real (untagged) note behind, so both outcomes get their own toast.
	async function handleCreateNoteInTag(): Promise<void> {
		const created = await createNote()

		if (created.status === "error") {
			toast.error(errorLabel(created.dto))
			return
		}

		const tagged = await addTagToNote(created.item, tag)

		if (tagged.status === "error") {
			toast.error(errorLabel(tagged.dto))
			return
		}

		onCreateNoteInTag(tagged.item)
	}

	return (
		<ContextMenuContent>
			{descriptors.map(descriptor => (
				<ContextMenuItem
					key={descriptor.id}
					variant={descriptor.run === "dialog" && descriptor.destructive === true ? "destructive" : "default"}
					onClick={event => {
						// Same propagation stop as NoteMenuEntries — without it the click would also toggle
						// the tag group's own expand/collapse underneath the (portaled) menu.
						event.stopPropagation()

						if (descriptor.run === "direct") {
							if (descriptor.id === "tagCreateNote") {
								void handleCreateNoteInTag()
								return
							}

							void handleFavoriteToggle()
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
