import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react"

// The speaker notes under the slide: a region with a collapse toggle and a horizontal splitter that resizes it by
// pointer or keyboard (a separator with its value). Collapsed and height are controlled or uncontrolled.

export interface NotesPanelProps {
	readonly text: string
	readonly label: string
	readonly expandLabel: string
	readonly collapseLabel: string
	readonly resizeLabel: string
	readonly emptyText: string
	readonly collapsed?: boolean
	readonly defaultCollapsed?: boolean
	readonly onCollapsedChange?: (collapsed: boolean) => void
	// CSS px.
	readonly height?: number
	readonly defaultHeight?: number
	readonly onHeightChange?: (height: number) => void
	readonly minHeight?: number
	readonly maxHeight?: number
	readonly className?: string
}

export const NOTES_DEFAULT_HEIGHT = 120
export const NOTES_MIN_HEIGHT = 48
export const NOTES_MAX_HEIGHT = 480
// Keyboard resize step (px); Shift for a larger one.
const STEP = 8
const LARGE_STEP = 48

export function NotesPanel(props: NotesPanelProps) {
	const minHeight = Math.max(0, props.minHeight ?? NOTES_MIN_HEIGHT)
	const maxHeight = Math.max(minHeight, props.maxHeight ?? NOTES_MAX_HEIGHT)
	const clamp = (value: number): number => Math.round(Math.max(minHeight, Math.min(maxHeight, value)))
	const [ownCollapsed, setOwnCollapsed] = useState(props.defaultCollapsed ?? false)
	const [ownHeight, setOwnHeight] = useState(() => clamp(props.defaultHeight ?? NOTES_DEFAULT_HEIGHT))
	const collapsed = props.collapsed ?? ownCollapsed
	const height = clamp(props.height ?? ownHeight)
	const drag = useRef<{ pointer: number; startY: number; startHeight: number } | null>(null)
	const ids = useId()
	const bodyId = `${ids}-notes`
	const paragraphs = props.text.length === 0 ? [] : props.text.split("\n")

	const setCollapsed = (next: boolean): void => {
		if (props.collapsed === undefined) setOwnCollapsed(next)

		props.onCollapsedChange?.(next)
	}

	const setHeight = (next: number): void => {
		const value = clamp(next)

		if (value === height) return

		if (props.height === undefined) setOwnHeight(value)

		props.onHeightChange?.(value)
	}

	const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
		if (event.button !== 0) return

		event.preventDefault()
		event.currentTarget.setPointerCapture?.(event.pointerId)
		drag.current = { pointer: event.pointerId, startY: event.clientY, startHeight: height }
	}

	const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
		const current = drag.current

		if (current === null || current.pointer !== event.pointerId) return

		// The splitter is above the notes: dragging up makes them taller.
		setHeight(current.startHeight + (current.startY - event.clientY))
	}

	const onPointerEnd = (event: PointerEvent<HTMLDivElement>): void => {
		if (drag.current?.pointer !== event.pointerId) return

		drag.current = null
		event.currentTarget.releasePointerCapture?.(event.pointerId)
	}

	const onSeparatorKey = (event: KeyboardEvent<HTMLDivElement>): void => {
		const step = event.shiftKey ? LARGE_STEP : STEP
		const next =
			event.key === "ArrowUp"
				? height + step
				: event.key === "ArrowDown"
					? height - step
					: event.key === "Home"
						? maxHeight
						: event.key === "End"
							? minHeight
							: undefined

		if (next === undefined) return

		event.preventDefault()
		setHeight(next)
	}

	return (
		<section
			className={props.className === undefined ? "fo-notes" : `fo-notes ${props.className}`}
			aria-label={props.label}
			data-fo-collapsed={collapsed ? "" : undefined}
		>
			{collapsed ? null : (
				<div
					className="fo-notes-splitter"
					role="separator"
					aria-orientation="horizontal"
					aria-label={props.resizeLabel}
					aria-controls={bodyId}
					aria-valuemin={minHeight}
					aria-valuemax={maxHeight}
					aria-valuenow={height}
					tabIndex={0}
					onKeyDown={onSeparatorKey}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerEnd}
					onPointerCancel={onPointerEnd}
				/>
			)}
			<div className="fo-notes-header">
				<button
					type="button"
					className="fo-notes-toggle"
					aria-expanded={!collapsed}
					aria-controls={bodyId}
					onClick={() => setCollapsed(!collapsed)}
				>
					{collapsed ? props.expandLabel : props.collapseLabel}
				</button>
			</div>
			<div
				id={bodyId}
				className="fo-notes-body"
				hidden={collapsed}
				style={collapsed ? undefined : { height }}
				tabIndex={collapsed ? undefined : 0}
				role="document"
				aria-label={props.label}
			>
				{paragraphs.length === 0 ? (
					<p
						className="fo-notes-empty"
						data-fo-empty=""
					>
						{props.emptyText}
					</p>
				) : (
					paragraphs.map((paragraph, index) => (
						<p
							key={index}
							className="fo-notes-paragraph"
						>
							{paragraph}
						</p>
					))
				)}
			</div>
		</section>
	)
}
