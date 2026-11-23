import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { SparklesIcon, TriangleAlertIcon } from "lucide-react"
import { formatBytes, cn } from "@filen/shared"
import { transformFits, type TransformKind, type TransformLanguage } from "@filen/shared/assistant"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent } from "@/components/ui/popover"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import type { AssistantKey } from "@/lib/i18n"
import { downloadByteFigures, downloadPercent } from "@/features/assistant/components/assistant.logic"
import { downloadAssistantModel, modelAcceptsMessages } from "@/features/assistant/store/assistantSession"
import { transformAssistantText } from "@/features/assistant/store/assistantTransform"
import { useAssistantStore } from "@/features/assistant/store/useAssistantStore"
import type { AssistantModelState, AssistantTransformError } from "@/features/assistant/types"
import type { TransformSelection } from "@/features/assistant/transform/host"
import { diffSegments } from "@/features/assistant/transform/transform.logic"
import { TRANSFORM_KIND_LABELS, useTransformLanguageName } from "@/features/assistant/transform/transformMenuParts"

// The result of a selection transform, under the selection: streamed as it is written, the result or its changes
// against the selection, then Accept (the editor's own undo takes it back), Try again or Discard. Accept is off while
// it would not land where it was asked for (the text changed meanwhile) or would bring in something the selection did
// not hold (a link or address: F2), and for a result cut short. A model that is not ready is explained here, with
// the one action that fits.

export interface TransformRequest {
	selection: TransformSelection
	kind: TransformKind
	language: TransformLanguage
}

type Failure = AssistantTransformError | "empty" | "refused"

type Settled =
	| { attempt: number; ok: true; text: string; truncated: boolean; foreignLinks: readonly string[] }
	| { attempt: number; ok: false; error: Failure }

const FAILURE_KEYS: Readonly<Record<Exclude<Failure, "cancelled" | "model-unavailable">, AssistantKey>> = {
	"too-long": "assistantTransformTooLong",
	failed: "assistantTransformFailed",
	empty: "assistantTransformEmpty",
	refused: "assistantTransformRefused"
}

// A model that is not ready, explained with the one action that fits (also the formula helper's). `notDownloaded`
// says what the model would do here.
export function ModelNotReady({ state, notDownloaded }: { state: AssistantModelState; notDownloaded?: AssistantKey }) {
	const { t } = useTranslation("assistant")

	switch (state.kind) {
		case "not-downloaded":
			return (
				<div className="flex flex-col gap-3">
					<p className="text-muted-foreground">{t(notDownloaded ?? "assistantTransformNotDownloaded")}</p>
					<Button
						size="sm"
						className="self-start"
						onClick={downloadAssistantModel}
					>
						{t("assistantTransformDownload", { size: formatBytes(state.model.sizeBytes) })}
					</Button>
				</div>
			)
		case "downloading":
			return (
				<Progress
					value={downloadPercent(state.receivedBytes, state.model.sizeBytes)}
					aria-label={t("assistantDownloadProgressLabel")}
					className="flex-col gap-1.5"
				>
					<span className="text-muted-foreground tabular-nums">
						{state.waiting
							? t("assistantDownloadWaiting")
							: t("assistantDownloadProgress", downloadByteFigures(state.receivedBytes, state.model.sizeBytes))}
					</span>
				</Progress>
			)
		case "error":
			return (
				<div className="flex flex-col gap-3">
					<p className="text-muted-foreground">{t("assistantTransformModelFailed")}</p>
					<Button
						size="sm"
						variant="outline"
						className="self-start"
						onClick={downloadAssistantModel}
					>
						{t("assistantTransformTryAgain")}
					</Button>
				</div>
			)
		case "unavailable":
			return (
				<p className="text-muted-foreground">
					{state.reason === "in-use-elsewhere" ? t("assistantTransformInUseElsewhere") : t("assistantTransformUnavailable")}
				</p>
			)
		default:
			return <p className="text-muted-foreground">{t("assistantTransformUnavailable")}</p>
	}
}

