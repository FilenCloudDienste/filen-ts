import { useId, type MouseEvent } from "react"
import { useTranslation } from "react-i18next"
import {
	ArchiveIcon,
	ArchiveRestoreIcon,
	ArrowRightLeftIcon,
	CheckIcon,
	CircleAlertIcon,
	CopyIcon,
	FileIcon,
	FolderClosedIcon,
	FolderPlusIcon,
	FolderTreeIcon,
	HeartIcon,
	HeartOffIcon,
	ListMusicIcon,
	ListPlusIcon,
	MessageSquareTextIcon,
	MessagesSquareIcon,
	MusicIcon,
	NotebookIcon,
	NotebookPenIcon,
	PencilIcon,
	PinIcon,
	PinOffIcon,
	ReplaceAllIcon,
	RotateCcwIcon,
	StarIcon,
	StarOffIcon,
	Trash2Icon,
	type LucideIcon
} from "lucide-react"
import { cn } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import type { AssistantKey } from "@/lib/i18n"
import type { ProposalStatus } from "@/features/assistant/store/transcript"
import { confirmAssistantProposal, rejectAssistantProposal } from "@/features/assistant/store/assistantSession"
import { isTrustedActivation } from "@/features/assistant/components/userActivation"
import { useProposalTitle } from "@/features/assistant/components/useProposalTitle"
import { assistantInitialFocusTarget } from "@/features/assistant/components/assistantFocus"
import { AssistantBatchPlanList } from "@/features/assistant/components/assistantBatchPlan"
import {
	batchChangeCount,
	noteFlagChangeKeys,
	proposalTargetKind,
	type ProposalTargetKind
} from "@/features/assistant/components/assistant.logic"
import type { AssistantProposal, AssistantProposalAction } from "@/features/assistant/types"

const ACTION_ICONS: Record<AssistantProposalAction, LucideIcon> = {
	"draft-message": MessageSquareTextIcon,
	move: ArrowRightLeftIcon,
	copy: CopyIcon,
	trash: Trash2Icon,
	restore: RotateCcwIcon,
	rename: PencilIcon,
	"batch-rename": ReplaceAllIcon,
	"organize-by-date": FolderTreeIcon,
	favorite: StarIcon,
	unfavorite: StarOffIcon,
	"create-directory": FolderPlusIcon,
	"create-note": NotebookPenIcon,
	"note-flags": NotebookIcon,
	"add-to-playlist": ListPlusIcon
}

const TARGET_ICONS: Record<ProposalTargetKind, LucideIcon> = {
	file: FileIcon,
	directory: FolderClosedIcon,
	note: NotebookPenIcon,
	chat: MessagesSquareIcon,
	playlist: ListMusicIcon,
	track: MusicIcon
}

// The notes menu's icons for the same actions.
const NOTE_FLAG_ICONS = new Map<AssistantKey, LucideIcon>([
	["assistantProposalPin", PinIcon],
	["assistantProposalUnpin", PinOffIcon],
	["assistantProposalNoteFavorite", HeartIcon],
	["assistantProposalNoteUnfavorite", HeartOffIcon],
	["assistantProposalArchive", ArchiveIcon],
	["assistantProposalUnarchive", ArchiveRestoreIcon]
])

const TEXT_LABEL_KEYS = new Map<string, AssistantKey>([
	["name", "assistantProposalName"],
	["new_name", "assistantProposalNewName"],
	["title", "assistantProposalNoteTitle"],
	["type", "assistantProposalNoteType"],
	["find", "assistantProposalFind"]
])

function SettledStatus({ status }: { status: Exclude<ProposalStatus, "pending"> }) {
	const { t } = useTranslation("assistant")

	switch (status) {
		case "running":
			return (
				<span className="flex items-center gap-1.5 text-muted-foreground">
					<Spinner
						aria-hidden="true"
						className="size-3.5"
					/>
					{t("assistantProposalRunning")}
				</span>
			)
		case "done":
			return (
				<span className="flex items-center gap-1.5 text-muted-foreground">
					<CheckIcon
						aria-hidden="true"
						className="size-3.5"
					/>
					{t("assistantProposalDone")}
				</span>
			)
		case "failed":
			return (
				<span className="flex items-center gap-1.5 text-destructive">
					<CircleAlertIcon
						aria-hidden="true"
						className="size-3.5"
					/>
					{t("assistantProposalFailed")}
				</span>
			)
		case "cancelled":
			return <span className="text-muted-foreground">{t("assistantProposalCancelled")}</span>
		case "expired":
			return <span className="text-muted-foreground">{t("assistantProposalExpired")}</span>
		case "interrupted":
			return <span className="text-muted-foreground">{t("assistantProposalInterrupted")}</span>
	}
}

