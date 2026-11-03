import { useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type Ref } from "react"
import { type Action, type CustomShow, type SlideRef } from "../../../core/presentation/model"
import type { PresentationSessionApi, SlideLayer, SlideRender } from "../../../dom/presentation/protocol"
import { presentationActions, type PresentationActionActivator, type PresentationActionPolicy, type PresentationJump } from "../links"
import { SlideView, type SlidePainter } from "../SlideView"
import type { ShowController, ShowEvent, ShowEventType, ShowFrom, ShowScreen } from "./controller"

// The slideshow without timing: slide after slide on a black stage, hidden slides skipped (a jump may still show
// one), black and white screens, the standard keys. It implements ShowController so the page drives it the way it
// will drive the player; every slide has one step.

export interface StaticShowProps {
	readonly slides: readonly { readonly ref: SlideRef; readonly hidden: boolean }[]
	readonly customShows: readonly CustomShow[]
	readonly renders: ReadonlyMap<SlideRef, SlideRender>
	readonly size: { readonly cx: number; readonly cy: number }
	readonly painter: SlidePainter
	readonly session?: PresentationSessionApi
	readonly from?: ShowFrom
	// The deck index on stage (the page centres its render window there).
	readonly onSlide?: (index: number) => void
	readonly onEnd: () => void
	readonly label: string
	readonly slideLabel: (index: number, count: number) => string
	// The accessible name of a clickable shape (SlideView's actionLabel).
	readonly actionLabel?: (action: Action, layer: SlideLayer) => string
	readonly actions?: PresentationActionActivator
	// Instead of `actions`: the show builds its activator from it, with jumps (next, a slide, a custom show) taken
	// by the show itself.
	readonly policy?: PresentationActionPolicy
	readonly ref?: Ref<ShowController>
}

// The deck indices a show runs through: a custom show's slides in its order, else every visible slide.
export function showSequence(
	slides: readonly { readonly ref: SlideRef; readonly hidden: boolean }[],
	customShow: CustomShow | undefined
): number[] {
	if (customShow !== undefined) {
		const indices = new Map(slides.map((slide, index) => [slide.ref, index]))

		return customShow.slides.flatMap(ref => {
			const index = indices.get(ref)

			return index === undefined ? [] : [index]
		})
	}

	const out: number[] = []

	slides.forEach((slide, index) => {
		if (!slide.hidden) out.push(index)
	})

	return out
}

type Listeners = { [T in ShowEventType]?: Set<(event: Extract<ShowEvent, { type: T }>) => void> }

interface Position {
	// Into the sequence; -1 for a slide shown by a jump outside it (`index` holds it).
	readonly step: number
	readonly index: number
}

const NEXT_KEYS = new Set(["ArrowRight", "ArrowDown", "PageDown", " ", "Enter", "n", "N"])
const PREV_KEYS = new Set(["ArrowLeft", "ArrowUp", "PageUp", "Backspace", "p", "P"])

