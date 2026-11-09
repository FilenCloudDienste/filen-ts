import {
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
	useState,
	type KeyboardEvent,
	type PointerEvent,
	type ReactNode,
	type Ref
} from "react"
import type { DocxLinkTarget } from "../../../core/docx/layout/pageData"
import { EMU_PER_PX } from "../../../core/drawingml/index"
import type { Action, CustomShow, ShowSettings, SlideRef } from "../../../core/presentation/model"
import type { PresentationSessionApi, SlideLayer, SlideRender } from "../../../dom/presentation/protocol"
import type { PresentationActionActivator, PresentationActionPolicy } from "../links"
import { isContextMenuKey } from "../presenter/keys"
import type { SlidePainter } from "../SlideView"
import type { ShowController, ShowFrom, ShowScreen } from "./controller"
import { autoHidePointer } from "./pointer"
import { ShowPlayer, type PlayerProps } from "./runtime"
import type { ShowMediaMount } from "./stage"
import { showOptionsOf, type ShowOptions, type ShowSlide } from "./timeline"

// The slide show: the player (show/runtime.ts) on a stage over the whole viewport (the page puts the document in full
// screen around it), the slide letterboxed and scaled to fit. The stage takes the keyboard while it is shown;
// clicks advance (in a kiosk only actions, triggers and timings do). It implements ShowController through `ref`.

export interface SlideShowProps {
	readonly slides: readonly ShowSlide[]
	readonly customShows: readonly CustomShow[]
	readonly renders: ReadonlyMap<SlideRef, SlideRender>
	// EMU.
	readonly size: { readonly cx: number; readonly cy: number }
	// Paints a slide whose layers cannot be drawn (and every slide without a session).
	readonly painter: SlidePainter
	readonly session?: PresentationSessionApi
	// The deck's own settings (OpenInfo.show), then what the page overrides for this show.
	readonly settings?: ShowSettings
	readonly options?: Partial<ShowOptions>
	readonly from?: ShowFrom
	// The deck index on stage (the page centres its render window there).
	readonly onSlide?: (index: number) => void
	readonly onEnd: () => void
	readonly label: string
	// The line on the black screen after the last slide ("End of slide show, click to exit.").
	readonly endLabel?: string
	readonly slideLabel: (index: number, count: number) => string
	readonly actionLabel?: (action: Action, layer: SlideLayer) => string
	// Accessible names of an animation trigger and of a text link.
	readonly triggerLabel?: (layer: SlideLayer) => string
	readonly linkLabel?: (link: DocxLinkTarget) => string
	// The show builds its activator from it (jumps navigate the show); `actions` is used as given otherwise.
	readonly policy?: PresentationActionPolicy
	readonly actions?: PresentationActionActivator
	readonly media?: ShowMediaMount
	// Drawn over the slide at slide px (pen and laser). Pointer events pass through it to the slide; a control in it
	// takes them with pointer-events: auto.
	readonly overlay?: ReactNode
	// Called first for every key, and for every pointer down, up and cancel on the stage; true: consumed (a consumed
	// pointer up also keeps the click after it from advancing).
	readonly onKey?: (event: KeyboardEvent<HTMLDivElement>) => boolean
	readonly onPointer?: (event: PointerEvent<HTMLDivElement>) => boolean
	// The show's shortcut menu (PowerPoint's right click, Shift+F10 or the Menu key), at client px; the stage is where
	// focus goes back when it closes. The browser's own menu never shows over the show; a kiosk has no menu.
	readonly onContextMenu?: (at: { readonly x: number; readonly y: number; readonly stage: HTMLElement }) => void
	// The mouse pointer hides once still (show/pointer.ts); false keeps it (a preview inside the editor). Read once.
	readonly autoHidePointer?: boolean
	readonly ref?: Ref<ShowController>
}

