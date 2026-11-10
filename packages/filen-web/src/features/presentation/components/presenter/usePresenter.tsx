import { useEffect, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { PresentationIcon } from "lucide-react"
import {
	createInkStore,
	createPresenterPortal,
	createScreenPlacement,
	changePointer,
	createShowKeys,
	createShowSwipe,
	INK_PEN_COLOR,
	InkLayer,
	ShowMirrorLink,
	showOptionsOf,
	startShowTimer,
	type InkStore,
	type PresentationDocument,
	type ShowController,
	type ShowEvent,
	type ShowKeyBindings,
	type ShowKeyEvent,
	type ShowTimer,
	type SwipePointer
} from "@filen/office/react/presentation"
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { DEFAULT_SLIDE_SIZE } from "@/features/presentation/components/deckChrome.logic"
import { InkToolbar } from "@/features/presentation/components/presenter/inkToolbar"
import { PRESENTER_START, presenterReduce, type PresenterPosition } from "@/features/presentation/components/presenter/presenter.logic"
import { PresenterView } from "@/features/presentation/components/presenter/presenterView"
import { usePresentationShowBindings } from "@/features/presentation/lib/keymap/show"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import { createScreenWakeLock } from "@/lib/media/wakeLock"
import { log } from "@/lib/log"

// Everything the running show gets from the presenter side: the keys (PowerPoint's and a clicker's), touch swipes,
// ink drawn over the stage and mirrored in the presenter view, the presenter view itself (its popup, or this window
// when the popup is blocked), the screen kept on, and "Keep ink annotations?" when the show ends.
//
// Activation order (measured in Chromium, Firefox and WebKit): window.open spends the click's user activation, so one
// click cannot both open the presenter's popup and put the stage in full screen. The click that starts the show with
// the presenter view opens the popup; the stage then shows Start slideshow, whose own click goes full screen (on the
// audience screen when the page may place windows). The presenter's own Start works where the browser lets a click
// in the popup put the opener in full screen (not Firefox), and says where to click otherwise.

export interface PresenterSession {
	readonly ink: InkStore
	readonly position: PresenterPosition
	// The presenter view shows (in its popup or this window).
	readonly active: boolean
	// From the click that starts the show with the presenter view, before the show starts: "window" (popup opened;
	// do not ask for full screen in this click), "sameWindow" (popup blocked: the presenter view shows here).
	readonly openPresenter: () => "window" | "sameWindow"
	// The player's controller (a ref callback; its cleanup is the show going away for the presenter side).
	readonly attach: (controller: ShowController | null) => (() => void) | undefined
	// For the player: keys first (true: the key was the show's, the player does nothing more with it), then pointer
	// down, up and cancel (true on the up that ended a swipe: the click after it must not advance).
	readonly stageProps: {
		readonly onKey: (event: ShowKeyEvent) => boolean
		readonly onPointer: (event: SwipePointer & { readonly type: string }) => boolean
		readonly onClickCapture: (event: MouseEvent<HTMLElement>) => void
	}
	// Inside the stage's slide box (SlideView's overlay): the ink, the tools, Start slideshow.
	readonly stageOverlay: ReactNode
	// Anywhere in the page: the presenter's popup portal or same-window view, and the keep-ink prompt.
	readonly layer: ReactNode
}

export interface PresenterOptions {
	readonly deck: PresentationDocument
	// Whether ink may be kept (an editable deck).
	readonly editable: boolean
	// Puts the audience stage in full screen; resolves whether it did.
	readonly fullscreen: (options?: FullscreenOptions) => Promise<boolean>
	// The stage is in full screen (Start slideshow is no longer needed).
	readonly fullscreenActive: boolean
	// Where focus goes back to once "Keep ink annotations?" is answered (the slide the show started from).
	readonly returnFocus?: () => HTMLElement | null
}

const PRESENTER_Z = 2147483600

class PresenterLive {
	controller: ShowController | undefined
	position: PresenterPosition = PRESENTER_START
	bindings: ShowKeyBindings
	deck: PresentationDocument
	// The presenter's current slide: the stage copied live from whichever controller drives the show.
	readonly mirror = new ShowMirrorLink()

	constructor(deck: PresentationDocument, bindings: ShowKeyBindings) {
		this.deck = deck
		this.bindings = bindings
	}

	update(deck: PresentationDocument, bindings: ShowKeyBindings): void {
		this.deck = deck
		this.bindings = bindings
	}

	// A show is running (its controller may be swapped for a new one by a re-render in between).
	running = false
	// "Keep" was chosen: the prompt closing does not discard the ink being added.
	keeping = false

	setKeeping(keeping: boolean): void {
		this.keeping = keeping
	}

	// Whether this controller starts a show (none ran): the position starts over.
	attach(controller: ShowController): boolean {
		this.controller = controller
		this.mirror.connect(controller)

		if (this.running) return false

		this.running = true
		this.position = PRESENTER_START

		return true
	}

	detach(controller: ShowController): void {
		if (this.controller === controller) this.controller = undefined

		this.mirror.disconnect(controller)
	}

	// The show ended, or its player went away for good.
	stop(): void {
		this.running = false
	}

	move(event: ShowEvent): PresenterPosition {
		this.position = presenterReduce(this.position, event)

		return this.position
	}
}

export function usePresenter({ deck, editable, fullscreen, fullscreenActive, returnFocus }: PresenterOptions): PresenterSession {
	const { t } = useTranslation("preview")
	const [ink] = useState(createInkStore)
	const [position, setPosition] = useState<PresenterPosition>(PRESENTER_START)
	const [timer, setTimer] = useState<ShowTimer>(() => startShowTimer(performance.now()))
	const [mode, setMode] = useState<"off" | "window" | "sameWindow">("off")
	// Same window: the presenter view, or the slideshow under it.
	const [audienceShown, setAudienceShown] = useState(false)
	const [startHint, setStartHint] = useState(false)
	const [keepPrompt, setKeepPrompt] = useState(false)
	const [, setPortalVersion] = useState(0)
	const bindings = usePresentationShowBindings()
	// What the keys, swipes and show events read outside render: the player's controller, where the show is, the
	// bindings and the deck in effect.
	const [live] = useState(() => new PresenterLive(deck, bindings))
	const [placement] = useState(() => createScreenPlacement(window))
	const [portal] = useState(() =>
		createPresenterPortal({
			opener: window,
			title: t("previewPptxPresenterWindowTitle"),
			features: () => placement.features(),
			onChange: () => {
				setPortalVersion(version => version + 1)

				// The presenter closed its popup during the show: the keys go back to the stage (Chromium leaves focus
				// on the page's overlay, Firefox on the body).
				if (portal.window === undefined && live.running)
					document.querySelector<HTMLElement>("[data-fo-show-stage]")?.focus({ preventScroll: true })
			}
		})
	)
	const [keys] = useState(() =>
		createShowKeys({
			controller: () => live.controller,
			ink,
			slide: () => live.position.slide,
			count: () => live.deck.slides.length,
			get bindings() {
				return live.bindings
			},
			apple: isMacPlatform(),
			pointer: change => {
				const stage = document.querySelector<HTMLElement>("[data-fo-show-stage]")

				if (stage !== null) changePointer(stage, change)
			}
		})
	)
	const [swipe] = useState(() =>
		createShowSwipe({
			next: () => live.controller?.next(),
			prev: () => live.controller?.prev(),
			enabled: () => ink.getSnapshot().tool === "none"
		})
	)
	const [wakeLock] = useState(() => createScreenWakeLock({ needed: true }))
	const size = deck.info?.size ?? DEFAULT_SLIDE_SIZE

	useEffect(() => {
		live.update(deck, bindings)
	}, [live, bindings, deck])

	// The screens are read ahead of the click when the user has already let the page place windows.
	useEffect(() => {
		void placement.refresh()
	}, [placement])

	useEffect(
		() => () => {
			portal.close()
			wakeLock.dispose()
		},
		[portal, wakeLock]
	)

	const onShowEvent = (event: ShowEvent): void => {
		const next = live.move(event)

		setPosition(next)

		if (event.type === "ended") finish()
	}

	const finish = (): void => {
		live.stop()
		wakeLock.set(false)
		portal.close()
		setMode("off")
		setAudienceShown(false)
		setStartHint(false)

		if (ink.getSnapshot().inked && editable && live.deck.session !== undefined) setKeepPrompt(true)
		else ink.reset()
	}

	const attach = (controller: ShowController | null): (() => void) | undefined => {
		if (controller === null) return undefined

		if (live.attach(controller)) {
			setPosition(PRESENTER_START)
			setTimer(startShowTimer(performance.now()))
			ink.setTool("none")
			// The deck's pen colour (Set Up Slide Show), PowerPoint's red without one.
			ink.setDefaultPen(showOptionsOf(live.deck.info?.show).penColor ?? INK_PEN_COLOR)
			wakeLock.set(true)
		}

		const off = (["slide", "step", "screen", "ended"] as const).map(type => controller.on(type, onShowEvent))

		return () => {
			for (const unsubscribe of off) unsubscribe()

			live.detach(controller)

			// A player that re-renders hands over a new controller in the same commit; one that unmounted leaves
			// none, and the show is over for the presenter side.
			queueMicrotask(() => {
				if (live.controller === undefined && live.running) finish()
			})
		}
	}

	const openPresenter = (): "window" | "sameWindow" => {
		const opened = portal.open()

		if (opened.kind === "opened") {
			setMode("window")

			return "window"
		}

		if (opened.kind === "refused") log.warn("presentation", "presenter window", { reason: opened.reason })

		setMode("sameWindow")
		setAudienceShown(false)

		return "sameWindow"
	}

	const startFullscreen = (fromPresenter: boolean): void => {
		void fullscreen(placement.fullscreenOptions()).then(done => {
			if (!done && fromPresenter) setStartHint(true)
		})
	}

	const onKeyDown = (event: KeyboardEvent<HTMLElement>): boolean => keys.onKeyDown(event)

	const keep = async (): Promise<void> => {
		live.setKeeping(true)
		setKeepPrompt(false)

		const session = deck.session
		const ops = ink.ops(t("previewPptxInkGroupName"))

		if (session === undefined) {
			live.setKeeping(false)
			ink.reset()

			return
		}

		// Slide by slide: a slide whose ink is refused keeps it for the next show; the others' is added.
		let failed = 0

		for (const op of ops) {
			try {
				const result = await session.command(op)

				if (result.ok) {
					ink.clear(op.slide)

					continue
				}

				log.warn("presentation", "ink not kept", { reason: result.refusal })
			} catch (error) {
				log.warn("presentation", "ink not kept", { error })
			}

			failed++
		}

		live.setKeeping(false)

		if (failed === 0) ink.reset()
		else if (failed === ops.length) toast.error(t("previewPptxInkKeepFailed"))
		else toast.error(t("previewPptxInkKeepPartial", { count: failed }))
	}

	const awaitingStart = mode === "window" && !fullscreenActive && !position.ended

	const view = (sameWindow: boolean): ReactNode => (
		<PresenterView
			deck={deck}
			position={position}
			controller={() => live.controller}
			mirror={live.mirror}
			ink={ink}
			onKeyDown={onKeyDown}
			timer={timer}
			onTimer={setTimer}
			{...(sameWindow
				? {
						sameWindow: {
							onShowAudience: () => {
								setAudienceShown(true)
							}
						}
					}
				: {})}
			{...(awaitingStart
				? {
						start: {
							onStart: () => {
								startFullscreen(true)
							},
							hint: startHint
						}
					}
				: {})}
		/>
	)

	const container = portal.container

	return {
		ink,
		position,
		active: mode !== "off",
		openPresenter,
		attach,
		stageProps: {
			onKey: event => keys.onKeyDown(event),
			onPointer: event => {
				switch (event.type) {
					case "pointerdown":
						swipe.onPointerDown(event)
						return false
					case "pointerup":
						return swipe.onPointerUp(event)
					case "pointercancel":
						swipe.onPointerCancel(event)
						return false
					default:
						return false
				}
			},
			onClickCapture: event => {
				swipe.onClickCapture(event)
			}
		},
		stageOverlay: (
			<>
				<InkLayer
					store={ink}
					slide={position.slide}
					size={size}
					label={t("previewPptxInkLayer")}
				/>
				<InkToolbar
					ink={ink}
					slide={position.slide}
					variant="stage"
					className="pointer-events-auto absolute bottom-2 left-2 opacity-40 transition-opacity focus-within:opacity-100 hover:opacity-100"
				/>
				{awaitingStart ? (
					<div className="absolute inset-0 flex items-center justify-center">
						<Button
							size="lg"
							className="pointer-events-auto"
							autoFocus
							onClick={event => {
								event.stopPropagation()
								startFullscreen(false)
							}}
						>
							<PresentationIcon />
							{t("previewPptxPresenterStart")}
						</Button>
					</div>
				) : null}
				{mode === "sameWindow" && audienceShown ? (
					<Button
						variant="secondary"
						size="sm"
						className="pointer-events-auto absolute top-2 right-2 opacity-40 hover:opacity-100 focus-visible:opacity-100"
						onClick={event => {
							event.stopPropagation()
							setAudienceShown(false)
						}}
					>
						{t("previewPptxPresenterShowPresenter")}
					</Button>
				) : null}
			</>
		),
		layer: (
			<>
				{mode === "window" && container !== undefined ? createPortal(view(false), container) : null}
				{mode === "sameWindow" && !audienceShown && !position.ended ? (
					<div
						className="fixed inset-0"
						style={{ zIndex: PRESENTER_Z }}
					>
						{view(true)}
					</div>
				) : null}
				<AlertDialog
					open={keepPrompt}
					onOpenChange={open => {
						if (!open) {
							setKeepPrompt(false)

							if (!live.keeping) ink.reset()
						}
					}}
				>
					<AlertDialogContent finalFocus={() => returnFocus?.() ?? true}>
						<AlertDialogHeader>
							<AlertDialogTitle>{t("previewPptxInkKeepTitle")}</AlertDialogTitle>
							<AlertDialogDescription>{t("previewPptxInkKeepDescription")}</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>{t("previewPptxInkDiscard")}</AlertDialogCancel>
							<AlertDialogAction
								autoFocus
								onClick={() => void keep()}
							>
								{t("previewPptxInkKeep")}
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</>
		)
	}
}
