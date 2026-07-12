import { useTranslation } from "react-i18next"
import { useNavigate } from "@tanstack/react-router"
import { StickyNoteIcon, MoreHorizontalIcon } from "lucide-react"
import type { Note } from "@filen/sdk-rs"
import { noteIcon } from "@/features/notes/lib/icon.logic"
import { isNoteUndecryptable } from "@/features/notes/lib/sort"
import { NoteContentBody } from "@/features/notes/components/noteContentBody"
import { CannotDecryptState } from "@/components/cannotDecryptState"
import { NoteRemoteEditBanner } from "@/features/notes/components/noteRemoteEditBanner"
import { NoteDropdownMenuContent } from "@/features/notes/components/noteMenu"
import { useNoteDialogHost } from "@/features/notes/hooks/useNoteDialogHost"
import { useNoteTags } from "@/features/notes/queries/noteTags"
import { useNoteInflight } from "@/features/notes/store/useNotesInflight"
import { sync } from "@/features/notes/lib/sync"
import { registerAction } from "@/lib/keymap/registry"
import { useAction } from "@/lib/keymap/useAction"
import { useAccountQuery } from "@/queries/account"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

// Cmd/Ctrl+S — flush the outbox debounce immediately (executeNow), so a user who reflexively saves gets
// their push kicked at once instead of waiting out the 3s. Nothing is shown on success — the header
// spinner already communicates in-flight state. Shares its literal combo with the drive/preview save
// actions, harmlessly: only ONE of those surfaces is mounted at a time (notes route vs drive route vs
// preview overlay). `enableOnContentEditable`: react-hotkeys-hook's default ignore-list drops a hotkey
// whose event target is contentEditable, and CodeMirror's content DOM sets contenteditable while
// editable — without this override Cmd/Ctrl+S would never fire while the cursor is inside the editor,
// exactly when a user presses it.
registerAction({
	id: "notes.saveNow",
	defaultCombo: "mod+s",
	scope: "notes",
	descriptionKey: "notesSaveAction"
})

export interface NoteEditorPaneProps {
	// The resolved selected note, or undefined when nothing is selected / not yet resolved.
	note?: Note | undefined
	// True while the note list (which the selected note is resolved from) is still loading.
	loading?: boolean | undefined
}

// The main content card for the notes module: a titled header for the selected note (icon + title +
// sync spinner + the ⋮ menu, sharing noteMenu.logic.ts's descriptor list with the sidebar row's menu)
// plus the per-type content body (NoteContentBody) — live CodeMirror editors for text/code/md, wired to
// the fault-tolerant outbox; read-only readers for trashed/rich/checklist.
export function NoteEditorPane({ note, loading = false }: NoteEditorPaneProps) {
	// ["notes", "common"] so the header can reach the shared cannot-decrypt label; notes stays the
	// default namespace, so every bare t("notes…") key below is unaffected.
	const { t } = useTranslation(["notes", "common"])
	const navigate = useNavigate()
	const tagsQuery = useNoteTags()
	const accountQuery = useAccountQuery()
	// This host's own dialogs act on `note` alone, and `note` IS the currently-routed note by
	// construction (notes.$uuid.tsx resolves it from the route param) — so a delete/leave confirmed here
	// always navigates away, unlike the sidebar's host which also serves rows for OTHER notes.
	const dialogHost = useNoteDialogHost({ currentUuid: note?.uuid ?? "" })
	// Reactive has/has-not edge for THIS note's outbox. "" (no note) is never inflight. Drives the
	// header sync spinner + menu suppression, mirroring mobile's header (screens/noteEditor.tsx) and
	// note-menu (components/note/menu.tsx) inflight gating.
	const isInflight = useNoteInflight(note?.uuid ?? "")

	// Registered before the early return (hook order). Dialog-guarded like every other action: a Cmd+S
	// with a note-action dialog open returns before preventDefault so the browser default runs, never
	// flushing behind the modal.
	useAction(
		"notes.saveNow",
		keyboardEvent => {
			if (dialogHost.isDialogOpen) {
				return
			}

			keyboardEvent.preventDefault()
			sync.executeNow()
		},
		{ enableOnContentEditable: true },
		[dialogHost.isDialogOpen]
	)

	if (note === undefined) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
				<StickyNoteIcon className="size-8 text-muted-foreground/60" />
				<div className="flex flex-col gap-1">
					<p className="font-heading text-lg font-medium tracking-tight">
						{loading ? t("notesLoadingNote") : t("notesSelectPrompt")}
					</p>
					{!loading ? <p className="text-sm text-muted-foreground">{t("notesSelectPromptDescription")}</p> : null}
				</div>
			</div>
		)
	}

	const { icon: Icon, colorClass } = noteIcon(note)
	// An undecryptable note has no readable title/body — its metadata stayed ciphertext (no key for
	// this account). The header shows a "cannot decrypt" label (never the misleading "Untitled note"),
	// the ⋮ menu is already reduced to its uuid-only actions (noteMenuActions), and the body is the
	// shared explainer instead of an editor that could only fail to load.
	const undecryptable = isNoteUndecryptable(note)
	const title = undecryptable
		? t("common:cannotDecryptTitle")
		: note.title !== undefined && note.title.length > 0
			? note.title
			: t("noteUntitled")

	async function handleDuplicated(duplicated: Note): Promise<void> {
		await navigate({ to: "/notes/$uuid", params: { uuid: duplicated.uuid } })
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex shrink-0 items-center gap-2.5 px-5 py-4">
				<Icon className={`size-5 shrink-0 ${colorClass}`} />
				<h1 className="min-w-0 flex-1 truncate text-base font-semibold">{title}</h1>
				{/* Subtle in-flight indicator next to the title (mobile parity) — the note is mid-sync. */}
				{isInflight ? (
					<Spinner
						className="size-4 shrink-0 text-muted-foreground"
						aria-label={t("noteSyncing")}
					/>
				) : null}
				<DropdownMenu>
					{/* Menu trigger suppressed while inflight — disabled-not-hidden (mobile suppresses the menu
					entirely mid-sync): acting on a note whose content is mid-flight is blocked, but the
					control stays in place so the header doesn't reflow. */}
					<DropdownMenuTrigger
						render={
							<Button
								variant="ghost"
								size="icon-sm"
								disabled={isInflight}
								aria-label={t("noteItemMenuTrigger")}
							>
								<MoreHorizontalIcon />
							</Button>
						}
					/>
					<NoteDropdownMenuContent
						note={note}
						allTags={tagsQuery.data ?? []}
						currentUserId={accountQuery.data?.id}
						onAction={dialogHost.openNoteDialog}
						onDuplicated={duplicated => {
							void handleDuplicated(duplicated)
						}}
					/>
				</DropdownMenu>
			</header>
			<Separator className="bg-border/50" />
			{/* Realtime reload-vs-keep prompt — shown only when this note is dirty AND the server's content
			    moved (a clean note refetches silently). Sits above the editor, never blocks it. */}
			<NoteRemoteEditBanner note={note} />
			{/* An undecryptable note never mounts the editor (NoteContentBody would only fetch a body it
			    can't decrypt); the shared explainer stands in its place. Otherwise the per-type editor,
			    keyed by uuid so switching the selected note rebuilds the content controller fresh. */}
			{undecryptable ? (
				<CannotDecryptState className="min-h-0 flex-1" />
			) : (
				<NoteContentBody
					key={note.uuid}
					note={note}
				/>
			)}
			{dialogHost.renderActiveDialog()}
		</div>
	)
}
