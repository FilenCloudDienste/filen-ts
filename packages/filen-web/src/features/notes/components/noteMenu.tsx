import { createElement, Fragment } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { PlusIcon } from "lucide-react"
import type { Note, NoteTag, NoteType } from "@filen/sdk-rs"
import { errorLabel } from "@/lib/i18n/errorLabel"
import {
	togglePinned,
	toggleFavorited,
	duplicateNote,
	archiveNote,
	restoreNote,
	trashNote,
	setNoteType
} from "@/features/notes/lib/actions"
import { addTagToNote, removeTagFromNote } from "@/features/notes/lib/tags"
import {
	noteMenuActions,
	noteTagSubmenuEntries,
	NOTE_TYPE_SUBMENU,
	type NoteActionDescriptor,
	type NoteActionDialogKind,
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
function NoteMenuEntries({ note, allTags, currentUserId, onAction, onDuplicated, family }: NoteMenuContentProps & { family: MenuFamily }) {
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
			default:
				// "participants"/"history" reach here only if their disabled guard is ever bypassed
				// (it can't be — a disabled MenuItem never fires onClick) — a defensive no-op, not a dead
				// branch removed, since both placeholders share this same "direct" run kind.
				return
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
					disabled={descriptor.enabled === false}
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

	return <>{descriptors.map((descriptor, index) => renderDescriptor(descriptor, index))}</>
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
