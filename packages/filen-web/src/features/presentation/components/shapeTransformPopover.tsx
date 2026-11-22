import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { SparklesIcon, TriangleAlertIcon } from "lucide-react"
import { cn } from "@filen/shared"
import type { TransformKind, TransformLanguage } from "@filen/shared/assistant"
import type { CommandResult } from "@filen/office/dom/presentation"
import type { DeckOp } from "@filen/office/core/presentation"
import type { PresentationSessionApi } from "@filen/office/dom/presentation"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import type { AssistantKey } from "@/lib/i18n"
import { modelAcceptsMessages } from "@/features/assistant/store/assistantSession"
import { transformAssistantText } from "@/features/assistant/store/assistantTransform"
import { useAssistantStore } from "@/features/assistant/store/useAssistantStore"
import type { AssistantTransformOutcome } from "@/features/assistant/types"
import { diffSegments } from "@/features/assistant/transform/transform.logic"
import { TRANSFORM_KIND_LABELS, useTransformLanguageName } from "@/features/assistant/transform/transformMenuParts"
import { ModelNotReady } from "@/features/assistant/transform/transformPopover"
import {
	shapeTransformOp,
	type ShapeTransformItem,
	type ShapeTransformSkip,
	type ShapeTransformTarget
} from "@/features/presentation/lib/shapeTextTransform"

// The selection transform on whole text bodies: one popover with a row per box (its text, then the result as it is
// written, one box after another), the boxes left out listed, a Changes toggle, then Accept all (one batch: one undo
// takes every box back), Try again or Discard. Accept all is off while any box's result would bring in a link or
// address its text did not hold, was cut short or failed, and is refused once any box changed since.

export interface ShapeTransformRequest {
	readonly items: readonly ShapeTransformItem[]
	readonly skipped: readonly ShapeTransformSkip[]
	readonly kind: TransformKind
	readonly language: TransformLanguage
}

interface Row {
	readonly text: string
	readonly outcome?: AssistantTransformOutcome
}

const BODY_KEYS = {
	placeholder: "assistantShapeTransformPlaceholder",
	textBox: "assistantShapeTransformTextBox",
	shape: "assistantShapeTransformShape"
} as const satisfies Readonly<Record<ShapeTransformTarget["body"], AssistantKey>>

const SKIP_KEYS = {
	field: "assistantShapeTransformSkipField",
	"too-long": "assistantShapeTransformSkipTooLong",
	empty: "assistantShapeTransformSkipEmpty",
	unreadable: "assistantShapeTransformSkipUnreadable"
} as const satisfies Readonly<Record<ShapeTransformSkip["reason"], AssistantKey>>

// A box's name in the popover: its kind, numbered in the slide's order among the boxes of the request.
function useBoxName(request: ShapeTransformRequest): (target: ShapeTransformTarget) => string {
	const { t } = useTranslation("assistant")
	const all = [...request.items, ...request.skipped].map(target => target.shape.id).sort((a, b) => a - b)

	return target => t(BODY_KEYS[target.body], { n: all.indexOf(target.shape.id) + 1 })
}

