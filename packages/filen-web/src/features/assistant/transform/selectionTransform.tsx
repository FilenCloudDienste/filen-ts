import { useEffect, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { SparklesIcon } from "lucide-react"
import { IN_EDITORS_AND_FIELDS, useAction } from "@/lib/keymap/useAction"
import { useLatestRef } from "@/lib/useLatestRef"
import { log } from "@/lib/log"
import { useAssistantStore } from "@/features/assistant/store/useAssistantStore"
import type { TransformHost, TransformSelection } from "@/features/assistant/transform/host"
import { transformOffered } from "@/features/assistant/transform/transform.logic"
import { TransformMenu } from "@/features/assistant/transform/transformMenu"
import type { TransformPick } from "@/features/assistant/transform/transformMenuParts"
import { TransformPopover, type TransformRequest } from "@/features/assistant/transform/transformPopover"

// The selection transform on a text editor (a note's editor, the chat composer): a ✨ button beside a selection, a
// right click on one (Shift+right click keeps the browser's menu) and the app.assistantTransform key open the rewrite
// menu; a pick shows the result's popover. Mounted with the editor; its listeners only read where a selection ends,
// on selection changes, while focus is in the editor.

const BUTTON_PX = 28

interface Anchor {
	getBoundingClientRect: () => DOMRect
}

interface MenuState {
	anchor: Anchor
	// Taken as the menu opened, before it took focus.
	selection: TransformSelection | "unsupported"
	// Opened by a right click: Cut and Copy too.
	clipboard: boolean
}

function pointAnchor(x: number, y: number): Anchor {
	return { getBoundingClientRect: () => new DOMRect(x, y, 0, 0) }
}

// The transform around an editor's own element: a box of its own (`className`), so taking the root re-renders this
// alone, never the editor beside it.
export function SelectionTransformRoot({
	host,
	readOnly,
	className,
	children
}: {
	host: TransformHost
	readOnly?: boolean
	className: string
	children: ReactNode
}) {
	const [root, setRoot] = useState<HTMLDivElement | null>(null)

	return (
		<div
			ref={setRoot}
			className={className}
		>
			{children}
			<SelectionTransform
				host={host}
				root={root}
				{...(readOnly === undefined ? {} : { readOnly })}
			/>
		</div>
	)
}

export function SelectionTransform({ host, root, readOnly }: { host: TransformHost; root: HTMLElement | null; readOnly?: boolean }) {
	const { t } = useTranslation("assistant")
	const offered = useAssistantStore(state => transformOffered(state.modelState)) && readOnly !== true
	const [button, setButton] = useState<{ x: number; y: number } | null>(null)
	const [menu, setMenu] = useState<MenuState | null>(null)
	const [request, setRequest] = useState<TransformRequest | null>(null)
	// Whether a selection existed as the secondary button went down (a Mac selects the word under a right click).
	const selectedAtPressRef = useRef(false)

	function open(anchor: Anchor, clipboard: boolean): void {
		const selection = host.selection()

		if (selection !== null) {
			setMenu({ anchor, selection, clipboard })
		}
	}

	const openRef = useLatestRef(open)

	function pick(state: MenuState, { kind, language }: TransformPick): void {
		setMenu(null)

		if (state.selection === "unsupported") {
			toast(t("assistantTransformUnsupported"))
			host.focus()

			return
		}

		setRequest({ selection: state.selection, kind, language })
	}

	// The browser's Cut and Copy, which the menu stands in for: the text the selection held, as plain text.
	function clipboard(selection: TransformSelection, cut: boolean): void {
		setMenu(null)
		navigator.clipboard.writeText(selection.text).then(
			() => {
				if (!cut || selection.replace("") === null) {
					host.focus()
				}
			},
			(e: unknown) => {
				log.warn("assistant", "clipboard write failed", e)
				toast.error(t("assistantTransformFailed"))
				host.focus()
			}
		)
	}

	useAction(
		"app.assistantTransform",
		event => {
			if (!offered || !root?.contains(document.activeElement)) {
				return
			}

			const rect = host.selectionRect()

			if (rect === null) {
				return
			}

			// Alt+J types a character on a Mac.
			event.preventDefault()
			open(pointAnchor(rect.left, rect.bottom), false)
		},
		IN_EDITORS_AND_FIELDS
	)

	useEffect(() => {
		if (root === null || !offered) {
			return
		}

		let frame = 0
		const update = () => {
			cancelAnimationFrame(frame)
			frame = requestAnimationFrame(() => {
				const rect = root.contains(document.activeElement) ? host.selectionRect() : null
				const x = rect === null ? 0 : Math.min(window.innerWidth - BUTTON_PX - 4, rect.right + 4)
				const y = rect === null ? 0 : Math.max(4, rect.top - BUTTON_PX - 4)

				setButton(previous => (rect === null ? null : previous?.x === x && previous.y === y ? previous : { x, y }))
			})
		}
		const onPointerDown = (event: PointerEvent) => {
			if (event.button === 2) {
				selectedAtPressRef.current = host.selectionRect() !== null
			}
		}
		const onContextMenu = (event: MouseEvent) => {
			const selected = selectedAtPressRef.current

			selectedAtPressRef.current = false

			if (event.shiftKey || !selected || host.selectionRect() === null) {
				return
			}

			event.preventDefault()
			openRef.current(pointAnchor(event.clientX, event.clientY), true)
		}

		document.addEventListener("selectionchange", update)
		root.addEventListener("pointerup", update)
		root.addEventListener("keyup", update)
		root.addEventListener("select", update, true)
		root.addEventListener("focusout", update)
		root.addEventListener("pointerdown", onPointerDown, true)
		root.addEventListener("contextmenu", onContextMenu)
		window.addEventListener("scroll", update, { capture: true, passive: true })
		window.addEventListener("resize", update)

		return () => {
			cancelAnimationFrame(frame)
			document.removeEventListener("selectionchange", update)
			root.removeEventListener("pointerup", update)
			root.removeEventListener("keyup", update)
			root.removeEventListener("select", update, true)
			root.removeEventListener("focusout", update)
			root.removeEventListener("pointerdown", onPointerDown, true)
			root.removeEventListener("contextmenu", onContextMenu)
			window.removeEventListener("scroll", update, true)
			window.removeEventListener("resize", update)
		}
	}, [root, host, offered, openRef])

	const menuSelection = menu?.selection

	return (
		<>
			{button === null || menu !== null || request !== null || !offered
				? null
				: createPortal(
						<button
							type="button"
							aria-label={t("assistantTransformOpen")}
							title={t("assistantTransformOpen")}
							data-assistant-transform-button
							className="fixed z-40 flex size-7 items-center justify-center rounded-full border bg-popover text-popover-foreground shadow-md transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
							style={{ left: button.x, top: button.y }}
							// The editor keeps its focus and selection.
							onPointerDown={event => {
								event.preventDefault()
							}}
							onClick={event => {
								const rect = event.currentTarget.getBoundingClientRect()

								open(pointAnchor(rect.left, rect.bottom), false)
							}}
						>
							<SparklesIcon
								aria-hidden="true"
								className="size-4"
							/>
						</button>,
						document.body
					)}
			{menu === null ? null : (
				<TransformMenu
					anchor={menu.anchor}
					onPick={choice => {
						pick(menu, choice)
					}}
					onClose={() => {
						setMenu(null)
					}}
					{...(menu.clipboard && menuSelection !== undefined && menuSelection !== "unsupported"
						? {
								clipboard: {
									cut: () => {
										clipboard(menuSelection, true)
									},
									copy: () => {
										clipboard(menuSelection, false)
									}
								}
							}
						: {})}
				/>
			)}
			{request === null ? null : (
				<TransformPopover
					request={request}
					anchor={() => root?.getBoundingClientRect() ?? null}
					onClose={applied => {
						setRequest(null)

						if (!applied) {
							host.focus()
						}
					}}
				/>
			)}
		</>
	)
}
