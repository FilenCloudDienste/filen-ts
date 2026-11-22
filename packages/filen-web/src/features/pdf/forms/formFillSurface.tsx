import { useEffect, useId, useState, useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { SparklesIcon, TriangleAlertIcon } from "lucide-react"
import type { FormFillDropReason, FormFillEntry, FormFillResult } from "@filen/shared/assistant"
import type { PdfViewport } from "@filen/office/dom/pdf"
import { pdfBox } from "@filen/office/dom/pdf"
import { isMupdfDocument } from "@filen/office/react/pdfedit"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import type { PreviewKey } from "@/lib/i18n"
import { modelAcceptsMessages } from "@/features/assistant/store/assistantSession"
import { fillAssistantForm } from "@/features/assistant/store/assistantTransform"
import { useAssistantStore } from "@/features/assistant/store/useAssistantStore"
import { ModelNotReady } from "@/features/assistant/transform/transformPopover"
import {
	applyFormFill,
	formFillPage,
	formFillPreview,
	pageBox,
	textRuns,
	viewportBox,
	type FormFillLeftOut,
	type FormFillPage
} from "@/features/pdf/forms/formFill.logic"
import { engineFields, formOverlaySession, pdfjsFields } from "@/features/pdf/session/fieldOverlay.logic"
import { PdfSidePanel } from "@/features/pdf/tools/pdfSidePanel"
import { withPdfSession, type PdfToolOverlayProps, type PdfToolPanelProps } from "@/features/pdf/tools/registry"

// The assistant's form fill, in the preview's side slot while its tool is active: the page in view's empty text fields
// and choices, the user's details typed or pasted (kept in this panel only: never stored or logged), the assistant's
// matches as a checklist (each value one the user wrote: formFillPlan), shown ghosted in the page's fields meanwhile,
// and Fill N fields as one undo step.

const NO_PAGES = { subscribe: () => () => undefined, current: () => 0 }

const DROP_REASONS: Readonly<Record<FormFillDropReason, PreviewKey>> = {
	unknown: "previewPdfFormFillReasonUngrounded",
	duplicate: "previewPdfFormFillReasonUngrounded",
	ungrounded: "previewPdfFormFillReasonUngrounded",
	empty: "previewPdfFormFillReasonUnanswered",
	multiline: "previewPdfFormFillReasonTooLong",
	"too-long": "previewPdfFormFillReasonTooLong",
	"not-an-option": "previewPdfFormFillReasonNotAnOption"
}

const LEFT_REASONS: Readonly<Record<FormFillLeftOut["reason"], PreviewKey>> = {
	tick: "previewPdfFormFillReasonTick",
	limit: "previewPdfFormFillReasonLimit",
	unlabeled: "previewPdfFormFillReasonUnlabeled"
}

type Phase =
	| { readonly kind: "details" }
	| { readonly kind: "matching" }
	| { readonly kind: "review"; readonly result: FormFillResult; readonly unchecked: ReadonlySet<number> }
	| { readonly kind: "applying"; readonly result: FormFillResult; readonly unchecked: ReadonlySet<number> }

type Problem = "too-long" | "failed" | "nothing" | "refused" | { readonly changed: readonly string[] }

export function FormFillPanel({ context, document }: PdfToolPanelProps) {
	const { t } = useTranslation("preview")
	const detailsId = useId()
	const hintId = useId()
	const pages = context.pages
	const page = useSyncExternalStore(pages?.subscribe ?? NO_PAGES.subscribe, () => pages?.getSnapshot().current ?? NO_PAGES.current())
	const form = formOverlaySession(context.swap)
	const preview = formFillPreview(context.swap)
	const engine = isMupdfDocument(document)
	const widgets = engine ? (context.snapshot?.widgets.get(page) ?? null) : null
	const modelState = useAssistantStore(state => state.modelState)
	const startable = modelAcceptsMessages(modelState)
	const [read, setRead] = useState<{ readonly key: object; readonly page: number; readonly view: FormFillPage } | null>(null)
	const [details, setDetails] = useState("")
	const [phase, setPhase] = useState<Phase>({ kind: "details" })
	const [problem, setProblem] = useState<Problem | null>(null)
	// What the page's fields are read from: the editor's widgets of the page once it has them, else pdf.js's page.
	const source: object = widgets ?? document
	const view = read?.key === source && read.page === page ? read.view : null

	// Another page in view: what was matched for the last one is over.
	const [shownPage, setShownPage] = useState(page)

	if (shownPage !== page) {
		setShownPage(page)
		setPhase({ kind: "details" })
		setProblem(null)
	}

	// The page's fields (the ones its controls are drawn from: pdf.js's annotations, or the editor's widgets) and its
	// text, for the labels; read once per page and source.
	useEffect(() => {
		if (engine && widgets === null) {
			context.swap.withSession(session => {
				session.want([page])
			})

			return
		}

		const controller = new AbortController()
		const live = () => !controller.signal.aborted

		void (async () => {
			const proxy = await document.getPage(page + 1)
			const viewport: PdfViewport = proxy.getViewport({ scale: 1 })
			const fields = widgets === null ? pdfjsFields(await proxy.getAnnotations({ intent: "display" })) : engineFields(widgets)
			const runs = fields.length === 0 ? [] : textRuns((await proxy.getTextContent()).items, viewport)
			const candidates = fields.map(field => ({ field, box: viewportBox(viewport, ...field.rect) }))

			if (live()) setRead({ key: source, page, view: formFillPage(candidates, pageBox(viewport), runs, form) })
		})().catch(() => {
			if (live()) setRead({ key: source, page, view: { offered: [], left: [] } })
		})

		return () => {
			controller.abort()
		}
	}, [document, engine, widgets, source, page, form, context.swap])

	const review = phase.kind === "review" || phase.kind === "applying" ? phase : null
	const checked = review === null ? [] : review.result.fill.filter(entry => !review.unchecked.has(entry.field.id))

	// The values to fill, ghosted in the page's fields while the panel is open.
	useEffect(() => {
		preview.set(checked.length === 0 ? null : { page, values: new Map(checked.map(entry => [entry.field.id, entry.shown])) })
	})

	useEffect(
		() => () => {
			preview.set(null)
		},
		[preview]
	)

	async function match(): Promise<void> {
		if (view === null || view.offered.length === 0 || details.trim().length === 0) return

		setProblem(null)
		setPhase({ kind: "matching" })

		const outcome = await fillAssistantForm({
			fields: view.offered.map(candidate => candidate.fill),
			details,
			signal: new AbortController().signal
		})

		if (!outcome.ok) {
			setPhase({ kind: "details" })

			if (outcome.error === "too-long" || outcome.error === "failed") setProblem(outcome.error)

			return
		}

		if (outcome.fill.length === 0) setProblem("nothing")

		setPhase({ kind: "review", result: outcome, unchecked: new Set() })
	}

	async function apply(result: FormFillResult, entries: readonly FormFillEntry[]): Promise<void> {
		const unchecked = review?.unchecked ?? new Set<number>()

		setProblem(null)
		setPhase({ kind: "applying", result, unchecked })

		// Text typed into fields and not committed goes first (its own steps), as a save does.
		await form.commitDrafts((change, dropped) => {
			context.edit(change, dropped)
		})

		const outcome = await withPdfSession(context, session => applyFormFill(session, page, entries)).catch(() => null)

		if (outcome?.ok === true) {
			toast.success(t("previewPdfFormFillDone", { count: outcome.filled }))
			context.finish()

			return
		}

		setPhase({ kind: "review", result, unchecked })

		if (outcome === null) {
			setProblem("failed")
		} else if (outcome.reason === "changed") {
			const changed = new Set(outcome.fields)

			setProblem({ changed: entries.filter(entry => changed.has(entry.field.id)).map(entry => entry.field.label) })
		} else {
			setProblem("refused")
		}
	}

	const answered = new Set(review?.result.fill.map(entry => entry.field.id) ?? [])
	const dropped = new Map(
		review?.result.dropped.flatMap(drop => (drop.field === null ? [] : [[drop.field.id, drop.reason] as const])) ?? []
	)
	const notFilled =
		review === null
			? []
			: [
					...review.result.offered
						.filter(field => !answered.has(field.id))
						.map(field => {
							const reason = dropped.get(field.id)

							return t("previewPdfFormFillNotItem", {
								label: field.label,
								reason: t(reason === undefined ? "previewPdfFormFillReasonUnanswered" : DROP_REASONS[reason])
							})
						}),
					...review.result.left.map(field =>
						t("previewPdfFormFillNotItem", { label: field.label, reason: t("previewPdfFormFillReasonLimit") })
					),
					...(view?.left ?? []).map(left =>
						t("previewPdfFormFillNotItem", {
							label: left.label.length > 0 ? left.label : t("previewPdfFormFillUnnamed"),
							reason: t(LEFT_REASONS[left.reason])
						})
					)
				]
	const busy = phase.kind === "matching" || phase.kind === "applying"

	return (
		<PdfSidePanel aria-label={t("previewPdfFormFillTitle", { page: page + 1 })}>
			<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3 text-sm">
				<h2 className="flex items-center gap-2 font-medium">
					<SparklesIcon
						aria-hidden="true"
						className="size-4 text-muted-foreground"
					/>
					{t("previewPdfFormFillTitle", { page: page + 1 })}
				</h2>
				{!startable ? (
					<ModelNotReady state={modelState} />
				) : view === null ? (
					<div
						role="status"
						className="flex items-center gap-2 text-muted-foreground"
					>
						<Spinner className="size-4" />
						{t("previewPdfFormFillReadingPage")}
					</div>
				) : view.offered.length === 0 ? (
					<p className="text-muted-foreground">{t("previewPdfFormFillNoFields")}</p>
				) : (
					<>
						<div className="flex flex-col gap-1.5">
							<label
								htmlFor={detailsId}
								className="font-medium"
							>
								{t("previewPdfFormFillDetails")}
							</label>
							<textarea
								id={detailsId}
								aria-describedby={hintId}
								value={details}
								disabled={busy}
								rows={5}
								autoComplete="off"
								data-1p-ignore=""
								data-lpignore="true"
								data-bwignore=""
								data-form-type="other"
								className="min-h-24 w-full resize-y rounded-md border border-input bg-transparent px-2.5 py-2 text-sm leading-5 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
								onChange={event => {
									setDetails(event.target.value)
								}}
							/>
							<p
								id={hintId}
								className="text-xs text-muted-foreground"
							>
								{t("previewPdfFormFillDetailsHint")}
							</p>
							<Button
								size="sm"
								variant={review === null ? "default" : "outline"}
								className="self-start"
								disabled={busy || details.trim().length === 0}
								onClick={() => void match()}
							>
								{phase.kind === "matching" ? <Spinner className="size-3.5" /> : null}
								{t("previewPdfFormFillRun")}
							</Button>
						</div>
						{phase.kind === "matching" ? (
							<p
								role="status"
								className="text-muted-foreground"
							>
								{t("previewPdfFormFillMatching")}
							</p>
						) : null}
						{review === null ? null : (
							<>
								<section className="flex flex-col gap-1">
									<h3 className="text-xs font-medium text-muted-foreground">
										{t("previewPdfFormFillWill", { count: review.result.fill.length })}
									</h3>
									<ul className="flex flex-col gap-1">
										{review.result.fill.map(entry => (
											<li key={entry.field.id}>
												<label className="flex items-start gap-2">
													<input
														type="checkbox"
														className="mt-0.5"
														checked={!review.unchecked.has(entry.field.id)}
														disabled={busy}
														onChange={event => {
															const unchecked = new Set(review.unchecked)

															if (event.target.checked) unchecked.delete(entry.field.id)
															else unchecked.add(entry.field.id)

															setPhase({ ...review, kind: "review", unchecked })
														}}
													/>
													<span className="w-28 shrink-0 truncate text-muted-foreground">
														{entry.field.label}
													</span>
													<span className="min-w-0 flex-1 break-words">{entry.shown}</span>
												</label>
											</li>
										))}
									</ul>
								</section>
								{notFilled.length === 0 ? null : (
									<section className="flex flex-col gap-1">
										<h3 className="text-xs font-medium text-muted-foreground">
											{t("previewPdfFormFillNot", { count: notFilled.length })}
										</h3>
										<p className="text-muted-foreground">{notFilled.join(", ")}</p>
									</section>
								)}
							</>
						)}
					</>
				)}
				{problem === null ? null : (
					<p
						role="alert"
						className="flex gap-2 text-warning-foreground"
					>
						<TriangleAlertIcon
							aria-hidden="true"
							className="mt-0.5 size-4 shrink-0"
						/>
						<span>
							{typeof problem === "object"
								? t("previewPdfFormFillChanged", { fields: problem.changed.join(", ") })
								: t(
										problem === "too-long"
											? "previewPdfFormFillTooLong"
											: problem === "nothing"
												? "previewPdfFormFillNothing"
												: problem === "refused"
													? "previewPdfFormFillRefused"
													: "previewPdfFormFillFailed"
									)}
						</span>
					</p>
				)}
			</div>
			<div className="flex shrink-0 items-center justify-end gap-2 border-t p-3">
				<Button
					size="sm"
					variant="ghost"
					onClick={() => {
						context.finish()
					}}
				>
					{t("previewPdfFormFillCancel")}
				</Button>
				{review === null ? null : (
					<Button
						size="sm"
						disabled={busy || checked.length === 0}
						onClick={() => void apply(review.result, checked)}
					>
						{phase.kind === "applying" ? <Spinner className="size-3.5" /> : null}
						{t("previewPdfFormFillApply", { count: checked.length })}
					</Button>
				)}
			</div>
		</PdfSidePanel>
	)
}

type Rect = readonly [number, number, number, number]

// The values the panel would fill, ghosted in their fields on the page (never interactive: the fields stay usable).
export function FormFillOverlay({ context, page, viewport, widgets, editing, document }: PdfToolOverlayProps) {
	const preview = formFillPreview(context.swap)
	const shown = useSyncExternalStore(preview.subscribe, preview.get)
	const [read, setRead] = useState<{ readonly document: object; readonly rects: ReadonlyMap<number, Rect> } | null>(null)
	const values = shown?.page === page ? shown.values : null
	const engine = editing && widgets !== null
	const rects: ReadonlyMap<number, Rect> | null = engine
		? new Map(engineFields(widgets).map(field => [field.id, field.rect]))
		: read?.document === document
			? read.rects
			: null

	// Before the swap: the page's widgets as pdf.js holds them (it keeps the page's annotations).
	useEffect(() => {
		if (values === null || engine) return

		let live = true

		void document
			.getPage(page + 1)
			.then(proxy => proxy.getAnnotations({ intent: "display" }))
			.then(
				annotations => {
					if (live) setRead({ document, rects: new Map(pdfjsFields(annotations).map(field => [field.id, field.rect])) })
				},
				() => undefined
			)

		return () => {
			live = false
		}
	}, [values, engine, document, page])

	if (values === null || rects === null) return null

	const fields = { rects }

	return (
		<div
			aria-hidden="true"
			className="pointer-events-none absolute inset-0"
		>
			{[...values].map(([id, value]) => {
				const rect = fields.rects.get(id)

				if (rect === undefined) return null

				const [x1, y1] = viewport.convertToViewportPoint(rect[0], rect[1]).map(Number)
				const [x2, y2] = viewport.convertToViewportPoint(rect[2], rect[3]).map(Number)
				const box = pdfBox(x1 ?? 0, y1 ?? 0, x2 ?? 0, y2 ?? 0)

				return (
					<div
						key={id}
						data-assistant-form-fill-preview=""
						className="absolute overflow-hidden rounded-xs px-0.5 text-black/50 italic outline-1 outline-primary outline-dashed"
						style={{
							left: box.left,
							top: box.top,
							width: box.width,
							height: box.height,
							fontSize: Math.max(6, Math.min(box.height * 0.65, 18)),
							lineHeight: `${String(box.height)}px`
						}}
					>
						{value}
					</div>
				)
			})}
		</div>
	)
}