export function ShapeTransformPopover({
	request,
	session,
	command,
	flush,
	anchor,
	onClose
}: {
	request: ShapeTransformRequest
	session: Pick<PresentationSessionApi, "textSeed">
	command: (op: DeckOp) => Promise<CommandResult>
	// Sends the open body's pending text (the deck's text editing).
	flush: () => Promise<void>
	anchor: () => DOMRect
	onClose: () => void
}) {
	const { t } = useTranslation("assistant")
	const languageName = useTransformLanguageName()
	const boxName = useBoxName(request)
	const { items, skipped, kind, language } = request
	const modelState = useAssistantStore(state => state.modelState)
	const startable = modelAcceptsMessages(modelState)
	const [attempt, setAttempt] = useState(0)
	const [run, setRun] = useState<{ readonly attempt: number; readonly rows: readonly Row[] }>({ attempt: 0, rows: [] })
	const [showChanges, setShowChanges] = useState(false)
	const [blocked, setBlocked] = useState<"changed" | "refused" | null>(null)
	const [applying, setApplying] = useState(false)
	const acceptRef = useRef<HTMLButtonElement | null>(null)
	const rows = run.attempt === attempt ? run.rows : []

	// One body after another (the worker runs one generation at a time), each streamed into its row.
	useEffect(() => {
		if (!startable) {
			return
		}

		const controller = new AbortController()
		const update = (index: number, row: Row) => {
			setRun(previous => {
				const next = previous.attempt === attempt ? [...previous.rows] : []

				next[index] = row

				return { attempt, rows: next }
			})
		}

		void (async () => {
			for (const [index, item] of items.entries()) {
				const outcome = await transformAssistantText({
					kind,
					text: item.text,
					language,
					signal: controller.signal,
					onText: text => {
						update(index, { text })
					}
				})

				if (controller.signal.aborted) {
					return
				}

				update(index, { text: outcome.ok ? outcome.text : "", outcome })

				// The model went away: the rows after it would fail the same way.
				if (!outcome.ok && (outcome.error === "cancelled" || outcome.error === "model-unavailable")) {
					return
				}
			}
		})()

		return () => {
			controller.abort()
		}
	}, [startable, attempt, items, kind, language])

	const settled = rows.filter(row => row.outcome !== undefined).length
	const writing =
		startable && settled < items.length && !rows.some(row => row.outcome?.ok === false && row.outcome.error === "model-unavailable")
	const problems = items.flatMap((item, index) => {
		const outcome = rows[index]?.outcome

		if (outcome === undefined) {
			return []
		}

		if (!outcome.ok || outcome.text.trim().length === 0) {
			return [t("assistantShapeTransformRowFailed", { box: boxName(item) })]
		}

		if (outcome.foreignLinks.length > 0) {
			return [t("assistantShapeTransformRowLinks", { box: boxName(item), links: outcome.foreignLinks.join(", ") })]
		}

		return outcome.truncated ? [t("assistantShapeTransformRowTruncated", { box: boxName(item) })] : []
	})
	const done = !writing && settled === items.length
	const canAccept = done && problems.length === 0 && blocked === null && !applying
	const title =
		kind === "translate" ? t("assistantTransformTranslateTo", { language: languageName(language) }) : t(TRANSFORM_KIND_LABELS[kind])

	useEffect(() => {
		if (canAccept) {
			acceptRef.current?.focus()
		}
	}, [canAccept])

	async function accept(): Promise<void> {
		if (!canAccept) {
			return
		}

		setApplying(true)
		// A body open in the text editor sends what was typed into it first, so the check below reads it.
		await flush()

		const op = await shapeTransformOp(
			session,
			items.map((item, index) => ({ item, text: rows[index]?.text ?? "" }))
		)

		if (op === "changed") {
			setApplying(false)
			setBlocked("changed")

			return
		}

		const result = await command(op)

		setApplying(false)

		if (result.ok) {
			onClose()
		} else {
			setBlocked("refused")
		}
	}

	return (
		<Popover
			open
			onOpenChange={open => {
				if (!open) {
					onClose()
				}
			}}
		>
			<PopoverContent
				anchor={{ getBoundingClientRect: anchor }}
				align="start"
				aria-label={t("assistantTransformResultLabel")}
				data-assistant-transform
				data-preview-surface
				className="w-[28rem] max-w-[calc(100vw-2rem)] gap-3 rounded-2xl p-3"
				initialFocus={false}
			>
				<div className="flex items-center gap-2">
					<SparklesIcon
						aria-hidden="true"
						className="size-4 text-muted-foreground"
					/>
					<span className="min-w-0 flex-1 truncate font-medium">
						{title}
						{items.length > 1 ? (
							<span className="text-muted-foreground">
								{" "}
								· {t("assistantShapeTransformProgress", { done: settled, total: items.length })}
							</span>
						) : null}
					</span>
					{done ? (
						<label className="flex items-center gap-1.5 text-xs text-muted-foreground">
							{t("assistantTransformChanges")}
							<Switch
								checked={showChanges}
								onCheckedChange={setShowChanges}
							/>
						</label>
					) : null}
				</div>
				{!startable ? (
					<ModelNotReady state={modelState} />
				) : (
					<ul className="flex max-h-72 flex-col gap-2 overflow-auto">
						{items.map((item, index) => {
							const row = rows[index]
							const after = row?.text ?? ""

							return (
								<li
									key={item.shape.id}
									className="flex flex-col gap-1 rounded-lg bg-muted/50 px-2.5 py-2"
								>
									<span className="text-xs font-medium text-muted-foreground">{boxName(item)}</span>
									<span className="line-clamp-3 break-words whitespace-pre-wrap text-muted-foreground">{item.text}</span>
									<div
										className="break-words whitespace-pre-wrap"
										aria-busy={row?.outcome === undefined}
									>
										{showChanges && row?.outcome !== undefined
											? diffSegments(item.text, after).map((segment, at) => (
													<span
														// Segments never reorder: their position is their identity.
														key={at}
														className={cn(
															segment.kind === "added" && "rounded-sm bg-green-500/20",
															segment.kind === "removed" &&
																"rounded-sm bg-destructive/15 text-muted-foreground line-through"
														)}
													>
														{segment.text}
													</span>
												))
											: after}
										{row === undefined && writing ? (
											<Spinner
												className="size-3.5 text-muted-foreground"
												aria-label={t("assistantTransformWriting")}
											/>
										) : null}
									</div>
								</li>
							)
						})}
					</ul>
				)}
				{skipped.length === 0 ? null : (
					<p className="text-sm text-muted-foreground">
						{t("assistantShapeTransformSkipped", {
							boxes: skipped.map(skip => t(SKIP_KEYS[skip.reason], { box: boxName(skip) })).join(", ")
						})}
					</p>
				)}
				{[
					...problems,
					...(blocked === null ? [] : [t(blocked === "changed" ? "assistantShapeTransformChanged" : "assistantTransformRefused")])
				].map(problem => (
					<p
						key={problem}
						role="alert"
						className="flex gap-2 text-sm text-warning-foreground"
					>
						<TriangleAlertIcon
							aria-hidden="true"
							className="mt-0.5 size-4 shrink-0"
						/>
						<span>{problem}</span>
					</p>
				))}
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
								setShowChanges(false)
								setBlocked(null)
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
							{writing ? <Spinner className="size-3.5" /> : null}
							{t("assistantShapeTransformAcceptAll")}
							<kbd
								aria-hidden="true"
								className="text-xs opacity-70"
							>
								⏎
							</kbd>
						</Button>
					) : null}
				</div>
			</PopoverContent>
		</Popover>
	)
}
