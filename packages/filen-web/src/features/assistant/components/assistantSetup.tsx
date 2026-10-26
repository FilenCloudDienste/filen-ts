import { useTranslation } from "react-i18next"
import { SparklesIcon } from "lucide-react"
import { formatBytes } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import type { AssistantKey } from "@/lib/i18n"
import { desktopPlatform } from "@/lib/desktop"
import { cancelAssistantDownload, downloadAssistantModel } from "@/features/assistant/store/assistantSession"
import { downloadByteFigures, downloadPercent } from "@/features/assistant/components/assistant.logic"
import { ASSISTANT_PANEL_ID, assistantInitialFocusTarget } from "@/features/assistant/components/assistantFocus"
import type { AssistantModelError, AssistantModelInfo, AssistantModelState, AssistantUnavailableReason } from "@/features/assistant/types"

// Every model state a message cannot be sent from is this one screen; a model on disk shows the conversation.
export type AssistantSetupState = Exclude<AssistantModelState, { kind: "ready" | "loading" | "downloaded" }>

type TerminalReason = Exclude<AssistantUnavailableReason, "in-use-elsewhere">

const UNAVAILABLE_KEYS: Record<TerminalReason, AssistantKey> = {
	"unsupported-browser": "assistantUnavailableUnsupportedBrowser",
	"insufficient-memory": "assistantUnavailableInsufficientMemory",
	"insufficient-storage": "assistantUnavailableInsufficientStorage"
}

const ERROR_KEYS: Record<AssistantModelError, AssistantKey> = {
	"download-failed": "assistantErrorDownloadFailed",
	"load-failed": "assistantErrorLoadFailed",
	"out-of-memory": "assistantErrorOutOfMemory",
	"storage-full": "assistantErrorStorageFull"
}

const UNAVAILABLE_REASON_ID = "assistant-unavailable-reason"

function ModelFacts({ model }: { model: AssistantModelInfo }) {
	const { t } = useTranslation("assistant")

	return (
		<dl className="grid w-full max-w-72 grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-xl bg-muted/60 px-3 py-2 text-left text-xs">
			<dt className="text-muted-foreground">{t("assistantSetupModel")}</dt>
			<dd className="truncate font-medium">{model.name}</dd>
			<dt className="text-muted-foreground">{t("assistantSetupSize")}</dt>
			<dd className="font-medium tabular-nums">{formatBytes(model.sizeBytes)}</dd>
		</dl>
	)
}

// The opt-in: what it is, that it runs here, which model and how big, then the one button. On a device
// that cannot run it the same screen stays, with the button disabled and described by the reason.
function FirstRun({ model, unavailable }: { model: AssistantModelInfo | null; unavailable: TerminalReason | null }) {
	const { t } = useTranslation("assistant")

	return (
		<>
			<h3 className="text-base font-semibold">{t("assistantSetupTitle")}</h3>
			<p className="text-sm text-muted-foreground">{t("assistantSetupBody")}</p>
			{model !== null ? <ModelFacts model={model} /> : null}
			{unavailable !== null ? (
				<>
					<p className="text-sm font-medium">{t("assistantUnavailableTitle")}</p>
					<p
						id={UNAVAILABLE_REASON_ID}
						className="text-sm text-muted-foreground"
					>
						{t(UNAVAILABLE_KEYS[unavailable])}
						{/* Switching browsers is advice for a browser only. */}
						{unavailable === "unsupported-browser" && desktopPlatform() === undefined
							? ` ${t("assistantUnavailableUnsupportedBrowserAdvice")}`
							: null}
					</p>
					{/* Free space can change: every click checks the storage again, so only the device's own limits disable it. */}
					<Button
						ref={keepAssistantFocus}
						disabled={unavailable !== "insufficient-storage"}
						aria-describedby={UNAVAILABLE_REASON_ID}
						onClick={downloadAssistantModel}
					>
						{t("assistantDownload")}
					</Button>
				</>
			) : (
				<>
					<p className="text-xs text-muted-foreground">{t("assistantSetupStorageNote")}</p>
					<Button
						ref={keepAssistantFocus}
						data-assistant-autofocus=""
						onClick={downloadAssistantModel}
					>
						{t("assistantDownload")}
					</Button>
				</>
			)}
		</>
	)
}

