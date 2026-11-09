import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import {
	AArrowDownIcon,
	AArrowUpIcon,
	BaselineIcon,
	BoldIcon,
	HighlighterIcon,
	ItalicIcon,
	ListIcon,
	ListIndentDecreaseIcon,
	ListIndentIncreaseIcon,
	ListOrderedIcon,
	UnderlineIcon
} from "lucide-react"
import {
	type DocxEditorCommand,
	type DocxEditorCommandType,
	type DocxEditorSnapshot,
	type DocxFontChoice,
	type DocxParagraphStyle
} from "@filen/office/core/docx/edit"
import { cn } from "@filen/shared"
import {
	COMMAND_LABELS,
	STANDARD_SWATCHES,
	commandActive,
	keepFocus,
	type DocxSwatch
} from "@/features/preview/components/docxEditor.logic"
import { DocxColorButton, DocxColorGrid, FontPicker, HighlightGrid, SizePicker } from "@/features/preview/components/docxFormatControls"
import { colorsOf, textColor } from "@/features/preview/components/docxFormatControls.logic"
import { StylePicker } from "@/features/preview/components/docxEditToolbar"
import { useCommandMenuFocus } from "@/features/preview/components/docxInsert.logic"
import {
	MINI_TOOLBAR_FADED,
	hidesMiniToolbar,
	miniToolbarOpacity,
	placeMiniToolbar,
	rectDistance,
	type MiniPlacement,
	type MiniRect
} from "@/features/preview/components/docxMiniToolbar.logic"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { useLatestRef } from "@/lib/useLatestRef"

// Word's Mini toolbar: shown above a selection made with the mouse (faded until the pointer comes near it, gone as
// it moves away, on a key or a press elsewhere) and above the context menu. Mounted only while shown: its listeners,
// and the pointer's distance read on each move, exist only then. Every item is one of the editor's commands.

export interface DocxMiniToolbarRequest {
	// A selection made with the mouse, or a context menu opened with it.
	readonly kind: "selection" | "menu"
	readonly at: MiniPlacement
	// Where the pointer was as it was shown (client px).
	readonly pointer: { readonly x: number; readonly y: number }
}

export interface DocxMiniToolbarProps {
	request: DocxMiniToolbarRequest
	// The positioned element it is placed in, and the element it stays inside (with the viewport).
	container: HTMLElement
	bounds: RefObject<HTMLElement | null>
	// Its element, for the host to tell a press on it.
	elementRef: RefObject<HTMLDivElement | null>
	// The context menu it is shown with (kind "menu"), kept clear of.
	menu: () => HTMLElement | null
	// What scrolls the document: a scroll hides it.
	scroller: () => HTMLElement | null
	snapshot: DocxEditorSnapshot | undefined
	readOnly: boolean
	execute: (command: DocxEditorCommand) => void
	fonts: readonly DocxFontChoice[]
	styles: readonly DocxParagraphStyle[]
	theme: readonly (readonly DocxSwatch[])[]
	// Hidden; with focus to the document (Escape) or left where it is.
	onClose: (focusDocument: boolean) => void
}

const SIZE_STEPS: readonly { type: DocxEditorCommandType; icon: ReactNode }[] = [
	{ type: "font.grow", icon: <AArrowUpIcon /> },
	{ type: "font.shrink", icon: <AArrowDownIcon /> }
]
const TOGGLES: readonly { type: DocxEditorCommandType; icon: ReactNode }[] = [
	{ type: "format.bold", icon: <BoldIcon /> },
	{ type: "format.italic", icon: <ItalicIcon /> },
	{ type: "format.underline", icon: <UnderlineIcon /> }
]
const PARAGRAPH: readonly { type: DocxEditorCommandType; icon: ReactNode; toggle: boolean }[] = [
	{ type: "list.bullet", icon: <ListIcon />, toggle: true },
	{ type: "list.numbered", icon: <ListOrderedIcon />, toggle: true },
	{ type: "list.outdent", icon: <ListIndentDecreaseIcon />, toggle: false },
	{ type: "list.indent", icon: <ListIndentIncreaseIcon />, toggle: false }
]

// The viewport, inside `element`'s box where it has one.
function boundsOf(element: HTMLElement | null): MiniRect {
	const viewport = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }

	if (element === null) {
		return viewport
	}

	const rect = element.getBoundingClientRect()

	return {
		left: Math.max(viewport.left, rect.left),
		top: Math.max(viewport.top, rect.top),
		right: Math.min(viewport.right, rect.right),
		bottom: Math.min(viewport.bottom, rect.bottom)
	}
}