// A group chat lists this many addresses, then how many more.
const RECIPIENTS_SHOWN = 5

// Who the draft reaches, by address: two contacts can share a display name, never an address.
function DraftRecipients({ recipients }: { recipients: readonly string[] }) {
	const { t } = useTranslation("assistant")
	const shown = recipients.slice(0, RECIPIENTS_SHOWN).join(", ")
	const more = recipients.length - RECIPIENTS_SHOWN

	return (
		<p className="text-xs leading-5 wrap-anywhere text-muted-foreground">
			{more > 0
				? t("assistantProposalDraftToMore", { recipients: shown, count: more })
				: t("assistantProposalDraftTo", { recipients: shown })}
		</p>
	)
}

// The drafted message, verbatim and in full: it is exactly what lands in the chat's input field.
function DraftBody({ proposal }: { proposal: AssistantProposal }) {
	const { t } = useTranslation("assistant")
	const recipients = proposal.targets[0]?.recipients ?? []

	return (
		<>
			{recipients.length > 0 ? <DraftRecipients recipients={recipients} /> : null}
			<p
				aria-label={t("assistantProposalDraftText")}
				className="max-h-48 scrollbar-gutter-stable overflow-y-auto rounded-xl bg-muted/60 px-2.5 py-2 text-xs leading-5 wrap-anywhere whitespace-pre-wrap select-text"
			>
				{proposal.text["text"] ?? ""}
			</p>
			<p className="text-xs text-muted-foreground">{t("assistantProposalDraftNote")}</p>
		</>
	)
}

// What a note-flags card changes on its note, one line per flag.
function NoteFlagChanges({ text }: { text: AssistantProposal["text"] }) {
	const { t } = useTranslation("assistant")

	return (
		<ul
			aria-label={t("assistantProposalChanges")}
			className="flex flex-col gap-1 text-xs leading-5"
		>
			{noteFlagChangeKeys(text).map(key => {
				const ChangeIcon = NOTE_FLAG_ICONS.get(key) ?? NotebookIcon

				return (
					<li
						key={key}
						className="flex items-center gap-2 font-medium"
					>
						<ChangeIcon
							aria-hidden="true"
							className="size-3.5 shrink-0 text-muted-foreground"
						/>
						{t(key)}
					</li>
				)
			})}
		</ul>
	)
}

function WriteBody({ proposal }: { proposal: AssistantProposal }) {
	const { t } = useTranslation("assistant")
	const flags = proposal.action === "note-flags"
	const textEntries = flags ? [] : Object.entries(proposal.text)

	return (
		<>
			{proposal.batch === undefined ? null : <AssistantBatchPlanList plan={proposal.batch} />}
			{proposal.targets.length > 0 ? (
				<ul
					aria-label={t("assistantProposalItems")}
					className="flex max-h-40 scrollbar-gutter-stable flex-col gap-1 overflow-y-auto rounded-xl bg-muted/60 px-2.5 py-2"
				>
					{proposal.targets.map(target => {
						const TargetIcon = TARGET_ICONS[proposalTargetKind(target.handle)]

						return (
							<li
								key={target.handle}
								className="flex min-w-0 items-start gap-2 text-xs leading-5"
							>
								<TargetIcon
									aria-hidden="true"
									className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
								/>
								<span className="min-w-0 wrap-anywhere">{target.name}</span>
								{proposal.action === "restore" ? (
									<span className="ml-auto shrink-0 pl-2 text-muted-foreground">
										{proposalTargetKind(target.handle) === "note"
											? t("assistantProposalRestoreToNotes")
											: target.restoreTo === undefined
												? t("assistantProposalRestoreToOriginal")
												: t("assistantProposalRestoreToPath", { path: target.restoreTo })}
									</span>
								) : null}
							</li>
						)
					})}
				</ul>
			) : null}
			{flags ? <NoteFlagChanges text={proposal.text} /> : null}
			{proposal.destination !== null || textEntries.length > 0 ? (
				<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs leading-5">
					{proposal.destination !== null ? (
						<>
							<dt className="text-muted-foreground">
								{t(proposal.action === "add-to-playlist" ? "assistantProposalPlaylist" : "assistantProposalDestination")}
							</dt>
							<dd className="min-w-0 font-medium wrap-anywhere">{proposal.destination}</dd>
						</>
					) : null}
					{textEntries.map(([key, value]) => (
						<div
							key={key}
							className="contents"
						>
							<dt className="text-muted-foreground">{t(TEXT_LABEL_KEYS.get(key) ?? "assistantProposalText")}</dt>
							<dd className="min-w-0 font-medium wrap-anywhere whitespace-pre-wrap">{value}</dd>
						</div>
					))}
				</dl>
			) : null}
		</>
	)
}

