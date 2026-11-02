import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react"
import { useTranslation } from "react-i18next"
import { ImageIcon, ImagePlusIcon, XIcon } from "lucide-react"
import { cn } from "@filen/shared"
import type { DeckOp, ShapeRef, SmartArtOp } from "@filen/office/core/presentation"
import type { SmartArtInfo, SmartArtNodeInfo } from "@filen/office/core/smartart"
import { Button } from "@/components/ui/button"
import { FIELD_CONTROL_CLASS } from "@/components/ui/surface"
import {
	addNodeOp,
	newNodeId,
	nodeMoves,
	runSmartArtOp,
	smartArtPane,
	useSmartArtDiagram,
	useSmartArtPicture,
	type SmartArtPicturePlaceholder
} from "@/features/presentation/components/ribbon/insertSmartArt"
import type { PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"

// The SmartArt text pane beside the slide: the selected diagram's nodes as an outline (indented by level), one field
// per node. Text is sent as one setNodeText when a field is left or typing pauses, never per key; Enter adds a node
// after (splitting the text at the caret), Tab and Shift+Tab demote and promote, Alt+Shift+Up/Down move, Backspace in
// an empty node removes it. The pane and the SmartArt Design tab share one small store (smartArtPane): whether the
// pane is open, the diagram's outline as the worker last answered it (asked again for each new render of the slide,
// never polled), the node chosen here (the Design tab's commands act on it), and the text typed but not sent yet,
// which a Design command sends first in the same undo step. The store lives beside the ribbon's group files
// (ribbon/insertSmartArt.tsx), which import nothing from here.

// Slide px per EMU (96 dpi).
const EMU_PER_PX = 9525

// Typing that pauses this long is sent.
const IDLE_MS = 700
// Indent per level, and the deepest level indented further (phone widths keep room for the text).
const INDENT_PX = 14
const MAX_INDENT_LEVELS = 6

// ---- the pane ----------------------------------------------------------------------------------------------------

const EMPTY_NODE: SmartArtNodeInfo = { id: "", level: 1, type: "node", text: "" }

interface FieldProps {
	readonly editor: PresentationRibbonEditor
	readonly target: ShapeRef
	readonly info: SmartArtInfo
	readonly index: number
	readonly keysId: string
	readonly register: (id: string, field: HTMLTextAreaElement | null) => void
	readonly onEscape: () => void
	// The node's picture placeholder, when the layout has one for it, and what picks a picture for it.
	readonly picture: SmartArtPicturePlaceholder | undefined
	readonly onPicture: (placeholder: SmartArtPicturePlaceholder) => void
}

function NodeField({ editor, target, info, index, keysId, register, onEscape, picture, onPicture }: FieldProps) {
	const { t } = useTranslation("preview")
	const node = info.nodes[index] ?? EMPTY_NODE
	const [value, setValue] = useState(node.text)
	const [seen, setSeen] = useState(node.text)
	const [focused, setFocused] = useState(false)
	// The text last sent for this node (a later answer shows it).
	const sentRef = useRef(node.text)
	const valueRef = useRef(node.text)
	const idleRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

	// A new answer shows the node's text, unless it is being typed in.
	if (seen !== node.text) {
		setSeen(node.text)

		if (!focused) setValue(node.text)
	}

	const pending = (): Extract<SmartArtOp, { readonly kind: "setNodeText" }> | undefined => {
		const text = valueRef.current

		if (text === sentRef.current) return undefined

		sentRef.current = text

		return { family: "smartart", kind: "setNodeText", target, node: node.id, text }
	}
	const stopIdle = (): void => {
		if (idleRef.current !== undefined) clearTimeout(idleRef.current)

		idleRef.current = undefined
	}
	const send = (): void => {
		stopIdle()

		const op = pending()

		if (op === undefined) return

		void editor.command(op).then(result => {
			// Refused (the shell says why): the field shows the node's text again.
			if (!result.ok && valueRef.current === op.text) {
				sentRef.current = node.text
				valueRef.current = node.text
				setValue(node.text)
			}
		})
	}
	// Ops from a key: the unsent text first, in the same undo step.
	const run = (op: SmartArtOp | undefined, focus?: { readonly node: string; readonly caret: number | "end" }): void => {
		stopIdle()

		if (op === undefined) return

		const draft = pending()
		const ops: DeckOp = draft === undefined ? op : { family: "batch", kind: "batch", ops: [draft, op] }

		void editor.command(ops).then(result => {
			if (result.ok && focus !== undefined) smartArtPane.focusNode(focus.node, focus.caret)
		})
	}

	// Unmounted while focused with typed text unsent (the selection moved on): it is sent.
	useEffect(() => {
		const id = node.id

		return () => {
			smartArtPane.releaseDraft(id, true)
		}
	}, [node.id])

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
		const field = event.currentTarget
		const moves = nodeMoves(info.nodes, index)
		const caret = field.selectionStart

		if (
			event.key === "Enter" &&
			!event.shiftKey &&
			!event.altKey &&
			!event.ctrlKey &&
			!event.metaKey &&
			!event.nativeEvent.isComposing
		) {
			event.preventDefault()

			const before = field.value.slice(0, field.selectionStart)
			const after = field.value.slice(field.selectionEnd)
			const id = newNodeId()

			valueRef.current = before
			setValue(before)
			run(addNodeOp(target, info, index, "after", id, after), { node: id, caret: 0 })

			return
		}

		if (event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey) {
			event.preventDefault()

			if (event.shiftKey ? moves.promote : moves.demote)
				run({ family: "smartart", kind: event.shiftKey ? "promote" : "demote", target, node: node.id }, { node: node.id, caret })

			return
		}

		if (event.key === "Backspace" && field.value === "" && !event.altKey && !event.ctrlKey && !event.metaKey) {
			event.preventDefault()

			const previous = info.nodes[index - 1]
			const next = info.nodes[index + 1]

			sentRef.current = ""
			run(
				{ family: "smartart", kind: "removeNode", target, node: node.id },
				previous !== undefined ? { node: previous.id, caret: "end" } : next !== undefined ? { node: next.id, caret: 0 } : undefined
			)

			return
		}

		if ((event.key === "ArrowUp" || event.key === "ArrowDown") && event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey) {
			event.preventDefault()

			const up = event.key === "ArrowUp"

			if (up ? moves.up : moves.down)
				run(
					{ family: "smartart", kind: "moveNode", target, node: node.id, direction: up ? "up" : "down" },
					{ node: node.id, caret }
				)

			return
		}

		if (event.key === "Escape") {
			event.preventDefault()
			send()
			onEscape()
		}
	}

	return (
		<li
			className="flex min-w-0 items-start gap-1.5"
			style={{ paddingInlineStart: Math.min(node.level - 1, MAX_INDENT_LEVELS) * INDENT_PX }}
		>
			<span
				aria-hidden="true"
				className="mt-3 size-1.5 shrink-0 rounded-full bg-muted-foreground"
			/>
			<textarea
				ref={field => {
					register(node.id, field)
				}}
				value={value}
				rows={value.split("\n").length}
				maxLength={10_000}
				spellCheck
				aria-label={t(node.type === "asst" ? "previewPptxSmartArtAssistantLabel" : "previewPptxSmartArtNodeLabel", {
					number: index + 1,
					level: node.level
				})}
				aria-describedby={keysId}
				placeholder={t("previewPptxSmartArtNodePlaceholder")}
				className={cn(
					FIELD_CONTROL_CLASS,
					"[field-sizing:content] min-w-0 flex-1 resize-none px-2 py-1 text-sm leading-5 placeholder:text-muted-foreground"
				)}
				onFocus={() => {
					setFocused(true)
					smartArtPane.setNode(node.id)
					smartArtPane.setDraft(node.id, pending, op => {
						void editor.command(op)
					})
				}}
				onBlur={() => {
					setFocused(false)
					smartArtPane.releaseDraft(node.id, false)
					send()
				}}
				onChange={event => {
					const text = event.target.value

					valueRef.current = text
					setValue(text)
					stopIdle()
					idleRef.current = setTimeout(send, IDLE_MS)
				}}
				onKeyDown={onKeyDown}
			/>
			{picture === undefined ? null : (
				<Button
					variant="ghost"
					size="icon-sm"
					className="mt-0.5 shrink-0"
					aria-label={t(picture.filled ? "previewPptxSmartArtPictureChangeFor" : "previewPptxSmartArtPictureInsertFor", {
						number: index + 1
					})}
					title={t(picture.filled ? "previewPptxSmartArtPictureChangeFor" : "previewPptxSmartArtPictureInsertFor", {
						number: index + 1
					})}
					onClick={() => {
						onPicture(picture)
					}}
				>
					{picture.filled ? <ImageIcon /> : <ImagePlusIcon />}
				</Button>
			)}
		</li>
	)
}