export function DocxMiniToolbar(props: DocxMiniToolbarProps) {
	const { t } = useTranslation("preview")
	const { request, snapshot, readOnly, elementRef } = props
	const focus = useCommandMenuFocus()
	const latest = useLatestRef(props)
	// The last event that passed through the toolbar's tree (its popups and tooltips are portaled).
	const insideRef = useRef<Event | null>(null)
	// Focus is in the toolbar or one of its popups: it stays, opaque.
	const focusedRef = useRef(false)
	const rectRef = useRef<MiniRect | null>(null)
	const startRef = useRef(0)
	const kind = request.kind

	// Placed once as it appears (above the line or pointer, clear of the context menu once that is placed).
	useLayoutEffect(() => {
		const element = elementRef.current

		if (element === null) {
			return
		}

		const place = (): void => {
			const { container, bounds, request: shown, menu } = latest.current
			const box = container.getBoundingClientRect()
			const own = element.getBoundingClientRect()
			const avoid = shown.kind === "menu" ? menu()?.getBoundingClientRect() : undefined
			const { left, top } = placeMiniToolbar(own.width, own.height, shown.at, boundsOf(bounds.current), avoid)

			element.style.left = `${String(left - box.left)}px`
			element.style.top = `${String(top - box.top)}px`
			rectRef.current = { left, top, right: left + own.width, bottom: top + own.height }
			startRef.current = rectDistance(rectRef.current, shown.pointer.x, shown.pointer.y)
		}

		place()

		if (latest.current.request.kind !== "menu") {
			return
		}

		// The menu is placed in the frame after it opens.
		const frame = requestAnimationFrame(place)

		return () => {
			cancelAnimationFrame(frame)
		}
	}, [elementRef, latest])

	useLayoutEffect(() => {
		const element = elementRef.current

		if (element === null) {
			return
		}

		// Faded as a selection shows it; opaque with the context menu, or once the pointer was on it (a press on it closed
		// the menu).
		element.style.opacity = kind === "selection" && !focusedRef.current && insideRef.current === null ? String(MINI_TOOLBAR_FADED) : "1"

		const close = (focusDocument: boolean): void => {
			latest.current.onClose(focusDocument)
		}
		const inside = (event: Event): boolean =>
			insideRef.current === event || (event.target instanceof Node && element.contains(event.target))
		let pending = 0
		const onMove = (event: PointerEvent): void => {
			const rect = rectRef.current

			if (kind === "menu" || event.pointerType !== "mouse" || focusedRef.current || rect === null) {
				return
			}

			const opacity = inside(event) ? 1 : miniToolbarOpacity(rectDistance(rect, event.clientX, event.clientY), startRef.current)

			if (opacity === null) {
				close(false)
			} else {
				element.style.opacity = String(opacity)
			}
		}
		// Read once the press went through React (which marks presses in the toolbar's portaled popups).
		const onDown = (event: PointerEvent): void => {
			if (kind === "menu") {
				return
			}

			window.clearTimeout(pending)
			pending = window.setTimeout(() => {
				if (!inside(event)) {
					close(false)
				}
			}, 0)
		}
		const onKey = (event: KeyboardEvent): void => {
			if (focusedRef.current || (event.target instanceof Node && element.contains(event.target)) || !hidesMiniToolbar(event.key)) {
				return
			}

			// Escape in the document hides the toolbar and does nothing else.
			if (event.key === "Escape" && kind === "selection" && !event.isComposing) {
				event.preventDefault()
				event.stopPropagation()
			}

			if (kind === "selection") {
				close(false)
			}
		}
		const onGone = (): void => {
			close(false)
		}
		const scroller = latest.current.scroller()

		window.addEventListener("pointermove", onMove, { passive: true })
		window.addEventListener("pointerdown", onDown, true)
		window.addEventListener("keydown", onKey, true)
		window.addEventListener("resize", onGone)
		scroller?.addEventListener("scroll", onGone, { passive: true })

		return () => {
			window.clearTimeout(pending)
			window.removeEventListener("pointermove", onMove)
			window.removeEventListener("pointerdown", onDown, true)
			window.removeEventListener("keydown", onKey, true)
			window.removeEventListener("resize", onGone)
			scroller?.removeEventListener("scroll", onGone)
		}
	}, [kind, elementRef, latest])

	const values = snapshot?.values
	const off = (type: DocxEditorCommandType): boolean => snapshot === undefined || readOnly || !snapshot.enabled[type]
	// Run from a picker, which gives focus back to the document once closed.
	const execute = (command: DocxEditorCommand): void => {
		props.execute(command)
		focus.ran()
	}
	const { chosenColor, chosenHighlight, colorRgb, highlightRgb } = colorsOf(values)
	const button = (type: DocxEditorCommandType, icon: ReactNode, toggle: boolean): ReactNode => {
		const label = COMMAND_LABELS[type]

		if (label === undefined) {
			return null
		}

		const active = toggle && snapshot !== undefined && commandActive(snapshot, type)

		return (
			<TooltipIconButton
				key={type}
				label={t(label)}
				disabled={off(type)}
				pressed={toggle ? active : undefined}
				className={cn(active && "bg-accent text-foreground")}
				onMouseDown={keepFocus}
				onClick={() => {
					props.execute({ type } as DocxEditorCommand)
				}}
			>
				{icon}
			</TooltipIconButton>
		)
	}

	return (
		<div
			ref={elementRef}
			role="toolbar"
			aria-label={t("previewDocxMiniToolbar")}
			data-docx-mini-toolbar={kind}
			data-preview-surface
			className="absolute top-0 left-0 z-30 flex w-max max-w-[calc(100vw-1rem)] flex-col gap-1 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md transition-opacity duration-100 select-none"
			onPointerMove={event => {
				insideRef.current = event.nativeEvent
			}}
			onPointerDown={event => {
				insideRef.current = event.nativeEvent
			}}
			onMouseDown={event => {
				// The bare background keeps the document's focus and selection.
				if (event.target === event.currentTarget) {
					event.preventDefault()
				}
			}}
			onFocus={() => {
				focusedRef.current = true

				if (elementRef.current !== null) {
					elementRef.current.style.opacity = "1"
				}
			}}
			onBlur={() => {
				focusedRef.current = false
			}}
			onKeyDown={event => {
				if (event.key === "Escape" && !event.defaultPrevented && !event.nativeEvent.isComposing) {
					event.preventDefault()
					props.onClose(true)
				}
			}}
		>
			<div className="flex flex-wrap items-center gap-0.5">
				{COMMAND_LABELS["font.family"] === undefined ? null : (
					<FontPicker
						fonts={props.fonts}
						font={values?.font ?? null}
						disabled={off("font.family")}
						execute={execute}
						focus={focus}
					/>
				)}
				{COMMAND_LABELS["font.size"] === undefined ? null : (
					<SizePicker
						size={values?.size ?? null}
						disabled={off("font.size")}
						execute={execute}
						focus={focus}
					/>
				)}
				{SIZE_STEPS.map(step => button(step.type, step.icon, false))}
				<StylePicker
					styles={props.styles}
					style={snapshot?.paragraph.style ?? null}
					styleName={snapshot?.paragraph.styleName ?? ""}
					disabled={off("style.set")}
					execute={props.execute}
				/>
			</div>
			<div className="flex flex-wrap items-center gap-0.5">
				{TOGGLES.map(toggle => button(toggle.type, toggle.icon, true))}
				{COMMAND_LABELS["color.highlight"] === undefined ? null : (
					<DocxColorButton
						label={t("previewDocxHighlightColor")}
						icon={<HighlighterIcon />}
						rgb={highlightRgb}
						disabled={off("color.highlight")}
					>
						{close => (
							<HighlightGrid
								chosen={chosenHighlight}
								onPick={name => {
									close()
									execute({ type: "color.highlight", name } as DocxEditorCommand)
								}}
							/>
						)}
					</DocxColorButton>
				)}
				{COMMAND_LABELS["color.text"] === undefined ? null : (
					<DocxColorButton
						label={t("previewDocxFontColor")}
						icon={<BaselineIcon />}
						rgb={colorRgb === "auto" ? undefined : colorRgb}
						disabled={off("color.text")}
					>
						{close => (
							<DocxColorGrid
								theme={props.theme}
								standard={STANDARD_SWATCHES}
								chosen={chosenColor}
								none={{ label: t("previewOfficeColorAutomatic"), key: "auto" }}
								onPick={swatch => {
									close()
									execute({ type: "color.text", color: textColor(swatch) })
								}}
							/>
						)}
					</DocxColorButton>
				)}
				{PARAGRAPH.map(item => button(item.type, item.icon, item.toggle))}
			</div>
		</div>
	)
}
