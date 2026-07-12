import { createElement } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { XIcon } from "lucide-react"
import type { Note, NoteTag, NoteType } from "@filen/sdk-rs"
import { type BulkOutcome } from "@/features/drive/lib/bulk"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { aggregateNoteSelectionFlags } from "@/features/notes/lib/selectionFlags"
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
import {
	noteBulkActions,
	noteBulkTagSubmenuEntries,
	type NoteBulkActionDescriptor,
	type NoteBulkDialogActionKind
} from "@/features/notes/components/notesBulkActionBar.logic"
import { NOTE_TYPE_SUBMENU } from "@/features/notes/components/noteMenu.logic"
import { Kbd } from "@/lib/keymap/kbd"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuCheckboxItem,
	DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"

export type { NoteBulkDialogActionKind }

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
	const flags = aggregateNoteSelectionFlags(selectedNotes, currentUserId)
	const descriptors = noteBulkActions(flags)

	async function runOutcome(pending: Promise<BulkOutcome<Note>>): Promise<void> {
		const outcome = await pending

		toastNotesBulkOutcome(outcome)
		// Mirrors the dialog-routed bulk actions' own cleanup — a succeeded note is pruned from the
		// selection, a failed one stays selected so the user can retry.
		useNotesSelectionStore.getState().removeFromSelection(outcome.succeeded.map(note => note.uuid))
	}

	async function handleTypeSelect(noteType: NoteType): Promise<void> {
		await runOutcome(setTypeNotes(selectedNotes, noteType))
	}

	async function handleTagToggle(tag: NoteTag, checked: boolean): Promise<void> {
		await runOutcome(setTagOnNotes(selectedNotes, tag, checked))
	}

	async function handleExportSelected(): Promise<void> {
		const outcome = await exportAllNotes(selectedNotes)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
		}
	}

	function runDescriptor(descriptor: Extract<NoteBulkActionDescriptor, { run: "direct" }>): void {
		switch (descriptor.id) {
			case "pin":
				void runOutcome(setPinnedNotes(selectedNotes, !flags.includesPinned))
				return
			case "favorite":
				void runOutcome(setFavoritedNotes(selectedNotes, !flags.includesFavorited))
				return
			case "duplicate":
				void runOutcome(duplicateNotes(selectedNotes))
				return
			case "export":
				void handleExportSelected()
				return
			case "archive":
				void runOutcome(archiveNotes(selectedNotes))
				return
			case "restore":
				void runOutcome(restoreNotes(selectedNotes))
				return
		}
	}

	return (
		<div className="pointer-events-auto flex max-w-full flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-popover px-3 py-2 text-popover-foreground shadow-lg">
			<div className="flex items-center gap-2">
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={t("notesCommandClearSelection")}
								onClick={() => {
									useNotesSelectionStore.getState().clearSelectedNotes()
								}}
							>
								<XIcon />
							</Button>
						}
					/>
					<TooltipContent>
						{t("notesCommandClearSelection")}
						<Kbd action="notes.clearSelection" />
					</TooltipContent>
				</Tooltip>
				<p className="text-sm text-muted-foreground">{t("notesSelectionCount", { count: selectedNotes.length })}</p>
			</div>
			<div className="flex items-center gap-2">
				{descriptors.map(descriptor => {
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
											aria-label={t(descriptor.labelKey)}
										>
											{createElement(descriptor.icon, { "aria-hidden": true })}
										</Button>
									}
								/>
								<DropdownMenuContent align="end">
									{entries.length === 0 ? (
										<DropdownMenuItem disabled>{t("noteTagsSubmenuEmpty")}</DropdownMenuItem>
									) : (
										entries
									)}
								</DropdownMenuContent>
							</DropdownMenu>
						)
					}

					if (descriptor.run === "dialog") {
						return (
							<Tooltip key={descriptor.id}>
								<TooltipTrigger
									render={
										<Button
											variant={descriptor.destructive ? "destructive" : "outline"}
											size="icon-sm"
											aria-label={t(descriptor.labelKey)}
											onClick={() => {
												onDialogAction(descriptor.dialogKind, selectedNotes)
											}}
										>
											{createElement(descriptor.icon, { "aria-hidden": true })}
										</Button>
									}
								/>
								<TooltipContent>{t(descriptor.labelKey)}</TooltipContent>
							</Tooltip>
						)
					}

					return (
						<Tooltip key={descriptor.id}>
							<TooltipTrigger
								render={
									<Button
										variant="outline"
										size="icon-sm"
										aria-label={t(descriptor.labelKey)}
										onClick={() => {
											runDescriptor(descriptor)
										}}
									>
										{createElement(descriptor.icon, { "aria-hidden": true })}
									</Button>
								}
							/>
							<TooltipContent>{t(descriptor.labelKey)}</TooltipContent>
						</Tooltip>
					)
				})}
			</div>
		</div>
	)
}
