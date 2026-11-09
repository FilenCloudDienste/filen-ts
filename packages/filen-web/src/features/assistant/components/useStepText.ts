import { useTranslation } from "react-i18next"
import type { TranscriptStep } from "@/features/assistant/store/transcript"
import {
	ROUTE_KEYS,
	STEP_FAILURE_KEYS,
	durationFigure,
	stepCountNoun,
	toolActivityKey,
	toolSubjectKey
} from "@/features/assistant/components/assistant.logic"

export interface StepText {
	label: string
	// What came of it, or why it stopped; null when the glyph says it all.
	detail: string | null
	// How far a running call got, shown in its row; changes too often for the live region to read.
	live: string | null
}

const figureFormats = new Map<number, Intl.NumberFormat>()

// Seconds and counts, grouped and with the decimal mark of the browser's region, which numbers follow.
function figureFormat(fractionDigits: 0 | 1): Intl.NumberFormat {
	let format = figureFormats.get(fractionDigits)

	if (format === undefined) {
		format = new Intl.NumberFormat(undefined, { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits })
		figureFormats.set(fractionDigits, format)
	}

	return format
}

// "4.2 s"; a running step counts whole seconds.
export function useDurationText(): (ms: number, live: boolean) => string {
	const { t } = useTranslation("assistant")

	return (ms, live) => {
		const { seconds, fractionDigits } = durationFigure(ms, live)

		return t("assistantDurationSeconds", { seconds: figureFormat(fractionDigits).format(seconds) })
	}
}

// A step's wording, also what the live region reads. A subject is plain text from the runtime (sanitized,
// shortened) and only ever interpolated into a text node.
export function useStepText(): (step: TranscriptStep) => StepText {
	const { t } = useTranslation("assistant")

	const count = (tool: string, resultCount: number, more: boolean): string => {
		switch (stepCountNoun(tool)) {
			case "notes":
				return t("assistantStepCountNotes", { count: resultCount })
			case "chats":
				return t("assistantStepCountChats", { count: resultCount })
			case "playlists":
				return t("assistantStepCountPlaylists", { count: resultCount })
			case "items":
				return more
					? t("assistantStepCountItemsMore", { count: resultCount })
					: t("assistantStepCountItems", { count: resultCount })
		}
	}

	const ended = (status: TranscriptStep["status"]): string | null => (status === "stopped" ? t("assistantStepStopped") : null)
	const plain = (label: string, detail: string | null): StepText => ({ label, detail, live: null })

	return step => {
		switch (step.kind) {
			case "loading":
				return plain(
					t(
						step.status === "done"
							? "assistantStepLoaded"
							: step.status === "failed"
								? "assistantStepLoadFailed"
								: "assistantStepLoading"
					),
					ended(step.status)
				)
			case "routing":
				return plain(
					step.status === "done" && step.route !== null ? t(ROUTE_KEYS[step.route]) : t("assistantStepRouting"),
					ended(step.status)
				)
			case "thinking":
				return plain(t("assistantStepThinking"), ended(step.status))
			case "replying":
				return plain(t("assistantStepReplying"), ended(step.status))
			case "tool": {
				const subjectKey = toolSubjectKey(step.tool)
				const label =
					subjectKey !== null && step.subject !== null ? t(subjectKey, { subject: step.subject }) : t(toolActivityKey(step.tool))
				let detail: string | null

				if (step.status === "waiting") {
					detail = t("assistantStepWaiting")
				} else if (step.status === "queued") {
					detail = t("assistantStepQueued")
				} else if (step.status === "failed") {
					detail = t(STEP_FAILURE_KEYS[step.failure ?? "error"])
				} else if (step.status === "done" && step.resultCount !== null) {
					detail = count(step.tool, step.resultCount, step.resultMore)
				} else {
					detail = ended(step.status)
				}

				return {
					label,
					detail,
					// The engine's candidates for one word of the query, before the call narrows them to the results.
					live:
						step.status === "active" && step.found !== undefined
							? t("assistantStepCandidates", { count: step.found, figure: figureFormat(0).format(step.found) })
							: null
				}
			}
		}
	}
}
