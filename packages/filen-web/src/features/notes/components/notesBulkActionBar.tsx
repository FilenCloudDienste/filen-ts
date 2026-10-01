import { createElement, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import type { Note, NoteTag, NoteType } from "@filen/sdk-rs"
import { aggregateNoteSelectionFlags } from "@filen/shared"
import { runBulkActivity, type BulkActivitySpec } from "@/lib/activity/activity"
import { isNoteUndecryptable, tagDisplayName } from "@/features/notes/lib/sort"
import {
	setPinnedNotes,
	setFavoritedNotes,
	setTypeNotes,
	duplicateNotes,
	archiveNotes,
	restoreNotes,
	setTagOnNotes
} from "@/features/notes/lib/bulk"
import { exportAllNotes, toastNotesExportOutcome } from "@/features/notes/lib/export"
import {
	NOTES_ARCHIVE,
	NOTES_CHANGE_TYPE,
	NOTES_DUPLICATE,
	NOTES_FAVORITE,
	NOTES_PIN,
	NOTES_RESTORE,
	NOTES_TAG,
	NOTES_UNFAVORITE,
	NOTES_UNPIN,
	NOTES_UNTAG,
	notesActivity
} from "@/features/notes/lib/activity"
import { useNotesSelectionStore } from "@/features/notes/store/useNotesSelectionStore"
import { useNotesInflightStore } from "@/features/notes/store/useNotesInflight"
import {
	noteBulkActions,
	noteBulkTagSubmenuEntries,
	isNoteBulkActionOfflineDisabled,
	type NoteBulkActionDescriptor,
	type NoteBulkDialogActionKind
} from "@/features/notes/components/notesBulkActionBar.logic"
import { useIsOnline } from "@/lib/useIsOnline"
import { NOTE_TYPE_SUBMENU } from "@/features/notes/components/noteMenu.logic"
import { Button } from "@/components/ui/button"
import { BulkActionButton, SelectionActionBar } from "@/components/selectionActionBar"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuCheckboxItem,
	DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"

export type { NoteBulkDialogActionKind }

// Descriptors with a registered keyboard shortcut surface it in their tooltip alongside the label —
// mirrors drive's own bulk bar.
const KEYMAP_ACTION_FOR: Partial<Record<NoteBulkActionDescriptor["id"], string>> = {
	trash: "notes.trash"
}

export interface NotesBulkActionBarProps {
	// The LIVE (ghost-purged) selection — notesSidebar.tsx re-derives this from the current notes
	// query every render, so a note removed from the account (elsewhere, or by another tab) between
	// selection and dispatch is never targeted.
	selectedNotes: Note[]
	allTags: readonly NoteTag[]
	currentUserId: bigint | undefined
	onDialogAction: (kind: NoteBulkDialogActionKind, notes: Note[]) => void
}

// Bottom-anchored floating selection bar (notesSidebar.tsx overlays it on the scrollable list while
// a 2+ selection exists) — mirrors features/drive/components/bulkActionBar.tsx, widened with two
// popover-driven entries (type/tags) drive's own bar has no equivalent of.
export function NotesBulkActionBar({ selectedNotes, allTags, currentUserId, onDialogAction }: NotesBulkActionBarProps) {
	const { t } = useTranslation(["notes", "common"])
	const isOnline = useIsOnline()
	const flags = aggregateNoteSelectionFlags(selectedNotes, currentUserId, isNoteUndecryptable)
	const descriptors = noteBulkActions(flags)
	// Same gate as the per-note menu: a selected note whose edits are still queued would be retyped,
	// duplicated or exported from content that predates them. Boolean-collapsed, so a keystroke re-renders
	// this bar only on the edge.
	const anyInflight = useNotesInflightStore(state => selectedNotes.some(note => (state.inflightContent[note.uuid] ?? []).length > 0))
	// One bulk run at a time: the bar stays up until a run's activity ends and prunes the selection, and a
	// second click meanwhile would run it again (a duplicate twice over). The ref shuts the gate
	// synchronously, the state disables the controls.
	const runningRef = useRef(false)
	const [running, setRunning] = useState(false)
	const blocked = running || anyInflight

	async function runExclusive(task: () => Promise<void>): Promise<void> {
		// anyInflight too: a submenu opened before the gate closed still holds live items.
		if (runningRef.current || anyInflight) {
			return
		}

		runningRef.current = true
		setRunning(true)

		try {
			await task()
		} finally {
			runningRef.current = false
			setRunning(false)
		}
	}

	async function runSelectionActivity(spec: BulkActivitySpec<Note>): Promise<void> {
		await runExclusive(async () => {
			await runBulkActivity(spec)
		})
	}

	async function handleTypeSelect(noteType: NoteType, label: string): Promise<void> {
		await runSelectionActivity(
			notesActivity(selectedNotes, NOTES_CHANGE_TYPE, (notes, onSettled) => setTypeNotes(notes, noteType, onSettled), { type: label })
		)
	}

	async function handleTagToggle(tag: NoteTag, checked: boolean): Promise<void> {
		const keys = checked ? NOTES_TAG : NOTES_UNTAG

		await runSelectionActivity(
			notesActivity(selectedNotes, keys, (notes, onSettled) => setTagOnNotes(notes, tag, checked, onSettled), {
				tag: tagDisplayName(tag)
			})
		)
	}

	async function handleExportSelected(): Promise<void> {
		await runExclusive(exportSelected)
	}

	async function exportSelected(): Promise<void> {
		toastNotesExportOutcome(await exportAllNotes(selectedNotes))
	}

	function runDescriptor(descriptor: Extract<NoteBulkActionDescriptor, { run: "direct" }>): void {
		switch (descriptor.id) {
			case "pin": {
				const pinned = !flags.includesPinned

				void runSelectionActivity(
					notesActivity(selectedNotes, pinned ? NOTES_PIN : NOTES_UNPIN, (notes, onSettled) =>
						setPinnedNotes(notes, pinned, onSettled)
					)
				)
				return
			}
			case "favorite": {
				const favorited = !flags.includesFavorited

				void runSelectionActivity(
					notesActivity(selectedNotes, favorited ? NOTES_FAVORITE : NOTES_UNFAVORITE, (notes, onSettled) =>
						setFavoritedNotes(notes, favorited, onSettled)
					)
				)
				return
			}
			case "duplicate":
				void runSelectionActivity(notesActivity(selectedNotes, NOTES_DUPLICATE, duplicateNotes))
				return
			case "export":
				void handleExportSelected()
				return
			case "archive":
				void runSelectionActivity(notesActivity(selectedNotes, NOTES_ARCHIVE, archiveNotes))
				return
			case "restore":
				void runSelectionActivity(notesActivity(selectedNotes, NOTES_RESTORE, restoreNotes))
				return
		}
	}

	return (
		<SelectionActionBar
			count={selectedNotes.length}
			clearKbdAction="notes.clearSelection"
			onClear={() => {
				useNotesSelectionStore.getState().clearSelectedNotes()
			}}
		>
			{descriptors.map(descriptor => {
				const offlineDisabled = isNoteBulkActionOfflineDisabled(descriptor.id, isOnline)
				const disabled = offlineDisabled || blocked
				const disabledReason = offlineDisabled ? t("common:offlineActionDisabled") : anyInflight ? t("noteSyncing") : undefined

				if (descriptor.run === "submenu") {
					const entries =
						descriptor.submenu === "tags"
							? noteBulkTagSubmenuEntries(selectedNotes, allTags).map(({ tag, checked }) => (
									<DropdownMenuCheckboxItem
										key={tag.uuid}
										checked={checked}
										onCheckedChange={next => {
											void handleTagToggle(tag, next)
										}}
									>
										{tagDisplayName(tag)}
									</DropdownMenuCheckboxItem>
								))
							: NOTE_TYPE_SUBMENU.map(entry => (
									<DropdownMenuItem
										key={entry.noteType}
										onClick={() => {
											void handleTypeSelect(entry.noteType, t(entry.labelKey))
										}}
									>
										{t(entry.labelKey)}
									</DropdownMenuItem>
								))

					return (
						<DropdownMenu key={descriptor.id}>
							<DropdownMenuTrigger
								render={
									<Button
										variant="outline"
										size="icon-sm"
										disabled={disabled}
										aria-label={t(descriptor.labelKey)}
										title={disabledReason}
									>
										{createElement(descriptor.icon, { "aria-hidden": true })}
									</Button>
								}
							/>
							<DropdownMenuContent align="end">
								{entries.length === 0 ? <DropdownMenuItem disabled>{t("noteTagsSubmenuEmpty")}</DropdownMenuItem> : entries}
							</DropdownMenuContent>
						</DropdownMenu>
					)
				}

				return (
					<BulkActionButton
						key={descriptor.id}
						icon={descriptor.icon}
						label={t(descriptor.labelKey)}
						destructive={descriptor.destructive}
						disabled={disabled}
						disabledReason={disabledReason}
						kbdAction={KEYMAP_ACTION_FOR[descriptor.id]}
						onClick={() => {
							if (descriptor.run === "dialog") {
								onDialogAction(descriptor.dialogKind, selectedNotes)

								return
							}

							runDescriptor(descriptor)
						}}
					/>
				)
			})}
		</SelectionActionBar>
	)
}