// After the commit, once the next screen is in the DOM: the panel holds focus for want of a control, so the
// screen that replaced the old one hands it to its own (the composer, the download button).
function focusNextScreen(panel: HTMLElement): void {
	queueMicrotask(() => {
		if (document.activeElement === panel) {
			assistantInitialFocusTarget(panel)?.focus()
		}
	})
}

// Leaving the check: the panel held focus since it opened, there being no control to give it to.
function checkingSpinner(element: Element | null): (() => void) | undefined {
	if (element === null) {
		return undefined
	}

	return () => {
		const panel = document.getElementById(ASSISTANT_PANEL_ID)

		if (panel !== null) {
			focusNextScreen(panel)
		}
	}
}

// A ref for a button the next model state replaces while it holds focus (Download, Cancel, Try again): focus
// would drop to the page, so it passes through the panel to the next screen's control. React runs the
// cleanup while the element is still in the document.
function keepAssistantFocus(element: HTMLElement | null): (() => void) | undefined {
	if (element === null) {
		return undefined
	}

	return () => {
		const panel = document.getElementById(ASSISTANT_PANEL_ID)

		if (panel === null || document.activeElement !== element) {
			return
		}

		panel.focus()
		focusNextScreen(panel)
	}
}

function SetupBody({ state }: { state: AssistantSetupState }) {
	const { t } = useTranslation("assistant")

	switch (state.kind) {
		case "checking":
			return (
				<Spinner
					ref={checkingSpinner}
					aria-label={t("assistantChecking")}
					className="size-5 text-muted-foreground"
				/>
			)
		case "unavailable":
			// Another tab holds the model: nothing to do here, the runtime re-emits the real state once it frees.
			if (state.reason === "in-use-elsewhere") {
				return (
					<>
						<h3 className="text-base font-semibold">{t("assistantInUseElsewhereTitle")}</h3>
						<p className="text-sm text-muted-foreground">{t("assistantInUseElsewhereBody")}</p>
					</>
				)
			}

			return (
				<FirstRun
					model={state.model}
					unavailable={state.reason}
				/>
			)
		case "not-downloaded":
			return (
				<FirstRun
					model={state.model}
					unavailable={null}
				/>
			)
		case "downloading":
			return (
				<>
					<h3 className="text-base font-semibold">{t("assistantDownloadingTitle")}</h3>
					<Progress
						value={downloadPercent(state.receivedBytes, state.model.sizeBytes)}
						aria-label={t("assistantDownloadProgressLabel")}
						className="w-full max-w-72"
					/>
					<p className="text-xs text-muted-foreground tabular-nums">
						{state.receivedBytes >= state.model.sizeBytes
							? t("assistantDownloadFinishing")
							: state.waiting
								? t("assistantDownloadWaiting")
								: t("assistantDownloadProgress", downloadByteFigures(state.receivedBytes, state.model.sizeBytes))}
					</p>
					{state.resumed ? <p className="text-xs text-muted-foreground">{t("assistantDownloadResumed")}</p> : null}
					<Button
						ref={keepAssistantFocus}
						variant="outline"
						data-assistant-autofocus=""
						onClick={cancelAssistantDownload}
					>
						{t("assistantCancelDownload")}
					</Button>
				</>
			)
		case "error":
			return (
				<>
					<h3 className="text-base font-semibold">{t("assistantErrorTitle")}</h3>
					<p className="text-sm text-muted-foreground">{t(ERROR_KEYS[state.error])}</p>
					<Button
						ref={keepAssistantFocus}
						data-assistant-autofocus=""
						onClick={downloadAssistantModel}
					>
						{t("assistantRetry")}
					</Button>
				</>
			)
	}
}

// Everything before the model is on disk: the first-run opt-in, the download, failure, and the model being
// busy in another tab.
export function AssistantSetup({ state }: { state: AssistantSetupState }) {
	return (
		<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-y-auto px-6 py-8 text-center">
			<div
				aria-hidden="true"
				className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground"
			>
				<SparklesIcon className="size-6" />
			</div>
			<SetupBody state={state} />
		</div>
	)
}
