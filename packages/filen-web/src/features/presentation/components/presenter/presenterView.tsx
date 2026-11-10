import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react"
import { useTranslation } from "react-i18next"
import {
	AArrowDownIcon,
	AArrowUpIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	MonitorIcon,
	PauseIcon,
	PlayIcon,
	RotateCcwIcon,
	SquareIcon,
	XIcon
} from "lucide-react"
import { EMU_PER_PX } from "@filen/office/core/drawingml"
import {
	formatElapsed,
	pauseTimer,
	resetTimer,
	resumeTimer,
	timerElapsed,
	InkLayer,
	NotesText,
	paintSlide,
	pressesControl,
	ShowMirrorView,
	SlideView,
	type InkStore,
	type PresentationDocument,
	type ShowController,
	type ShowMirrorLink,
	type ShowTimer
} from "@filen/office/react/presentation"
import { Button } from "@/components/ui/button"
import { DEFAULT_SLIDE_SIZE } from "@/features/presentation/components/deckChrome.logic"
import { InkToolbar } from "@/features/presentation/components/presenter/inkToolbar"
import {
	fitScale,
	NOTES_DEFAULT_SIZE_INDEX,
	NOTES_SIZES,
	presenterNext,
	type PresenterPosition
} from "@/features/presentation/components/presenter/presenter.logic"
import { cn } from "@filen/shared"

// The presenter view: the slide on stage (with the ink drawn on it, mirrored to the audience), the next slide or
// animation, the speaker notes at a size the presenter picks, the time presenting and the time of day, where the
// show is, and the controls. It renders in the presenter's popup (portaled from the page's React root) or over the
// show in the page's own window when the popup was blocked. Plain buttons only: menus and tooltips portal to the
// page's body, which is the wrong window here.

export interface PresenterViewProps {
	readonly deck: PresentationDocument
	readonly position: PresenterPosition
	readonly controller: () => ShowController | undefined
	// The current slide: the audience's stage copied live (builds, transitions, video), kept on whichever controller
	// drives the show.
	readonly mirror: ShowMirrorLink
	readonly ink: InkStore
	readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
	// Kept by the caller, so it runs on while the view is hidden or moves between windows.
	readonly timer: ShowTimer
	readonly onTimer: (timer: ShowTimer) => void
	// The show's order when it runs a custom show (deck indices).
	readonly sequence?: readonly number[]
	// Shown in the page's own window (the popup was blocked): a button to show the slideshow instead.
	readonly sameWindow?: { readonly onShowAudience: () => void }
	// The audience window waits for a click to go full screen: Start tries it from here.
	readonly start?: { readonly onStart: () => void; readonly hint: boolean }
}

// A slide fitted to its box (the next slide's preview). The box is measured with its own window's ResizeObserver: an
// observer from the page's realm never sees layout in the popup.
function FitSlide({ deck, index, label, className }: { deck: PresentationDocument; index: number; label: string; className?: string }) {
	const boxRef = useRef<HTMLDivElement | null>(null)
	const [box, setBox] = useState({ width: 0, height: 0 })
	const size = deck.info?.size ?? DEFAULT_SLIDE_SIZE
	const slide = deck.slides[index]

	useLayoutEffect(() => {
		const element = boxRef.current

		if (element === null) return

		const read = (): void => {
			const width = element.clientWidth
			const height = element.clientHeight

			setBox(previous => (previous.width === width && previous.height === height ? previous : { width, height }))
		}
		const View = element.ownerDocument.defaultView
		const observer = View === null ? undefined : new View.ResizeObserver(read)

		read()
		observer?.observe(element)

		return () => observer?.disconnect()
	}, [])

	return (
		<div
			ref={boxRef}
			className={cn("relative min-h-0 min-w-0 max-md:aspect-(--fo-slide-ratio)", className)}
			style={{ "--fo-slide-ratio": `${String(size.cx)} / ${String(size.cy)}` } as CSSProperties}
		>
			{slide === undefined ? null : (
				<SlideView
					render={deck.renders.get(slide.ref)}
					size={size}
					painter={paintSlide}
					{...(deck.session === undefined ? {} : { session: deck.session })}
					label={label}
					mode="show"
					zoom={fitScale(box, { width: size.cx / EMU_PER_PX, height: size.cy / EMU_PER_PX })}
					className="!absolute inset-0 !bg-transparent"
				/>
			)}
		</div>
	)
}

