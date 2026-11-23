import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { SparklesIcon, TriangleAlertIcon } from "lucide-react"
import { plainTextBody, type SlideRef } from "@filen/office/core/presentation"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { modelAcceptsMessages } from "@/features/assistant/store/assistantSession"
import { draftAssistantNotes } from "@/features/assistant/store/assistantTransform"
import { useAssistantStore } from "@/features/assistant/store/useAssistantStore"
import type { AssistantNotesOutcome } from "@/features/assistant/types"
import { useTransformOffered } from "@/features/assistant/store/useAssistantOnDevice"
import { ModelNotReady } from "@/features/assistant/transform/transformPopover"
import type { PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"

// Speaker notes drafted from the slide's text, for a slide without notes: the draft streams greyed in the notes pane,
// then Accept writes it as the slide's notes (one step: one undo takes the notes away again), Try again or Discard.
// Accept is off for a draft with a link, an address or a number the slide does not hold, and for one cut short.

// The slide text the draft is asked from at most (the prompt cuts it to its token budget).
const SLIDE_TEXT_MAX_CHARS = 4000

// The empty notes' offer to draft them; only where the model can run.
export function NotesDraftButton({ onDraft }: { onDraft: () => void }) {
	const { t } = useTranslation("assistant")
	const offered = useTransformOffered()

	if (!offered) return null

	return (
		<Button
			size="sm"
			variant="outline"
			className="shrink-0"
			// The notes around it start editing on a click or a key: the button's are its own.
			onClick={event => {
				event.stopPropagation()
				onDraft()
			}}
			onKeyDown={event => {
				event.stopPropagation()
			}}
		>
			<SparklesIcon aria-hidden="true" />
			{t("assistantNotesDraft")}
		</Button>
	)
}

type Settled = { readonly attempt: number } & (AssistantNotesOutcome | { readonly ok: false; readonly error: "no-text" | "empty" })

export function NotesDraft({
	editor,
	slide,
	index,
	notesEmpty,
	onClose
}: {
	editor: PresentationRibbonEditor
	slide: SlideRef
	// The slide's place in the deck (0-based).
	index: number
	// The slide still has no notes (Accept writes them only then).
	notesEmpty: boolean
	onClose: () => void
}) {
	const { t } = useTranslation("assistant")
	const modelState = useAssistantStore(state => state.modelState)
	const startable = modelAcceptsMessages(modelState)
	const [attempt, setAttempt] = useState(0)
	const [streamed, setStreamed] = useState<{ readonly attempt: number; readonly text: string; readonly progress: number | null } | null>(
		null
	)
	const [settled, setSettled] = useState<Settled | null>(null)
	const [refused, setRefused] = useState(false)
	const [applying, setApplying] = useState(false)
	const acceptRef = useRef<HTMLButtonElement | null>(null)
	const result = settled?.attempt === attempt ? settled : null
	const live = streamed?.attempt === attempt ? streamed : null
	const session = editor.session

	useEffect(() => {
		if (!startable) {
			return
		}

		const controller = new AbortController()
		// Read after each await: Discard, Try again or the pane going away stop it.
		const stopped = () => controller.signal.aborted

		void (async () => {
			const read = await session.text(index, index, SLIDE_TEXT_MAX_CHARS).catch(() => null)
			const slideText = read?.slides[0]?.text.trim() ?? ""

			if (stopped()) {
				return
			}

			if (slideText.length === 0) {
				setSettled({ attempt, ok: false, error: "no-text" })

				return
			}

			const outcome = await draftAssistantNotes({
				slideText,
				signal: controller.signal,
				onText: text => {
					setStreamed({ attempt, text, progress: null })
				},
				onProgress: share => {
					setStreamed(previous =>
						previous?.attempt === attempt && previous.text.length > 0 ? previous : { attempt, text: "", progress: share }
					)
				}
			})

			if (!stopped()) {
				setSettled(
					outcome.ok && outcome.text.trim().length === 0 ? { attempt, ok: false, error: "empty" } : { attempt, ...outcome }
				)
			}
		})()

		return () => {
			controller.abort()
		}
	}, [startable, attempt, session, index])

	const done = result?.ok === true ? result : null
	const blockedBy =
		done === null
			? null
			: !notesEmpty
				? "changed"
				: done.foreignLinks.length > 0 || done.foreignNumbers.length > 0
					? "foreign"
					: done.truncated
						? "truncated"
						: null
	const canAccept = done !== null && blockedBy === null && !applying && !refused
	const writing = startable && result === null
	const shown = done?.text ?? live?.text ?? ""
	const failure = result?.ok === false && result.error !== "cancelled" && result.error !== "model-unavailable" ? result.error : null

	useEffect(() => {
		if (canAccept) {
			acceptRef.current?.focus({ preventScroll: true })
		}
	}, [canAccept])

	async function accept(): Promise<void> {
		if (done === null || !canAccept) {
			return
		}

		setApplying(true)

		const applied = await editor.command({ family: "notes", kind: "setNotes", slide, body: plainTextBody(done.text.trim()) })

		setApplying(false)

		if (applied.ok) {
			onClose()
		} else {
			setRefused(true)
		}
	}

	return (
		<div
			data-assistant-notes-draft
			aria-label={t("assistantNotesDraftLabel")}
			role="group"
			className="flex size-full scrollbar-gutter-stable flex-col gap-2 overflow-auto p-2 text-sm"
			onKeyDown={event => {
				if (event.key === "Escape") {
					event.preventDefault()
					event.stopPropagation()
					onClose()
				}
			}}
		>
			{!startable ? (
				<ModelNotReady
					state={modelState}
					notDownloaded="assistantNotesDraftNotDownloaded"
				/>
			) : writing && shown.length === 0 ? (
				<div
					role="status"
					className="flex items-center gap-2 text-muted-foreground"
				>
					<Spinner className="size-4" />
					<span>{modelState.kind === "ready" ? t("assistantNotesDraftReading") : t("assistantTransformLoading")}</span>
					{live?.progress === null || live === null || modelState.kind !== "ready" ? null : (
						<Progress
							value={Math.round(live.progress * 100)}
							aria-label={t("assistantNotesDraftReading")}
							className="flex-1"
						/>
					)}
				</div>
			) : (
				<p
					className="break-words whitespace-pre-wrap text-muted-foreground italic"
					aria-busy={writing}
				>
					{shown}
				</p>
			)}
			{failure === null ? null : (
				<p className="text-destructive">
					{t(
						failure === "no-text"
							? "assistantNotesDraftNoText"
							: failure === "empty"
								? "assistantTransformEmpty"
								: "assistantTransformFailed"
					)}
				</p>
			)}
			{blockedBy === null && !refused ? null : (
				<p
					role="alert"
					className="flex gap-2 text-warning-foreground"
				>
					<TriangleAlertIcon
						aria-hidden="true"
						className="mt-0.5 size-4 shrink-0"
					/>
					<span>
						{refused
							? t("assistantTransformRefused")
							: blockedBy === "changed"
								? t("assistantNotesDraftChanged")
								: blockedBy === "truncated"
									? t("assistantNotesDraftTruncated")
									: t("assistantNotesDraftForeign", {
											items: [...(done?.foreignLinks ?? []), ...(done?.foreignNumbers ?? [])].join(", ")
										})}
					</span>
				</p>
			)}
			<div className="flex flex-wrap items-center justify-end gap-2">
				<Button
					size="sm"
					variant="ghost"
					onClick={onClose}
				>
					{t("assistantTransformDiscard")}
				</Button>
				{startable ? (
					<Button
						size="sm"
						variant="outline"
						disabled={writing || applying}
						onClick={() => {
							setRefused(false)
							setAttempt(previous => previous + 1)
						}}
					>
						{t("assistantTransformTryAgain")}
					</Button>
				) : null}
				{startable ? (
					<Button
						ref={acceptRef}
						size="sm"
						disabled={!canAccept}
						onClick={() => void accept()}
					>
						{t("assistantTransformAccept")}
						<kbd
							aria-hidden="true"
							className="text-xs opacity-70"
						>
							⏎
						</kbd>
					</Button>
				) : null}
			</div>
		</div>
	)
}