// The confirm button's words; a batch card counts the files it changes.
function useConfirmLabel(): (proposal: AssistantProposal) => string {
	const { t } = useTranslation("assistant")

	return proposal => {
		switch (proposal.action) {
			case "trash":
				return t("assistantConfirmTrash")
			case "draft-message":
				return t("assistantConfirmDraft")
			case "restore":
				return t("assistantConfirmRestore", { count: proposal.targets.length })
			case "batch-rename":
				return t("assistantConfirmBatchRename", { count: proposal.batch === undefined ? 0 : batchChangeCount(proposal.batch) })
			case "organize-by-date":
				return t("assistantConfirmOrganize", { count: proposal.batch === undefined ? 0 : batchChangeCount(proposal.batch) })
			default:
				return t("assistantConfirm")
		}
	}
}

// A consequential call, spelled out exactly: every affected name (never a handle), the count in the title,
// where it goes and any text verbatim. Nothing runs until Confirm gets a click the browser itself
// dispatched (userActivation.ts), and that click runs the work synchronously so a download keeps its user
// activation. Never auto-focused, so a stray Enter in the composer can never land on Confirm.
export function AssistantConfirmationCard({ proposal, status }: { proposal: AssistantProposal; status: ProposalStatus }) {
	const { t } = useTranslation("assistant")
	const titleId = useId()
	const title = useProposalTitle()(proposal)
	const confirmLabel = useConfirmLabel()
	const Icon = ACTION_ICONS[proposal.action]
	const destructive = proposal.action === "trash"

	function onConfirm(event: MouseEvent<HTMLButtonElement>): void {
		if (!isTrustedActivation(event)) {
			return
		}

		// Both buttons leave with the pending state, which would drop focus to the page: the composer takes it.
		assistantInitialFocusTarget()?.focus()
		confirmAssistantProposal(proposal.id)
	}

	function onDecline(): void {
		assistantInitialFocusTarget()?.focus()
		rejectAssistantProposal(proposal.id)
	}

	return (
		<div
			role="group"
			aria-labelledby={titleId}
			className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-3 text-sm text-card-foreground shadow-sm"
		>
			<div className="flex items-start gap-2">
				<Icon
					aria-hidden="true"
					className={cn("mt-0.5 size-4 shrink-0", destructive ? "text-destructive" : "text-muted-foreground")}
				/>
				<h3
					id={titleId}
					className="min-w-0 font-semibold wrap-anywhere"
				>
					{title}
				</h3>
			</div>
			{proposal.action === "draft-message" ? <DraftBody proposal={proposal} /> : <WriteBody proposal={proposal} />}
			<div className="flex min-h-7 items-center justify-end gap-2 text-xs">
				{status === "pending" ? (
					<>
						<Button
							variant="outline"
							size="sm"
							onClick={onDecline}
						>
							{t("assistantDecline")}
						</Button>
						<Button
							variant={destructive ? "destructive" : "default"}
							size="sm"
							onClick={onConfirm}
						>
							{confirmLabel(proposal)}
						</Button>
					</>
				) : (
					<SettledStatus status={status} />
				)}
			</div>
		</div>
	)
}
