import { useTranslation } from "react-i18next"
import { useAssistantStore } from "@/features/assistant/store/useAssistantStore"
import { awaitingConfirmation } from "@/features/assistant/store/transcript"
import { sendAssistantMessage } from "@/features/assistant/store/assistantSession"
import { coverageKeys, type CoverageNote } from "@/features/assistant/components/assistant.logic"

// Under a reply whose document read covered only part of what it asked for: what it covered, and [Read the rest],
// which asks for the pages after it as the next question.
function CoverageLine({ note }: { note: CoverageNote }) {
	const { t } = useTranslation("assistant")
	const busy = useAssistantStore(state => state.activeTurnId !== null && !awaitingConfirmation(state))
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

export function AssistantReplyFooter({ coverage }: { coverage: readonly CoverageNote[] }) {
	return (
		<div className="flex flex-col gap-0.5 px-5 pb-1">
			{coverage.map(note => (
				<CoverageLine
					key={note.id}
					note={note}
				/>
			))}
		</div>
	)
}