export function StaticShow({
	slides,
	customShows,
	renders,
	size,
	painter,
	session,
	from,
	onSlide,
	onEnd,
	label,
	slideLabel,
	actionLabel,
	actions,
	policy,
	ref
}: StaticShowProps) {
	const [custom, setCustom] = useState<{ show: CustomShow; returnTo: Position | undefined } | undefined>(() => {
		const id = from !== undefined && "customShow" in from ? from.customShow : undefined
		const show = customShows.find(candidate => candidate.id === id)

		return show === undefined ? undefined : { show, returnTo: undefined }
	})
	const sequence = showSequence(slides, custom?.show)
	const [position, setPosition] = useState<Position>(() => {
		if (from !== undefined && "index" in from) {
			const step = sequence.indexOf(from.index)

			return { step, index: step === -1 ? from.index : (sequence[step] ?? 0) }
		}

		if (from !== undefined && "slide" in from) {
			const index = slides.findIndex(slide => slide.ref === from.slide)
			const step = sequence.indexOf(index)

			return { step, index: Math.max(0, index) }
		}

		return { step: 0, index: sequence[0] ?? 0 }
	})
	const [screen, setScreen] = useState<ShowScreen>("slide")
	const [ended, setEnded] = useState(sequence.length === 0)
	const [typed, setTyped] = useState("")
	const listeners = useRef<Listeners>({})
	const lastViewed = useRef<number | undefined>(undefined)
	const stageRef = useRef<HTMLDivElement | null>(null)

	const emit = (event: ShowEvent): void => {
		const set = listeners.current[event.type] as Set<(event: ShowEvent) => void> | undefined

		if (set !== undefined) for (const listener of set) listener(event)
	}

	const finish = (): void => {
		if (ended) return

		setEnded(true)
		emit({ type: "ended" })
		onEnd()
	}

	const show = (next: Position): void => {
		lastViewed.current = position.index
		setPosition(next)
		setScreen("slide")
	}

	const advance = (delta: 1 | -1): void => {
		if (screen !== "slide") {
			setScreen("slide")

			return
		}

		// From a slide outside the sequence (a jump), the next one is the one after it in the deck.
		const after = position.step === -1 ? sequence.findIndex(index => index > position.index) : -1
		const following = after === -1 ? sequence.length : after
		const step = position.step === -1 ? (delta === 1 ? following : following - 1) : position.step + delta

		if (step >= sequence.length) {
			if (custom?.returnTo !== undefined) {
				const back = custom.returnTo

				setCustom(undefined)
				show(back)

				return
			}

			finish()

			return
		}

		if (step < 0) return

		show({ step, index: sequence[step] ?? 0 })
	}

	const goto = (index: number): void => {
		if (index < 0 || index >= slides.length) return

		const step = sequence.indexOf(index)

		show({ step, index })
	}

	const internal = (target: Extract<PresentationJump, { kind: "internal" }>["jump"]): void => {
		switch (target) {
			case "next":
				advance(1)
				return
			case "previous":
				advance(-1)
				return
			case "first":
				show({ step: 0, index: sequence[0] ?? 0 })
				return
			case "last":
				show({ step: sequence.length - 1, index: sequence[sequence.length - 1] ?? 0 })
				return
			case "end":
				finish()
				return
			case "lastViewed":
				if (lastViewed.current !== undefined) goto(lastViewed.current)
		}
	}

	const jump = (target: PresentationJump): void => {
		switch (target.kind) {
			case "internal":
				internal(target.jump)
				return
			case "slide":
				goto(slides.findIndex(slide => slide.ref === target.slide))
				return
			case "customShow": {
				const found = customShows.find(candidate => candidate.id === target.id)

				if (found === undefined) return

				const indices = showSequence(slides, found)

				if (indices.length === 0) return

				setCustom({ show: found, returnTo: target.returnAfter ? position : undefined })
				show({ step: 0, index: indices[0] ?? 0 })
			}
		}
	}

	const toggle = (target: ShowScreen): void => setScreen(current => (current === target ? "slide" : target))

	useImperativeHandle(ref, (): ShowController => ({
		start: async next => {
			if (next !== undefined) {
				if ("index" in next) goto(next.index)
				else if ("slide" in next) goto(slides.findIndex(slide => slide.ref === next.slide))
				else jump({ kind: "customShow", id: next.customShow, returnAfter: false })
			}

			return sequence.length === 0 && next === undefined ? { kind: "refused", reason: "notFound" } : { kind: "started" }
		},
		next: () => advance(1),
		prev: () => advance(-1),
		goto,
		black: () => toggle("black"),
		white: () => toggle("white"),
		end: finish,
		on: (type, listener) => {
			const store = listeners.current as Record<string, Set<unknown>>
			const set = (store[type] ??= new Set())

			set.add(listener)

			return () => set.delete(listener)
		}
	}))

	const slide = slides[position.index]

	useEffect(() => {
		if (ended || slide === undefined) return

		onSlide?.(position.index)
		emit({ type: "slide", index: position.index, slide: slide.ref, step: 0, steps: 0 })
		// The stage owns the keyboard while it is shown.
		stageRef.current?.focus({ preventScroll: true })
	}, [position.index, slide?.ref, ended])

	useEffect(() => {
		emit({ type: "screen", screen })
	}, [screen])

	useEffect(() => {
		if (ended && sequence.length === 0) onEnd()
	}, [])

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
		const key = event.key
		let handled = true

		if (key === "Escape") finish()
		else if (/^[0-9]$/u.test(key)) setTyped(previous => previous + key)
		else if (key === "Enter" && typed !== "") {
			goto(Number(typed) - 1)
			setTyped("")
		} else if (NEXT_KEYS.has(key)) advance(1)
		else if (PREV_KEYS.has(key)) advance(-1)
		else if (key === "Home") show({ step: 0, index: sequence[0] ?? 0 })
		else if (key === "End") show({ step: sequence.length - 1, index: sequence[sequence.length - 1] ?? 0 })
		else if (key === "b" || key === "B" || key === ".") toggle("black")
		else if (key === "w" || key === "W" || key === ",") toggle("white")
		else handled = false

		if (key !== "Enter" && !/^[0-9]$/u.test(key) && typed !== "") setTyped("")

		if (!handled) return

		// Escape ends the show and nothing else (the preview around it stays open).
		event.preventDefault()
		event.stopPropagation()
	}

	const activator = policy === undefined ? actions : presentationActions({ ...policy, navigate: jump })

	return (
		<div
			ref={stageRef}
			className="fo-show-stage"
			role="region"
			aria-label={label}
			data-fo-screen={screen}
			tabIndex={-1}
			onKeyDown={onKeyDown}
			onClick={event => {
				if (event.button === 0 && !(event.target instanceof Element && event.target.closest("button,a,[data-fo-link]") !== null))
					advance(1)
			}}
		>
			{screen === "slide" && slide !== undefined && !ended ? (
				<SlideView
					render={renders.get(slide.ref)}
					size={size}
					painter={painter}
					{...(session === undefined ? {} : { session })}
					label={slideLabel(position.index, slides.length)}
					mode="show"
					{...(activator === undefined ? {} : { actions: activator })}
					{...(actionLabel === undefined ? {} : { actionLabel })}
					className="fo-show-slide"
				/>
			) : null}
			<div
				className="fo-show-live"
				aria-live="polite"
			>
				{slide === undefined || ended ? "" : slideLabel(position.index, slides.length)}
			</div>
		</div>
	)
}
