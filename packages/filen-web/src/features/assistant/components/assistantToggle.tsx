import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { SparklesIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { i18n, type AssistantKey } from "@/lib/i18n"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useAction } from "@/lib/keymap/useAction"
import { Kbd } from "@/lib/keymap/kbd"
import { useIsNarrowViewport } from "@/features/shell/hooks/useIsNarrowViewport"
import { isNarrowViewport } from "@/features/shell/lib/breakpoints"
import { RailProgressBar, RailTooltipDetail } from "@/features/shell/components/railProgressBar"
import {
	hydrateAssistantPanelOpen,
	toggleAssistant,
	useAssistantStore,
	useAssistantVisible
} from "@/features/assistant/store/useAssistantStore"
import { awaitingConfirmation, type TranscriptState } from "@/features/assistant/store/transcript"
import { downloadingPercent } from "@/features/assistant/components/assistant.logic"
import { useResumeInterruptedDownload } from "@/features/assistant/components/assistantDownloadResume"
import {
	ASSISTANT_PANEL_ID,
	ASSISTANT_TOGGLE_ID,
	assistantKeyIgnored,
	moveFocusOutOfAssistant
} from "@/features/assistant/components/assistantFocus"

// The rail is mounted for the whole authed session, so the persisted open state loads once, here.
void hydrateAssistantPanelOpen()

const CONFIRMATION_TOAST_ID = "assistant-confirmation"

// What the hidden panel would show: a turn still working, a card waiting for the user, or a turn that
// finished unseen. The assistant's own navigation closes the narrow drawer mid-turn, and a waiting card
// keeps the model in memory until it expires.
type RailCue = "working" | "waiting" | "finished"

const CUE_LABEL_KEYS: Record<RailCue, AssistantKey> = {
	working: "assistantToggleWorking",
	waiting: "assistantToggleWaiting",
	finished: "assistantToggleFinished"
}

const CUE_DETAIL_KEYS: Record<RailCue, AssistantKey> = {
	working: "assistantRailWorking",
	waiting: "assistantRailWaiting",
	finished: "assistantRailFinished"
}

function turnCue(state: TranscriptState): RailCue | null {
	if (state.activeTurnId === null) {
		return null
	}

	return awaitingConfirmation(state) ? "waiting" : "working"
}

function panelVisible(state: { panelOpen: boolean; drawerOpen: boolean }): boolean {
	return isNarrowViewport() ? state.drawerOpen : state.panelOpen
}

function showAssistant(): void {
	const { setPanelOpen, setDrawerOpen } = useAssistantStore.getState()

	if (isNarrowViewport()) {
		setDrawerOpen(true)
	} else {
		setPanelOpen(true)
	}
}

// For the lifetime of the rail: whether a turn finished while the panel was hidden, until it shows again;
// and a toast for a card that starts waiting unseen, since only a click on it can answer it.
function useHiddenTurnOutcome(): boolean {
	const [finishedUnseen, setFinishedUnseen] = useState(false)

	useEffect(
		() =>
			useAssistantStore.subscribe((state, previous) => {
				const visible = panelVisible(state)
				const waiting = awaitingConfirmation(state)
				const wasWaiting = awaitingConfirmation(previous)

				if (visible) {
					setFinishedUnseen(false)
				} else if (state.settled !== null && state.settled !== previous.settled) {
					setFinishedUnseen(true)
				}

				if (waiting && !wasWaiting && !visible) {
					toast(i18n.t("assistant:assistantConfirmationToast"), {
						id: CONFIRMATION_TOAST_ID,
						action: { label: i18n.t("assistant:assistantConfirmationToastShow"), onClick: showAssistant }
					})
				} else if ((wasWaiting && !waiting) || (visible && !panelVisible(previous))) {
					toast.dismiss(CONFIRMATION_TOAST_ID)
				}
			}),
		[]
	)

	return finishedUnseen
}

// Opens the inline panel at desktop widths and the drawer below them; pressed while the panel shows. The
// rail owns the visual recipe (`itemClass`), so the toggle looks like every other rail entry. A model
// download shows on it as the Transfers entry shows its own, panel open or not: it can run unasked (resumed).
// While the panel is hidden, a dot says a turn works (pulsing), waits for the user, or finished unseen.
export function AssistantToggle({ itemClass }: { itemClass: (active: boolean) => string }) {
	const { t } = useTranslation(["common", "assistant"])
	const narrow = useIsNarrowViewport()
	const visible = useAssistantVisible(narrow)
	// A whole percentage, so progress re-renders the button once per percent at most.
	const percent = useAssistantStore(state => downloadingPercent(state.modelState))
	const activeCue = useAssistantStore(turnCue)
	const finishedUnseen = useHiddenTurnOutcome()
	const cue = visible ? null : (activeCue ?? (finishedUnseen ? "finished" : null))
	const label =
		cue !== null
			? t(`assistant:${CUE_LABEL_KEYS[cue]}`)
			: percent === null
				? t("toggleAssistant")
				: t("assistant:assistantToggleDownloading")

	useResumeInterruptedDownload()

	function toggle(): void {
		if (visible && !narrow) {
			moveFocusOutOfAssistant()
		}

		toggleAssistant(narrow)
	}

	// Like the rail's route-nav actions, an open dialog or menu owns the keyboard, except the narrow drawer the
	// assistant itself is shown in, which its own key closes.
	useAction(
		"app.toggleAssistant",
		() => {
			toggle()
		},
		{ ignoreEventWhen: assistantKeyIgnored },
		[narrow, visible]
	)

	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						id={ASSISTANT_TOGGLE_ID}
						aria-label={label}
						aria-pressed={visible}
						aria-controls={visible ? ASSISTANT_PANEL_ID : undefined}
						className={percent === null && cue === null ? itemClass(visible) : cn(itemClass(visible), "relative")}
						onClick={toggle}
					>
						<SparklesIcon />
						{percent === null ? null : <RailProgressBar percent={percent} />}
						{cue === null ? null : (
							<span
								aria-hidden="true"
								className={cn(
									"absolute top-1 right-1 size-2 rounded-full bg-primary",
									cue === "working" && "motion-safe:animate-pulse"
								)}
							/>
						)}
					</button>
				}
			/>
			<TooltipContent side="right">
				{t("toggleAssistant")}
				{percent === null ? null : <RailTooltipDetail>{t("assistant:assistantStatusDownloading", { percent })}</RailTooltipDetail>}
				{cue === null ? null : <RailTooltipDetail>{t(`assistant:${CUE_DETAIL_KEYS[cue]}`)}</RailTooltipDetail>}
				<Kbd action="app.toggleAssistant" />
			</TooltipContent>
		</Tooltip>
	)
}