export function SmartArtTextPane({
	editor,
	editable,
	phone
}: {
	editor: PresentationRibbonEditor | undefined
	editable: boolean
	phone: boolean
}) {
	const { t } = useTranslation("preview")
	const { target, info, pane } = useSmartArtDiagram(editor)
	const pictures = useSmartArtPicture(editor)
	const fields = useRef(new Map<string, HTMLTextAreaElement>())
	const closeRef = useRef<HTMLButtonElement | null>(null)
	const keysId = useId()
	const headingId = useId()
	const focus = pane.focus

	useEffect(() => {
		if (focus === undefined) return

		const field = fields.current.get(focus.node)

		if (field === undefined) return

		field.focus({ preventScroll: false })

		const at = focus.caret === "end" ? field.value.length : Math.min(focus.caret, field.value.length)

		field.setSelectionRange(at, at)
		smartArtPane.focused()
	}, [focus, info])

	if (editor === undefined || !editable || !pane.open || target === undefined) return null

	const register = (id: string, field: HTMLTextAreaElement | null): void => {
		if (field === null) fields.current.delete(id)
		else fields.current.set(id, field)
	}

	return (
		<aside
			data-preview-surface
			aria-labelledby={headingId}
			className={cn(
				"flex min-h-0 shrink-0 flex-col bg-background",
				phone ? "max-h-[40dvh] w-full border-t border-border" : "w-60 border-r border-border lg:w-72"
			)}
		>
			<div className="flex shrink-0 items-center justify-between gap-2 border-b border-border py-1 pr-1 pl-3">
				<h2
					id={headingId}
					className="truncate text-sm font-medium"
				>
					<span className="sr-only">{t("previewPptxSmartArtTextPaneLabel")}: </span>
					{t("previewPptxSmartArtTextPaneTitle")}
				</h2>
				<Button
					ref={closeRef}
					variant="ghost"
					size="icon-sm"
					aria-label={t("previewPptxSmartArtTextPaneClose")}
					title={t("previewPptxSmartArtTextPaneClose")}
					onClick={() => {
						smartArtPane.setOpen(false)
					}}
				>
					<XIcon />
				</Button>
			</div>
			<p
				id={keysId}
				className="sr-only"
			>
				{t("previewPptxSmartArtTextPaneKeys")}
			</p>
			{info === undefined ? (
				<p
					role="status"
					className="p-3 text-sm text-muted-foreground"
				>
					{t(pane.status === "failed" ? "previewPptxSmartArtTextPaneFailed" : "previewPptxSmartArtTextPaneLoading")}
				</p>
			) : info.nodes.length === 0 ? (
				<div className="flex flex-col items-start gap-2 p-3">
					<p className="text-sm text-muted-foreground">{t("previewPptxSmartArtTextPaneEmpty")}</p>
					<Button
						variant="outline"
						size="sm"
						onClick={() => {
							const id = newNodeId()
							const op = addNodeOp(target, info, -1, "below", id)

							if (op !== undefined) void runSmartArtOp(editor, op, { node: id, caret: 0 })
						}}
					>
						{t("previewPptxSmartArtTextPaneAddFirst")}
					</Button>
				</div>
			) : (
				<ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
					{info.nodes.map((node, index) => (
						<NodeField
							key={node.id}
							editor={editor}
							target={target}
							info={info}
							index={index}
							keysId={keysId}
							register={register}
							onEscape={() => {
								closeRef.current?.focus()
							}}
							picture={info.pictures?.find(each => each.node === node.id)}
							onPicture={placeholder => {
								pictures.pick(target, placeholder)
							}}
						/>
					))}
				</ul>
			)}
		</aside>
	)
}