export function TransformPopover({
	request,
	anchor,
	onClose
}: {
	request: TransformRequest
	// Where to show it when the selection cannot say (an editor's box).
	anchor: () => DOMRect | null
	// `applied`: the result replaced the selection (focus is in the editor already).
	onClose: (applied: boolean) => void
}) {
	const { t } = useTranslation("assistant")
	const languageName = useTransformLanguageName()
	const { selection, kind, language } = request
	const modelState = useAssistantStore(state => state.modelState)
	// A model on disk is loaded by the request itself.
	const startable = modelAcceptsMessages(modelState)
	const tooLong = !transformFits(kind, selection.text)
	const [attempt, setAttempt] = useState(0)
	const [settled, setSettled] = useState<Settled | null>(null)
	const [streamed, setStreamed] = useState<{ attempt: number; text: string; progress: number | null } | null>(null)
	const [changed, setChanged] = useState(false)
	const [showChanges, setShowChanges] = useState(false)
	const acceptRef = useRef<HTMLButtonElement | null>(null)
	const result = settled?.attempt === attempt ? settled : null
	const live = streamed?.attempt === attempt ? streamed : null

	useEffect(() => {
		if (!startable || tooLong) {
			return
		}

		const controller = new AbortController()

		void transformAssistantText({
			kind,
			text: selection.text,
			language,
			signal: controller.signal,
			onText: text => {
				setStreamed({ attempt, text, progress: null })
			},
			onProgress: share => {
				setStreamed(previous =>
					previous?.attempt === attempt && previous.text.length > 0 ? previous : { attempt, text: "", progress: share }
				)
			}
		}).then(outcome => {
			if (controller.signal.aborted) {
				return
			}

			setSettled(
				outcome.ok
					? outcome.text.trim().length === 0
						? { attempt, ok: false, error: "empty" }
						: { attempt, ...outcome }
					: { attempt, ok: false, error: outcome.error }
			)
		})

		return () => {
			controller.abort()
		}
	}, [startable, tooLong, attempt, kind, language, selection])

	// An edit of the text meanwhile is stated as it happens (Accept checks again on its own).
	useEffect(() => {
		let frame = 0
		const check = () => {
			cancelAnimationFrame(frame)
			frame = requestAnimationFrame(() => {
				if (!selection.current()) {
					setChanged(true)
				}
			})
		}

		document.addEventListener("input", check, true)

		return () => {
			cancelAnimationFrame(frame)
			document.removeEventListener("input", check, true)
		}
	}, [selection])

	const done = result?.ok === true ? result : null
	const blockedBy =
		done === null ? null : changed ? "changed" : done.foreignLinks.length > 0 ? "links" : done.truncated ? "truncated" : null
	const canAccept = done !== null && blockedBy === null
	const shown = done?.text ?? live?.text ?? ""
	const title =
		kind === "translate" ? t("assistantTransformTranslateTo", { language: languageName(language) }) : t(TRANSFORM_KIND_LABELS[kind])

	// Focus on Accept once it can run, so Enter applies the result.
	useEffect(() => {
		if (canAccept) {
			acceptRef.current?.focus()
		}
	}, [canAccept])

	function accept(): void {
		if (done === null || blockedBy !== null) {
			return
		}

		if (!selection.current()) {
			setChanged(true)

			return
		}

		const applied = selection.replace(done.text)

		if (applied === null) {
			setSettled({ attempt, ok: false, error: "refused" })

			return
		}

		const undo = applied.undo

		if (undo !== null) {
			toast(t("assistantTransformApplied"), { action: { label: t("assistantTransformUndo"), onClick: () => void undo() } })
		}

		onClose(true)
	}

	const failure = result?.ok === false && result.error !== "cancelled" && result.error !== "model-unavailable" ? result.error : null
	const waitingOnModel = !tooLong && !startable && result === null
	const writing = !tooLong && startable && result === null

	return (
		<Popover
			open
			onOpenChange={open => {
				if (!open) {
					onClose(false)
				}
			}}
		>
			<PopoverContent
				anchor={{ getBoundingClientRect: () => selection.rect() ?? anchor() ?? new DOMRect() }}
				align="start"
				aria-label={t("assistantTransformResultLabel")}
				data-assistant-transform
				className="w-96 max-w-[calc(100vw-2rem)] gap-3 rounded-2xl p-3"
				initialFocus={false}
			>
				<div className="flex items-center gap-2">
					<SparklesIcon
						aria-hidden="true"
						className="size-4 text-muted-foreground"
					/>
					<span className="min-w-0 flex-1 truncate font-medium">{title}</span>
					{done === null || selection.text === done.text ? null : (
						<label className="flex items-center gap-1.5 text-xs text-muted-foreground">
							{t("assistantTransformChanges")}
							<Switch
								checked={showChanges}
								onCheckedChange={setShowChanges}
							/>
						</label>
					)}
				</div>
				{tooLong ? (
					<p className="text-muted-foreground">{t("assistantTransformTooLong")}</p>
				) : waitingOnModel ? (
					<ModelNotReady state={modelState} />
				) : writing && shown.length === 0 ? (
					<div
						role="status"
						className="flex items-center gap-2 text-muted-foreground"
					>
						<Spinner className="size-4" />
						<span>{modelState.kind === "ready" ? t("assistantTransformReading") : t("assistantTransformLoading")}</span>
						{live?.progress === null || live === null || modelState.kind !== "ready" ? null : (
							<Progress
								value={Math.round(live.progress * 100)}
								aria-label={t("assistantTransformReading")}
								className="flex-1"
							/>
						)}
					</div>
				) : (
					<div
						className="max-h-64 scrollbar-gutter-stable overflow-auto rounded-lg bg-muted/50 px-2.5 py-2 break-words whitespace-pre-wrap"
						aria-busy={writing}
					>
						{showChanges && done !== null
							? diffSegments(selection.text, done.text).map((segment, index) => (
									<span
										// Segments never reorder: their position is their identity.
										key={index}
										className={cn(
											segment.kind === "added" && "rounded-sm bg-green-500/20",
											segment.kind === "removed" && "rounded-sm bg-destructive/15 text-muted-foreground line-through"
										)}
									>
										{segment.text}
									</span>
								))
							: shown}
						{writing ? <span className="sr-only">{t("assistantTransformWriting")}</span> : null}
					</div>
				)}
				{failure !== null ? <p className="text-destructive">{t(FAILURE_KEYS[failure])}</p> : null}
				{blockedBy === null ? null : (
					<p
						role="alert"
						className="flex gap-2 text-sm text-warning-foreground"
					>
						<TriangleAlertIcon
							aria-hidden="true"
							className="mt-0.5 size-4 shrink-0"
						/>
						<span>
							{blockedBy === "changed"
								? t("assistantTransformSelectionChanged")
								: blockedBy === "truncated"
									? t("assistantTransformTruncated")
									: t("assistantTransformForeignLinks", { links: done?.foreignLinks.join(", ") ?? "" })}
						</span>
					</p>
				)}
				<div className="flex flex-wrap items-center justify-end gap-2">
					<Button
						size="sm"
						variant="ghost"
						onClick={() => {
							onClose(false)
						}}
					>
						{t("assistantTransformDiscard")}
					</Button>
					{tooLong || waitingOnModel ? null : (
						<Button
							size="sm"
							variant="outline"
							disabled={writing}
							onClick={() => {
								setShowChanges(false)
								setAttempt(previous => previous + 1)
							}}
						>
							{t("assistantTransformTryAgain")}
						</Button>
					)}
					{tooLong || waitingOnModel ? null : (
						<Button
							ref={acceptRef}
							size="sm"
							disabled={!canAccept}
							onClick={accept}
						>
							{t("assistantTransformAccept")}
							<kbd
								aria-hidden="true"
								className="text-xs opacity-70"
							>
								⏎
							</kbd>
						</Button>
					)}
				</div>
			</PopoverContent>
		</Popover>
	)
}
