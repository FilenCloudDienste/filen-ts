import { useEffect, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { SparklesIcon } from "lucide-react"
import { Kbd } from "@/lib/keymap/kbd"
import { IN_EDITORS_AND_FIELDS, useAction } from "@/lib/keymap/useAction"
import { useTransformOffered } from "@/features/assistant/store/useAssistantOnDevice"
import type { TransformHost, TransformSelection } from "@/features/assistant/transform/host"
import { TransformMenu } from "@/features/assistant/transform/transformMenu"
import type { TransformPick } from "@/features/assistant/transform/transformMenuParts"
import { TransformPopover, type TransformRequest } from "@/features/assistant/transform/transformPopover"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"

// The selection transform on a text editor (a note's editor, the chat composer): a ✨ button beside a selection and the
// app.assistantTransform key open the rewrite menu; a pick shows the result's popover. A right click keeps the
// browser's own menu (paste, spelling). Mounted with the editor; its listeners only read where a selection ends, on
// selection changes, while focus is in the editor.

const BUTTON_PX = 28

interface Anchor {
	getBoundingClientRect: () => DOMRect
}

interface MenuState {
	anchor: Anchor
	// Taken as the menu opened, before it took focus.
	selection: TransformSelection | "unsupported"
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
	// Hiding the assistant (Settings > Assistant) also closes an open menu or result, which stops its generation.
	const onDevice = useTransformOffered()
	const offered = onDevice && readOnly !== true
	const [button, setButton] = useState<{ x: number; y: number } | null>(null)
	const [menu, setMenu] = useState<MenuState | null>(null)
	const [request, setRequest] = useState<TransformRequest | null>(null)

	function open(anchor: Anchor): void {
		const selection = host.selection()

		if (selection !== null) {
			setMenu({ anchor, selection })
		}
	}

	function pick(state: MenuState, { kind, language }: TransformPick): void {
		setMenu(null)

		if (state.selection === "unsupported") {
			toast(t("assistantTransformUnsupported"))
			host.focus()

			return
		}

		setRequest({ selection: state.selection, kind, language })
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
			open(pointAnchor(rect.left, rect.bottom))
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

		document.addEventListener("selectionchange", update)
		root.addEventListener("pointerup", update)
		root.addEventListener("keyup", update)
		root.addEventListener("select", update, true)
		root.addEventListener("focusout", update)
		window.addEventListener("scroll", update, { capture: true, passive: true })
		window.addEventListener("resize", update)

		return () => {
			cancelAnimationFrame(frame)
			document.removeEventListener("selectionchange", update)
			root.removeEventListener("pointerup", update)
			root.removeEventListener("keyup", update)
			root.removeEventListener("select", update, true)
			root.removeEventListener("focusout", update)
			window.removeEventListener("scroll", update, true)
			window.removeEventListener("resize", update)
		}
	}, [root, host, offered])

	return (
		<>
			{button === null || menu !== null || request !== null || !offered
				? null
				: createPortal(
						<Tooltip>
							<TooltipTrigger
								render={
									<button
										type="button"
										aria-label={t("assistantTransformOpen")}
										data-assistant-transform-button
										className="fixed z-40 flex size-7 items-center justify-center rounded-full border bg-popover text-popover-foreground shadow-md transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
										style={{ left: button.x, top: button.y }}
										// The editor keeps its focus and selection.
										onPointerDown={event => {
											event.preventDefault()
										}}
										onClick={event => {
											const rect = event.currentTarget.getBoundingClientRect()

											open(pointAnchor(rect.left, rect.bottom))
										}}
									>
										<SparklesIcon
											aria-hidden="true"
											className="size-4"
										/>
									</button>
								}
							/>
							<TooltipContent>
								{t("assistantTransformOpen")}
								<Kbd action="app.assistantTransform" />
							</TooltipContent>
						</Tooltip>,
						document.body
					)}
			{menu === null || !onDevice ? null : (
				<TransformMenu
					anchor={menu.anchor}
					onPick={choice => {
						pick(menu, choice)
					}}
					onClose={() => {
						setMenu(null)
					}}
				/>
			)}
			{request === null || !onDevice ? null : (
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