const PROMPT_COLOR = "rgba(255, 255, 255, 0.9)"
const PROMPT_HALO = "0 0 1px rgb(0, 0, 0), 0 0 2px rgb(0, 0, 0), 0 0 3px rgba(0, 0, 0, 0.6)"

// The selected diagram's text prompts on the slide (SlideView's overlay slot, editor only): "[Text]" where each empty
// node's text goes, as the worker last laid it out. A page overlay, so the show, thumbnails and exports never draw it,
// and nothing of it is written.
export function SmartArtPrompts({ editor, scale }: { editor: PresentationRibbonEditor; scale: number }) {
	const { t } = useTranslation("preview")
	const { target, info } = useSmartArtDiagram(editor)
	const pictures = useSmartArtPicture(editor)
	const layer =
		target === undefined ? undefined : editor.render?.layers.find(each => each.role === "smartart" && each.box?.id === target.id)
	const prompts = info?.prompts ?? []
	const empty = (info?.pictures ?? []).filter(each => !each.filled)

	if (layer === undefined || target === undefined || (prompts.length === 0 && empty.length === 0)) return null

	const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = layer.matrix

	return (
		<div
			aria-hidden="true"
			className="pointer-events-none absolute top-0 left-0 origin-top-left"
			style={{
				transform: `matrix(${String(a * scale)}, ${String(b * scale)}, ${String(c * scale)}, ${String(d * scale)}, ${String(e * scale)}, ${String(f * scale)})`
			}}
		>
			{prompts.map((box, index) => (
				<span
					key={index}
					data-smartart-prompt=""
					className="absolute flex items-center justify-center overflow-hidden text-center"
					style={{
						// Light text in a dark halo reads on any node fill (WCAG AA against the halo); the node's own
						// text colour is the file's, unknown here.
						color: PROMPT_COLOR,
						textShadow: PROMPT_HALO,
						left: box.x / EMU_PER_PX,
						top: box.y / EMU_PER_PX,
						width: box.w / EMU_PER_PX,
						height: box.h / EMU_PER_PX,
						fontSize: Math.max(6, Math.min(24, box.h / EMU_PER_PX / 3))
					}}
				>
					{t("previewPptxSmartArtNodePlaceholder")}
				</span>
			))}
			{/* A click in an empty picture placeholder picks a picture (the text pane offers the same, focusable). */}
			{empty.map(placeholder => (
				<button
					key={`${placeholder.node}:${placeholder.placeholder}`}
					type="button"
					tabIndex={-1}
					data-smartart-picture=""
					className="pointer-events-auto absolute flex cursor-pointer flex-col items-center justify-center gap-1 overflow-hidden text-center"
					style={{
						color: PROMPT_COLOR,
						textShadow: PROMPT_HALO,
						left: placeholder.x / EMU_PER_PX,
						top: placeholder.y / EMU_PER_PX,
						width: placeholder.w / EMU_PER_PX,
						height: placeholder.h / EMU_PER_PX,
						fontSize: Math.max(6, Math.min(20, placeholder.h / EMU_PER_PX / 6))
					}}
					onPointerDown={event => {
						// The slide's own selection gesture never sees this click.
						event.stopPropagation()
					}}
					onClick={event => {
						event.stopPropagation()
						pictures.pick(target, placeholder)
					}}
				>
					<ImagePlusIcon
						aria-hidden="true"
						className="size-[1.6em] drop-shadow"
					/>
					{t("previewPptxSmartArtPicturePrompt")}
				</button>
			))}
		</div>
	)
}