// The time presenting and the time of day, read once a second (only this part renders on the tick).
function Clocks({ timer, setTimer }: { timer: ShowTimer; setTimer: (timer: ShowTimer) => void }) {
	const { t, i18n } = useTranslation("preview")
	// The clock's two readings: performance time for the timer, wall time for the time of day.
	const [now, setNow] = useState(() => ({ at: performance.now(), wall: Date.now() }))
	const running = timer.since !== undefined

	useEffect(() => {
		const id = setInterval(() => {
			setNow({ at: performance.now(), wall: Date.now() })
		}, 1000)

		return () => {
			clearInterval(id)
		}
	}, [])

	const clock = new Intl.DateTimeFormat(i18n.language, { hour: "numeric", minute: "2-digit" }).format(now.wall)

	return (
		<div className="flex items-center gap-1">
			<span
				role="timer"
				aria-label={t("previewPptxPresenterTimer")}
				className="min-w-16 text-lg font-semibold tabular-nums"
			>
				{formatElapsed(timerElapsed(timer, now.at))}
			</span>
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label={t(running ? "previewPptxPresenterPause" : "previewPptxPresenterResume")}
				title={t(running ? "previewPptxPresenterPause" : "previewPptxPresenterResume")}
				onClick={() => {
					const at = performance.now()

					setTimer(running ? pauseTimer(timer, at) : resumeTimer(timer, at))
					setNow({ at, wall: Date.now() })
				}}
			>
				{running ? <PauseIcon /> : <PlayIcon />}
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label={t("previewPptxPresenterResetTimer")}
				title={t("previewPptxPresenterResetTimer")}
				onClick={() => {
					const at = performance.now()

					setTimer(resetTimer(timer, at))
					setNow({ at, wall: Date.now() })
				}}
			>
				<RotateCcwIcon />
			</Button>
			<span
				aria-label={t("previewPptxPresenterClock")}
				className="ml-2 text-sm text-muted-foreground tabular-nums"
			>
				{clock}
			</span>
		</div>
	)
}