function playerProps(props: SlideShowProps): PlayerProps {
	return {
		slides: props.slides,
		customShows: props.customShows,
		renders: props.renders,
		size: props.size,
		painter: props.painter,
		session: props.session,
		options: { ...showOptionsOf(props.settings), ...props.options },
		policy: props.policy,
		actions: props.actions,
		media: props.media,
		onSlide: props.onSlide,
		onEnd: props.onEnd,
		labels: {
			action: (action, layer) =>
				props.actionLabel?.(action, layer) ?? layer.alt ?? (action.kind === "url" ? action.href : String(layer.shape.id)),
			trigger: layer => props.triggerLabel?.(layer) ?? layer.alt ?? String(layer.shape.id),
			link: link => props.linkLabel?.(link) ?? link.tooltip ?? (link.kind === "external" ? link.href : link.anchor)
		}
	}
}

// How long after a menu key the browser's contextmenu for it may come.
const KEY_ECHO_MS = 1000

function isControl(target: EventTarget): boolean {
	const element = target as Partial<Element>

	return typeof element.closest === "function" && element.closest("button, a[href], input, select, textarea, [role='button']") !== null
}

export function SlideShow(props: SlideShowProps) {
	const { size, label, endLabel, slideLabel, slides, overlay, onKey, onPointer, ref } = props
	const stageRef = useRef<HTMLDivElement | null>(null)
	const hostRef = useRef<HTMLDivElement | null>(null)
	const playerRef = useRef<ShowPlayer | null>(null)
	const [index, setIndex] = useState<number | undefined>(undefined)
	const [screen, setScreen] = useState<ShowScreen>("slide")
	const [fit, setFit] = useState({ scale: 0, left: 0, top: 0 })
	const [typed, setTyped] = useState("")
	// The press that ended in a consumed pointer up: its click does not advance.
	const swallowed = useRef(false)
	// When a key opened the menu: the browser's contextmenu for that same key (the Menu key's comes on keyup) is not a
	// second one.
	const keyedMenu = useRef<number | undefined>(undefined)
	const slideWidth = size.cx / EMU_PER_PX
	const slideHeight = size.cy / EMU_PER_PX

	useLayoutEffect(() => {
		const host = hostRef.current
		const stage = stageRef.current

		if (host === null || stage === null) return

		const player = new ShowPlayer(host, playerProps(props), { slide: setIndex, screen: setScreen })
		const view = stage.ownerDocument.defaultView
		const measure = (): void => {
			const width = stage.clientWidth
			const height = stage.clientHeight
			const scale = width > 0 && height > 0 ? Math.min(width / slideWidth, height / slideHeight) : 0

			setFit(previous =>
				previous.scale === scale
					? previous
					: { scale, left: (width - slideWidth * scale) / 2, top: (height - slideHeight * scale) / 2 }
			)
			player.resize(slideWidth * scale, view?.devicePixelRatio ?? 1)
		}
		const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : undefined

		const showPointer = props.autoHidePointer === false ? undefined : autoHidePointer(stage)

		playerRef.current = player
		measure()
		observer?.observe(stage)
		// The stage owns the keyboard while it is shown.
		stage.focus({ preventScroll: true })
		void player.start(props.from)

		return () => {
			showPointer?.()
			observer?.disconnect()
			player.dispose()
			playerRef.current = null
		}
	}, [])

	useEffect(() => {
		playerRef.current?.update(playerProps(props))
	})

	useImperativeHandle(ref, () => {
		// first/last: the running show's first and last slide (Home/End of the presenter's keys).
		const controller: ShowController & { first(): void; last(): void; nextHidden(): void } = {
			start: from => playerRef.current?.start(from) ?? Promise.resolve({ kind: "refused", reason: "closed" }),
			next: () => playerRef.current?.next(),
			prev: () => playerRef.current?.prev(),
			goto: target => playerRef.current?.goto(target),
			black: () => playerRef.current?.black(),
			white: () => playerRef.current?.white(),
			end: () => playerRef.current?.end(),
			first: () => playerRef.current?.first(),
			last: () => playerRef.current?.last(),
			nextHidden: () => playerRef.current?.nextHidden(),
			on: (type, listener) => playerRef.current?.on(type, listener) ?? (() => undefined)
		}

		return controller
	}, [])

	// A kiosk is driven by its actions, triggers and timings only: no menu.
	const menu = (x: number, y: number, stage: HTMLElement): void => {
		if (props.onContextMenu === undefined || (props.options?.kiosk ?? showOptionsOf(props.settings).kiosk)) return

		props.onContextMenu({ x, y, stage })
	}

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
		// Every key stays in the show: the page under it (an editor, the preview's own keys) never sees one. Tab moves
		// focus between the show's own controls.
		if (event.key !== "Tab") event.stopPropagation()

		// Enter and Space press a focused control over the slide (the ink tools), not the show's next.
		if ((event.key === "Enter" || event.key === " ") && event.target !== event.currentTarget && isControl(event.target)) return

		if (isContextMenuKey(event)) {
			const stage = event.currentTarget
			const box = stage.getBoundingClientRect()

			event.preventDefault()
			keyedMenu.current = event.timeStamp
			menu(box.left + box.width / 2, box.top + box.height / 2, stage)

			return
		}

		if (onKey?.(event) === true) return

		const player = playerRef.current

		if (player === null) return

		const outcome = player.key({
			key: event.key,
			code: event.code,
			typed,
			altKey: event.altKey,
			ctrlKey: event.ctrlKey,
			metaKey: event.metaKey,
			shiftKey: event.shiftKey
		})

		if (outcome === "typed") setTyped(previous => previous + event.key)
		else if (typed !== "") setTyped("")

		if (outcome === "ignored") return

		// Escape ends the show and nothing else (the preview around it stays open).
		event.preventDefault()
	}

	return (
		<div
			ref={stageRef}
			className="fo-show-stage"
			role="region"
			aria-label={label}
			data-fo-show-stage=""
			data-fo-screen={screen}
			tabIndex={-1}
			style={{ touchAction: "none" }}
			onKeyDown={onKeyDown}
			onPointerDown={event => {
				swallowed.current = onPointer?.(event) === true
			}}
			onPointerUp={event => {
				if (onPointer?.(event) === true) swallowed.current = true
			}}
			onPointerCancel={event => {
				onPointer?.(event)
			}}
			onContextMenu={event => {
				event.preventDefault()
				event.stopPropagation()

				const keyed = keyedMenu.current

				keyedMenu.current = undefined

				if (keyed !== undefined && event.timeStamp - keyed < KEY_ECHO_MS) return

				menu(event.clientX, event.clientY, event.currentTarget)
			}}
			onClick={event => {
				const consumed = swallowed.current

				swallowed.current = false

				if (consumed || event.button !== 0) return

				playerRef.current?.click()
			}}
		>
			<div
				className="fo-show-viewport"
				style={{ left: fit.left, top: fit.top, width: slideWidth * fit.scale, height: slideHeight * fit.scale }}
			>
				<div
					ref={hostRef}
					className="fo-show-host"
					style={{ width: slideWidth, height: slideHeight, transform: `scale(${String(fit.scale)})` }}
				/>
				{overlay === undefined ? null : (
					// Clicks go through to the slide's targets; the overlay's own controls take theirs (pointer-events: auto).
					<div
						className="fo-show-overlay"
						style={{
							width: slideWidth,
							height: slideHeight,
							transform: `scale(${String(fit.scale)})`,
							pointerEvents: "none"
						}}
					>
						{overlay}
					</div>
				)}
			</div>
			{screen === "end" && endLabel !== undefined ? (
				<div
					className="fo-show-end"
					aria-hidden="true"
				>
					{endLabel}
				</div>
			) : null}
			<div
				className="fo-show-live"
				aria-live="polite"
			>
				{screen === "end" && endLabel !== undefined ? endLabel : index === undefined ? "" : slideLabel(index, slides.length)}
			</div>
		</div>
	)
}
