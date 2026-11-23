import { useTranslation } from "react-i18next"
import { SparklesIcon } from "lucide-react"
import type { AssistantKey } from "@/lib/i18n"
import { useAssistantStore } from "@/features/assistant/store/useAssistantStore"
import { sendAssistantMessage } from "@/features/assistant/store/assistantSession"
import { assistantInitialFocusTarget } from "@/features/assistant/components/assistantFocus"
import type { TranscriptEntry } from "@/features/assistant/store/transcript"
import { AssistantTranscript } from "@/features/assistant/components/assistantTranscript"
import { TURN_END_KEYS, currentStep, spokenText, transcriptRows } from "@/features/assistant/components/assistant.logic"
import { useStepText } from "@/features/assistant/components/useStepText"
import { useProposalTitle } from "@/features/assistant/components/useProposalTitle"
import { AssistantComposer } from "@/features/assistant/components/assistantComposer"
import { AssistantDocumentChip } from "@/features/assistant/components/assistantDocumentChip"
import { AssistantModelStatus } from "@/features/assistant/components/assistantModelStatus"

const EXAMPLE_KEYS: readonly AssistantKey[] = [
	"assistantExampleFind",
	"assistantExampleSummarize",
	"assistantExampleOpen",
	"assistantExampleNavigate"
]

function EmptyConversation() {
	const { t } = useTranslation("assistant")

	return (
		<div className="flex min-h-0 flex-1 scrollbar-gutter-stable flex-col items-center justify-center gap-3 overflow-y-auto px-6 py-8 text-center">
			<div
				aria-hidden="true"
				className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground"
			>
				<SparklesIcon className="size-6" />
			</div>
			<h3 className="text-base font-semibold">{t("assistantEmptyTitle")}</h3>
			<p className="text-sm text-muted-foreground">{t("assistantEmptyBody")}</p>
			<ul
				aria-label={t("assistantExamplesLabel")}
				className="flex w-full max-w-80 flex-col gap-1.5"
			>
				{EXAMPLE_KEYS.map(key => (
					<li key={key}>
						<button
							type="button"
							className="w-full rounded-xl border border-border bg-background/60 px-3 py-2 text-left text-sm focus-ring transition-colors outline-none hover:bg-muted"
							onClick={() => {
								// The transcript replaces this screen on the next render; the composer stays.
								if (sendAssistantMessage(t(key))) {
									assistantInitialFocusTarget()?.focus()
								}
							}}
						>
							{t(key)}
						</button>
					</li>
				))}
			</ul>
		</div>
	)
}

// Polite announcements of what the turn is doing (each step as it starts, never its progress or time), of a
// card as it starts waiting (its title, who a draft reaches and the draft itself, which is what the user
// confirms), and of the reply once the turn settles, never per token: the streaming bubble itself is not a
// live region.
function Announcer({ entries }: { entries: readonly TranscriptEntry[] }) {
	const { t } = useTranslation("assistant")
	const activeTurnId = useAssistantStore(state => state.activeTurnId)
	const settled = useAssistantStore(state => state.settled)
	const proposalTitle = useProposalTitle()
	const stepText = useStepText()
	let text = ""

	if (activeTurnId !== null) {
		const steps = entries.findLast(entry => entry.kind === "steps" && entry.turnId === activeTurnId)
		const step = steps?.kind === "steps" ? currentStep(steps) : null
		const card = entries.findLast(entry => entry.kind === "proposal" && entry.turnId === activeTurnId && entry.status === "pending")

		if (step?.status === "waiting" && card?.kind === "proposal") {
			const { proposal } = card
			const recipients = proposal.targets[0]?.recipients ?? []

			text = [
				t("assistantProposalAnnouncement", { title: proposalTitle(proposal) }),
				...(proposal.action === "draft-message"
					? [
							...(recipients.length > 0 ? [t("assistantProposalDraftTo", { recipients: recipients.join(", ") })] : []),
							proposal.text["text"] ?? ""
						]
					: [])
			].join("\n")
		} else if (step === null) {
			text = t("assistantResponding")
		} else {
			const { label, detail } = stepText(step)

			text = detail === null ? label : t("assistantStepAnnouncement", { label, detail })
		}
	} else if (settled !== null) {
		const parts: string[] = []

		for (const entry of entries) {
			if (entry.turnId !== settled.turnId) {
				continue
			}

			if (entry.kind === "reply") {
				// A withheld reply has no text; it reads as the message the transcript shows in its place.
				parts.push(entry.withheld === true ? t("assistantReplyWithheld") : spokenText(entry.text))
			} else if (entry.kind === "turnEnd") {
				parts.push(t(TURN_END_KEYS[entry.outcome]))
			}
		}

		text = parts.join("\n")
	}

	return (
		<div
			aria-live="polite"
			className="sr-only"
		>
			{text}
		</div>
	)
}

export function AssistantConversation() {
	const entries = useAssistantStore(state => state.entries)
	const activeTurnId = useAssistantStore(state => state.activeTurnId)
	const actions = useAssistantStore(state => state.actions)

	return (
		<>
			{entries.length === 0 ? <EmptyConversation /> : <AssistantTranscript rows={transcriptRows(entries, activeTurnId, actions)} />}
			<Announcer entries={entries} />
			<AssistantModelStatus />
			<AssistantDocumentChip />
			<AssistantComposer />
		</>
	)
}