export function PresenterView({
	deck,
	position,
	controller,
	mirror,
	ink,
	onKeyDown,
	timer,
	onTimer,
	sequence,
	sameWindow,
	start
}: PresenterViewProps) {
	const { t } = useTranslation("preview")
	const rootRef = useRef<HTMLDivElement | null>(null)
	const [notesSize, setNotesSize] = useState(NOTES_DEFAULT_SIZE_INDEX)
	const size = deck.info?.size ?? DEFAULT_SLIDE_SIZE
	const slide = deck.slides[position.index]
	const next = presenterNext(position, deck.slides, sequence)
	const render = slide === undefined ? undefined : deck.renders.get(slide.ref)
	const notes = render?.notesText ?? ""
	const total = deck.slides.length

	// The keys go to the presenter view as soon as it shows, and again whenever its window gets focus with nothing
	// focused in it (Firefox focuses a new popup's body after the opener's effects ran). In the popup, a key that still
	// lands on its body (outside the portal React listens on) is handed to the view.
	const popup = sameWindow === undefined

	useEffect(() => {
		const root = rootRef.current

		if (root === null) return

		const doc = root.ownerDocument
		const view = doc.defaultView
		const claim = (): void => {
			if (doc.activeElement === null || doc.activeElement === doc.body) root.focus({ preventScroll: true })
		}
		const stray = (event: globalThis.KeyboardEvent): void => {
			if (event.target !== doc.body && event.target !== doc.documentElement) return

			root.focus({ preventScroll: true })

			const copy = new (view ?? window).KeyboardEvent("keydown", {
				key: event.key,
				code: event.code,
				shiftKey: event.shiftKey,
				ctrlKey: event.ctrlKey,
				metaKey: event.metaKey,
				altKey: event.altKey,
				repeat: event.repeat,
				bubbles: true,
				cancelable: true
			})

			root.dispatchEvent(copy)

			if (copy.defaultPrevented) event.preventDefault()
		}

		root.focus({ preventScroll: true })

		if (!popup) return

		view?.addEventListener("focus", claim)
		doc.addEventListener("keydown", stray)

		return () => {
			view?.removeEventListener("focus", claim)
			doc.removeEventListener("keydown", stray)
		}
	}, [popup])

	return (
		<div
			ref={rootRef}
			role="region"
			aria-label={t("previewPptxPresenterLabel")}
			tabIndex={-1}
			className="flex h-full min-h-0 flex-col bg-background text-foreground outline-none"
			onKeyDown={event => {
				// Enter and Space press the view's own buttons, never the show's next slide.
				if (!pressesControl(event)) onKeyDown(event)

				// The editor under the show takes no key while it runs (React carries portal events to it).
				if (event.key !== "Tab") event.stopPropagation()
			}}
		>
			<div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
				<Clocks
					timer={timer}
					setTimer={onTimer}
				/>
				<span
					className="text-sm tabular-nums"
					aria-live="polite"
				>
					{t("previewPptxPresenterSlideCount", { current: position.index + 1, total })}
				</span>
				<div className="ml-auto flex flex-wrap items-center gap-1">
					{start === undefined ? null : (
						<Button
							size="sm"
							onClick={start.onStart}
						>
							{t("previewPptxPresenterStart")}
						</Button>
					)}
					{sameWindow === undefined ? null : (
						<Button
							variant="outline"
							size="sm"
							onClick={sameWindow.onShowAudience}
						>
							<MonitorIcon />
							{t("previewPptxPresenterShowAudience")}
						</Button>
					)}
					<Button
						variant="outline"
						size="sm"
						onClick={() => controller()?.end()}
					>
						<XIcon />
						{t("previewPptxPresenterEnd")}
					</Button>
				</div>
			</div>
			{sameWindow === undefined ? null : (
				<p
					role="status"
					className="border-b border-border px-3 py-1 text-xs text-muted-foreground"
				>
					{t("previewPptxPresenterBlocked")}
				</p>
			)}
			{start?.hint === true ? (
				<p
					role="status"
					className="border-b border-border px-3 py-1 text-xs text-muted-foreground"
				>
					{t("previewPptxPresenterStartHint")}
				</p>
			) : null}
			<div className="grid min-h-0 flex-1 grid-rows-[auto_auto_minmax(0,1fr)] gap-2 overflow-y-auto p-2 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] md:grid-rows-[minmax(0,1fr)_auto] md:overflow-visible">
				<div
					className="relative min-h-0 min-w-0 max-md:aspect-(--fo-slide-ratio) md:row-span-1"
					style={{ "--fo-slide-ratio": `${String(size.cx)} / ${String(size.cy)}` } as CSSProperties}
				>
					<ShowMirrorView
						link={mirror}
						size={size}
						label={t("previewPptxPresenterCurrent")}
						screen={position.screen}
						endLabel={t("previewPptxShowEnd")}
						className="!absolute inset-0"
						overlay={
							<InkLayer
								store={ink}
								slide={slide?.ref}
								size={size}
								label={t("previewPptxInkLayer")}
							/>
						}
					/>
				</div>
				<div className="flex min-h-0 flex-col gap-2 max-md:row-start-3 md:row-span-2">
					<section
						aria-label={t("previewPptxPresenterNext")}
						className="flex flex-col gap-1 max-md:w-3/5 md:h-2/5 md:min-h-24"
					>
						<h2 className="text-xs font-medium text-muted-foreground">{t("previewPptxPresenterNext")}</h2>
						{next.kind === "slide" ? (
							<FitSlide
								deck={deck}
								index={next.index}
								label={t("previewPptxPresenterNext")}
								className="bg-black md:flex-1"
							/>
						) : (
							<div className="flex flex-1 items-center justify-center rounded-md bg-muted p-2 text-center text-sm text-muted-foreground">
								{t(next.kind === "step" ? "previewPptxPresenterNextStep" : "previewPptxPresenterEndOfShow")}
							</div>
						)}
					</section>
					<section
						aria-label={t("previewPptxPresenterNotesRegion")}
						className="flex min-h-0 flex-1 flex-col gap-1 max-md:min-h-48"
					>
						<div className="flex items-center gap-1">
							<h2 className="text-xs font-medium text-muted-foreground">{t("previewPptxPresenterNotes")}</h2>
							<Button
								variant="ghost"
								size="icon-sm"
								className="ml-auto"
								aria-label={t("previewPptxPresenterNotesSmaller")}
								title={t("previewPptxPresenterNotesSmaller")}
								disabled={notesSize === 0}
								onClick={() => {
									setNotesSize(index => Math.max(0, index - 1))
								}}
							>
								<AArrowDownIcon />
							</Button>
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={t("previewPptxPresenterNotesLarger")}
								title={t("previewPptxPresenterNotesLarger")}
								disabled={notesSize === NOTES_SIZES.length - 1}
								onClick={() => {
									setNotesSize(index => Math.min(NOTES_SIZES.length - 1, index + 1))
								}}
							>
								<AArrowUpIcon />
							</Button>
						</div>
						<div
							className="min-h-0 flex-1 overflow-auto rounded-md border border-border p-2 leading-normal whitespace-pre-wrap"
							style={{ fontSize: NOTES_SIZES[notesSize] }}
							tabIndex={0}
						>
							{render?.notes !== undefined ? (
								<NotesText paragraphs={render.notes} />
							) : notes === "" ? (
								<span className="text-muted-foreground">{t("previewPptxPresenterNoNotes")}</span>
							) : (
								notes
							)}
						</div>
					</section>
				</div>
				<div className="flex flex-wrap items-center gap-1 max-md:row-start-2">
					<Button
						variant="outline"
						size="icon"
						aria-label={t("previewPptxPresenterPrevious")}
						title={t("previewPptxPresenterPrevious")}
						onClick={() => controller()?.prev()}
					>
						<ChevronLeftIcon />
					</Button>
					<Button
						variant="outline"
						size="icon"
						aria-label={t("previewPptxPresenterNextButton")}
						title={t("previewPptxPresenterNextButton")}
						onClick={() => controller()?.next()}
					>
						<ChevronRightIcon />
					</Button>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={t("previewPptxPresenterBlack")}
						title={t("previewPptxPresenterBlack")}
						aria-pressed={position.screen === "black"}
						onClick={() => controller()?.black()}
					>
						<SquareIcon className="fill-current" />
					</Button>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={t("previewPptxPresenterWhite")}
						title={t("previewPptxPresenterWhite")}
						aria-pressed={position.screen === "white"}
						onClick={() => controller()?.white()}
					>
						<SquareIcon />
					</Button>
					<InkToolbar
						ink={ink}
						slide={slide?.ref}
						variant="presenter"
					/>
				</div>
			</div>
		</div>
	)
}
