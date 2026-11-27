import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { SparklesIcon } from "lucide-react"
import { cellName } from "@filen/office/core/sheet"
import type { SheetGridState } from "@filen/office/react/sheet"
import { FORMULA_ASK_MAX_CHARS } from "@filen/shared/assistant"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { modelAcceptsMessages } from "@/features/assistant/store/assistantSession"
import { writeAssistantFormula } from "@/features/assistant/store/assistantTransform"
import { useAssistantStore } from "@/features/assistant/store/useAssistantStore"
import { useTransformOffered } from "@/features/assistant/store/useAssistantOnDevice"
import { ModelNotReady } from "@/features/assistant/transform/transformPopover"
import type { AssistantFormulaValue } from "@/features/assistant/types"
import { useRegionalLanguage } from "@/features/office/lib/regionalFormat"
import {
	formulaChecker,
	formulaRequestContext,
	localizedEntry,
	type FormulaTarget
} from "@/features/spreadsheet/formulaBar/assistantFormula"
import { sheetLocaleOf } from "@/features/spreadsheet/formulaBar/sheetLocale"

// The formula bar's ✨: a one-line ask, the assistant's formula written for it (en-US, checked, then calculated by the
// sheet's engine without writing a cell), shown with the engine's result for the active cell. Insert puts it into the
// entry, in the regional format's syntax, for the user to confirm with Enter (an ordinary, undoable cell edit). The
// model never states the value.

// What a text result shows at most.
const SHOWN_TEXT = 200

type Phase =
	| { kind: "ask" }
	| { kind: "writing"; progress: number | null }
	| { kind: "done"; formula: string; value: AssistantFormulaValue; target: FormulaTarget }
	| { kind: "invalid" }
	| { kind: "failed" }

function shownValue(value: AssistantFormulaValue["value"], language: string): string | null {
	if (value === null || value === "") return null
	if (typeof value === "number") return new Intl.NumberFormat(language, { maximumFractionDigits: 10 }).format(value)
	if (typeof value === "boolean") return value ? "TRUE" : "FALSE"

	return value.length > SHOWN_TEXT ? `${value.slice(0, SHOWN_TEXT)}…` : value
}

