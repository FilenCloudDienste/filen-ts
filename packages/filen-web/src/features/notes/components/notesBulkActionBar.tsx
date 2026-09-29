import { createElement, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import type { Note, NoteTag, NoteType } from "@filen/sdk-rs"
import { aggregateNoteSelectionFlags } from "@filen/shared"
import { type BulkOutcome } from "@/lib/actions/bulk"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { isNoteUndecryptable } from "@/features/notes/lib/sort"
import {
	setPinnedNotes,
	setFavoritedNotes,
	setTypeNotes,
	duplicateNotes,
	archiveNotes,
	restoreNotes,
	setTagOnNotes
} from "@/features/notes/lib/bulk"
import { exportAllNotes } from "@/features/notes/lib/export"
import { toastNotesBulkOutcome } from "@/features/notes/lib/bulkToast"
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
	// One bulk run at a time: the bar stays up until a run's outcome prunes the selection, and a second
	// click meanwhile would run it again (a duplicate twice over). The ref shuts the gate synchronously,
	// the state disables the controls.
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

	async function runOutcome(start: () => Promise<BulkOutcome<Note>>): Promise<void> {
		await runExclusive(async () => {
			const outcome = await start()

			toastNotesBulkOutcome(outcome)
			// Mirrors the dialog-routed bulk actions' own cleanup — a succeeded note is pruned from the
			// selection, a failed one stays selected so the user can retry.
			useNotesSelectionStore.getState().removeFromSelection(outcome.succeeded.map(note => note.uuid))
		})
	}

	async function handleTypeSelect(noteType: NoteType): Promise<void> {
		await runOutcome(() => setTypeNotes(selectedNotes, noteType))
	}

	async function handleTagToggle(tag: NoteTag, checked: boolean): Promise<void> {
		await runOutcome(() => setTagOnNotes(selectedNotes, tag, checked))
	}

	async function handleExportSelected(): Promise<void> {
		await runExclusive(exportSelected)
	}

	async function exportSelected(): Promise<void> {
		const outcome = await exportAllNotes(selectedNotes)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))

			return
		}

		if (outcome.skipped > 0) {
			toast.warning(t("notesExportSkippedUndecryptable", { count: outcome.skipped }))
		}
	}

	function runDescriptor(descriptor: Extract<NoteBulkActionDescriptor, { run: "direct" }>): void {
		switch (descriptor.id) {
			case "pin":
				void runOutcome(() => setPinnedNotes(selectedNotes, !flags.includesPinned))
				return
			case "favorite":
				void runOutcome(() => setFavoritedNotes(selectedNotes, !flags.includesFavorited))
				return
			case "duplicate":
				void runOutcome(() => duplicateNotes(selectedNotes))
				return
			case "export":
				void handleExportSelected()
				return
			case "archive":
				void runOutcome(() => archiveNotes(selectedNotes))
				return
			case "restore":
				void runOutcome(() => restoreNotes(selectedNotes))
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
										{tag.name ?? tag.uuid}
									</DropdownMenuCheckboxItem>
								))
							: NOTE_TYPE_SUBMENU.map(entry => (
									<DropdownMenuItem
										key={entry.noteType}
										onClick={() => {
											void handleTypeSelect(entry.noteType)
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
