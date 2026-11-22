import { useTranslation } from "react-i18next"
import { CopyIcon, MessageSquareReplyIcon, NotebookPenIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { useAssistantStore } from "@/features/assistant/store/useAssistantStore"
import { awaitingConfirmation, type TurnActions } from "@/features/assistant/store/transcript"
import { actOnAssistantReply, sendAssistantMessage } from "@/features/assistant/store/assistantSession"
import { coverageKeys, type CoverageNote, type TranscriptRow } from "@/features/assistant/components/assistant.logic"

type FooterRow = Extract<TranscriptRow, { kind: "footer" }>

function useTurnBusy(): boolean {
	return useAssistantStore(state => state.activeTurnId !== null && !awaitingConfirmation(state))
}

// Under a reply whose document read covered only part of what it asked for: what it covered, and [Read the rest],
// which asks for the pages after it as the next question.
function CoverageLine({ note }: { note: CoverageNote }) {
	const { t } = useTranslation("assistant")
	const busy = useTurnBusy()
	const { coverage, subject } = note
	const { note: noteKey, rest, restFrom } = coverageKeys(coverage)

	return (
		<p className="flex flex-wrap items-baseline gap-x-2 text-xs leading-5 text-muted-foreground">
			<span>{t(noteKey, { from: coverage.from, to: coverage.to, units: coverage.units })}</span>
			{subject === null ? null : (
				<button
					type="button"
					disabled={busy}
					className="rounded-sm font-medium text-foreground underline-offset-2 focus-ring outline-none hover:underline disabled:opacity-50"
					onClick={() => {
						sendAssistantMessage(t(rest, { name: subject, from: restFrom, to: coverage.end }))
					}}
				>
					{t("assistantReadRest")}
				</button>
			)}
		</p>
	)
}

// Acting on what the turn read: Copy the reply as shown, Save it as a note, or Draft a reply in the chat that was
// read. Save and Draft are turns of their own that end in the usual card, which shows exactly what is saved or
// drafted; a draft lands in the chat's input field for the user to send.
function ActionRow({ turnId, actions, reply }: { turnId: string; actions: TurnActions; reply: string }) {
	const { t } = useTranslation("assistant")
	const busy = useTurnBusy()

	return (
		<div
			role="group"
			aria-label={t("assistantReplyActions")}
			className="flex flex-wrap gap-1"
		>
			<Button
				size="xs"
				variant="ghost"
				onClick={() => {
					navigator.clipboard.writeText(reply).then(
						() => {
							toast.success(t("assistantReplyCopied"))
						},
						() => {
							toast.error(t("assistantReplyCopyFailed"))
						}
					)
				}}
			>
				<CopyIcon aria-hidden="true" />
				{t("assistantReplyCopy")}
			</Button>
			<Button
				size="xs"
				variant="ghost"
				disabled={busy}
				onClick={() => {
					actOnAssistantReply(
						turnId,
						{
							action: "save-note",
							title:
								actions.sourceName === null
									? t("assistantSavedNoteTitleFallback")
									: t("assistantSavedNoteTitle", { name: actions.sourceName })
						},
						t("assistantActSaveNote")
					)
				}}
			>
				<NotebookPenIcon aria-hidden="true" />
				{t("assistantReplySaveNote")}
			</Button>
			{actions.draftChat === null ? null : (
				<Button
					size="xs"
					variant="ghost"
					disabled={busy}
					className="min-w-0"
					onClick={() => {
						actOnAssistantReply(turnId, { action: "draft-reply" }, t("assistantActDraftReply"))
					}}
				>
					<MessageSquareReplyIcon aria-hidden="true" />
					<span className="truncate">
						{actions.draftChat === "" ? t("assistantReplyDraftUnnamed") : t("assistantReplyDraft", { chat: actions.draftChat })}
					</span>
				</Button>
			)}
		</div>
	)
}

export function AssistantReplyFooter({ row }: { row: FooterRow }) {
	return (
		<div className="flex flex-col gap-0.5 px-5 pb-1">
			{row.coverage.map(note => (
				<CoverageLine
					key={note.id}
					note={note}
				/>
			))}
			{row.actions === null ? null : (
				<ActionRow
					turnId={row.turnId}
					actions={row.actions}
					reply={row.reply}
				/>
			)}
		</div>
	)
}