export function FormulaHelper({ grid }: { grid: SheetGridState }) {
	const { t } = useTranslation("assistant")
	const language = useRegionalLanguage()
	const locale = sheetLocaleOf(language)
	const modelState = useAssistantStore(state => state.modelState)
	const offered = useTransformOffered()
	const [open, setOpen] = useState(false)
	const [ask, setAsk] = useState("")
	const [phase, setPhase] = useState<Phase>({ kind: "ask" })
	const running = useRef<AbortController | null>(null)
	const { model } = grid

	// Leaving the sheet stops a formula being written.
	useEffect(
		() => () => {
			running.current?.abort()
		},
		[]
	)

	if (!offered) {
		return null
	}

	function stop(): void {
		running.current?.abort()
		running.current = null
	}

	async function write(): Promise<void> {
		const wanted = ask.trim()

		if (wanted.length === 0) return

		stop()

		const controller = new AbortController()

		running.current = controller
		setPhase({ kind: "writing", progress: null })

		const gathered = await formulaRequestContext(model, wanted, locale).catch(() => null)

		// Stopped (closed, or asked again) meanwhile.
		if (running.current !== controller) return

		if (gathered === null) {
			setPhase({ kind: "failed" })

			return
		}

		const outcome = await writeAssistantFormula({
			context: gathered.context,
			check: formulaChecker(model, gathered.target),
			signal: controller.signal,
			onProgress: share => {
				setPhase(previous => (previous.kind === "writing" ? { kind: "writing", progress: share } : previous))
			}
		})

		// Stopped (closed, or asked again) meanwhile.
		if (running.current !== controller) return

		running.current = null

		if (outcome.ok) {
			setPhase({ kind: "done", formula: outcome.formula, value: outcome.value, target: gathered.target })
		} else {
			setPhase(
				outcome.error === "invalid"
					? { kind: "invalid" }
					: outcome.error === "failed"
						? { kind: "failed" }
						: // The model state says why (ModelNotReady), or it was stopped.
							{ kind: "ask" }
			)
		}
	}

	const done = phase.kind === "done" ? phase : null
	const targetCell = done === null ? "" : cellName(done.target.row, done.target.col)
	const moved =
		done !== null &&
		(grid.sheet !== done.target.sheet || grid.selection.active.row !== done.target.row || grid.selection.active.col !== done.target.col)
	const startable = modelAcceptsMessages(modelState)

	function insert(): void {
		if (done === null || moved) return

		setOpen(false)
		stop()
		setPhase({ kind: "ask" })
		model.startEditing(localizedEntry(done.formula, locale), "edit")
	}

	const value = done === null ? "" : (shownValue(done.value.value, language) ?? t("assistantFormulaEmpty"))
	const result =
		done === null
			? ""
			: t("assistantFormulaResult", {
					cell: targetCell,
					value:
						done.value.rows * done.value.cols > 1
							? t("assistantFormulaSpills", { value, rows: done.value.rows, cols: done.value.cols })
							: value
				})

	return (
		<Popover
			open={open}
			onOpenChange={next => {
				setOpen(next)

				if (!next) {
					stop()
					setPhase({ kind: "ask" })
				}
			}}
		>
			<Tooltip>
				<TooltipTrigger
					render={
						<PopoverTrigger
							render={
								<Button
									variant="ghost"
									size="icon-xs"
									className="shrink-0"
									aria-label={t("assistantFormulaOpen")}
									data-sheet-formula-helper=""
								>
									<SparklesIcon
										aria-hidden="true"
										className="size-3.5"
									/>
								</Button>
							}
						/>
					}
				/>
				<TooltipContent>{t("assistantFormulaOpen")}</TooltipContent>
			</Tooltip>
			<PopoverContent
				align="start"
				aria-label={t("assistantFormulaLabel")}
				data-assistant-formula=""
				className="w-96 max-w-[calc(100vw-2rem)] gap-3 rounded-2xl p-3"
			>
				{!startable ? (
					<ModelNotReady
						state={modelState}
						notDownloaded="assistantFormulaNotDownloaded"
					/>
				) : (
					<form
						className="flex items-center gap-2"
						onSubmit={event => {
							event.preventDefault()
							void write()
						}}
					>
						<Input
							aria-label={t("assistantFormulaAskLabel")}
							placeholder={t("assistantFormulaAskPlaceholder")}
							value={ask}
							maxLength={FORMULA_ASK_MAX_CHARS}
							autoComplete="off"
							className="leading-5"
							onChange={event => {
								setAsk(event.target.value)
							}}
						/>
						<Button
							type="submit"
							size="sm"
							disabled={ask.trim().length === 0 || phase.kind === "writing"}
						>
							{t("assistantFormulaWrite")}
						</Button>
					</form>
				)}
				{phase.kind === "writing" ? (
					<div
						role="status"
						className="flex items-center gap-2 text-muted-foreground"
					>
						<Spinner className="size-4" />
						<span>{modelState.kind === "ready" ? t("assistantFormulaWriting") : t("assistantTransformLoading")}</span>
						{phase.progress === null || modelState.kind !== "ready" ? null : (
							<Progress
								value={Math.round(phase.progress * 100)}
								aria-label={t("assistantFormulaWriting")}
								className="flex-1"
							/>
						)}
					</div>
				) : null}
				{done === null ? null : (
					<div className="flex flex-col gap-1.5 rounded-lg bg-muted/50 px-2.5 py-2">
						<code
							data-assistant-formula-text=""
							className="font-mono text-xs break-all"
						>
							{localizedEntry(done.formula, locale)}
						</code>
						<span
							role="status"
							className="text-muted-foreground"
						>
							{result}
						</span>
					</div>
				)}
				{moved ? <p className="text-sm text-warning-foreground">{t("assistantFormulaCellChanged", { cell: targetCell })}</p> : null}
				{phase.kind === "invalid" || phase.kind === "failed" ? (
					<p
						role="alert"
						className="text-destructive"
					>
						{phase.kind === "invalid" ? t("assistantFormulaInvalid") : t("assistantFormulaFailed")}
					</p>
				) : null}
				{done !== null || phase.kind === "invalid" || phase.kind === "failed" ? (
					<div className="flex flex-wrap items-center justify-end gap-2">
						<Button
							size="sm"
							variant="outline"
							onClick={() => {
								void write()
							}}
						>
							{t("assistantTransformTryAgain")}
						</Button>
						{done === null ? null : (
							<Button
								size="sm"
								disabled={moved}
								onClick={insert}
							>
								{t("assistantFormulaInsert")}
							</Button>
						)}
					</div>
				) : null}
			</PopoverContent>
		</Popover>
	)
}
