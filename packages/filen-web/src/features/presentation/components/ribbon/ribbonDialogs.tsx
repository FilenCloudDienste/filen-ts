import { Fragment, useEffect, useId, useSyncExternalStore, type ReactNode } from "react"
import type { PresentationSessionApi } from "@filen/office/dom/presentation"
import { isTextField } from "@/features/presentation/components/deckChrome.logic"
import type { PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"

// The dialog a ribbon command opens, per deck session. A command run in the ribbon's overflow (or a collapsed group's
// popup) closes that popup and unmounts the control that ran it, so the request lives here and RibbonDialogsHost,
// beside the ribbon, shows it with the live editor. While no host is mounted the asking control shows it itself.
// When the dialog closes, focus goes back to the command that opened it, or to the popup's trigger (More commands, a
// collapsed group) once the popup it ran in has closed. Home ▸ Link, Set Up Slide Show and the slide show follow the
// same rule through takeRibbonOrigin and returnRibbonFocus (or ribbonFocusTarget).

export type RibbonDialogRender = (editor: PresentationRibbonEditor, close: () => void) => ReactNode

// Where focus goes back to: the opening control (a menu's trigger for one of its items) and the trigger of the ribbon
// popup it sat in.
export interface RibbonOrigin {
	readonly control: HTMLElement | null
	readonly popup: HTMLElement | null
}

interface RibbonDialog {
	readonly key: number
	readonly owner: string
	readonly render: RibbonDialogRender
	readonly origin: RibbonOrigin
}

// The command element of the click being handled (recorded as it starts, before the command runs, and dropped once it
// is handled). The ribbon's controls keep focus where it was on a press, so focus does not say which one ran.
let clicked: HTMLElement | null = null
let recording = false

function record(event: MouseEvent): void {
	const element = event.target instanceof Element ? event.target.closest<HTMLElement>('button, [role^="menuitem"]') : null

	clicked = element
	setTimeout(() => {
		if (clicked === element) clicked = null
	}, 0)
}

function startRecording(): void {
	// Installed once, for every control and host.
	if (recording) return

	recording = true
	document.addEventListener("click", record, true)
}

function originOf(element: HTMLElement | null): RibbonOrigin {
	if (element?.isConnected !== true) return { control: null, popup: null }

	// A menu's item goes as the menu closes: its trigger stays.
	const control =
		element.closest('[role="menu"]') === null
			? element
			: document.querySelector<HTMLElement>('[aria-haspopup="menu"][aria-expanded="true"]')
	const inPopup = control?.closest("[data-ribbon-popup]") != null

	return { control, popup: inPopup ? document.querySelector<HTMLElement>('[data-ribbon-popup-trigger][aria-expanded="true"]') : null }
}

// Where the click being handled came from (nothing outside a click, as for a key).
export function takeRibbonOrigin(): RibbonOrigin {
	const origin = originOf(clicked)

	clicked = null

	return origin
}

// How long focus given back is kept in place while the ribbon refits (a show leaving full screen, a resize).
const SETTLE_MS = 1000

// The ribbon's command row and its popup triggers (popups portal outside it).
function ribbonRoot(): HTMLElement | null {
	return document.querySelector<HTMLElement>("[data-office-ribbon]")
}

// The element now in the place of `element`: itself while mounted, else the one the ribbon rendered for it since (a
// refit renders its controls again), looked up in the ribbon only.
function current(element: HTMLElement | null): HTMLElement | null {
	if (element === null || element.isConnected) return element

	const root = ribbonRoot()
	const trigger = element.getAttribute("data-ribbon-popup-trigger")
	const label = element.getAttribute("aria-label")

	if (root === null) return null
	if (trigger !== null) return root.querySelector<HTMLElement>(`[data-ribbon-popup-trigger="${CSS.escape(trigger)}"]`)

	return label === null ? null : root.querySelector<HTMLElement>(`button[aria-label="${CSS.escape(label)}"]`)
}

// The rule: the popup's trigger when the popup closed, else the control while it is there, else More commands when a
// refit has moved the control under it (null: none of them).
export function ribbonFocusTarget(origin: RibbonOrigin): HTMLElement | null {
	const popup = current(origin.popup)
	const control = current(origin.control)
	const popupClosed = popup !== null && popup.getAttribute("aria-expanded") !== "true"
	const more = origin.control === null ? null : (ribbonRoot()?.querySelector<HTMLElement>('[data-ribbon-popup-trigger="more"]') ?? null)

	return popupClosed ? popup : (control ?? popup ?? more)
}

// The focus being kept in place (a later one replaces it).
let keeping = 0

// Gives focus by the rule (`fallback` when the ribbon has nothing), then keeps it there while the ribbon refits (until
// it has been still for a moment): focus that drops to nowhere (its element rendered again), or that sits on what was
// given while the rule now names another element (the command is back in the row), is given by the rule again. Focus
// moved anywhere else stays there, and a ribbon that is gone (the editor closed) or given focus again ends it.
export function focusByRibbonRule(origin: RibbonOrigin, fallback: () => HTMLElement | null = () => null): void {
	const token = ++keeping
	const root = ribbonRoot()
	let given: HTMLElement | null = null
	let until = 0
	const give = (): void => {
		given = ribbonFocusTarget(origin) ?? fallback()
		given?.focus({ preventScroll: true })
		until = performance.now() + SETTLE_MS
	}
	const watch = (): void => {
		if (token !== keeping || root?.isConnected !== true) return

		const active = document.activeElement
		const nowhere = active === null || active === document.body

		if (!nowhere && active !== given) return

		const target = ribbonFocusTarget(origin)

		if (nowhere || (target !== null && target !== given)) give()
		if (performance.now() < until) requestAnimationFrame(watch)
	}

	give()
	requestAnimationFrame(watch)
}

// After the dialog has gone (its own focus return included), by the rule above. Focus a command moved into a field, or
// a dialog opened since (`superseded`), keeps it.
export function returnRibbonFocus(origin: RibbonOrigin, superseded: () => boolean = () => false): void {
	if (origin.control === null && origin.popup === null) return

	requestAnimationFrame(() => {
		if (superseded() || isTextField(document.activeElement)) return

		focusByRibbonRule(origin)
	})
}

interface RibbonDialogState {
	dialog: RibbonDialog | undefined
	hosts: number
	next: number
	readonly listeners: Set<() => void>
	// One per session, so React keeps its subscription across renders.
	readonly subscribe: (listener: () => void) => () => void
}

const states = new WeakMap<PresentationSessionApi, RibbonDialogState>()

function stateOf(session: PresentationSessionApi): RibbonDialogState {
	let state = states.get(session)

	if (state === undefined) {
		const listeners = new Set<() => void>()

		state = {
			dialog: undefined,
			hosts: 0,
			next: 1,
			listeners,
			subscribe: listener => {
				listeners.add(listener)

				return () => {
					listeners.delete(listener)
				}
			}
		}
		states.set(session, state)
	}

	return state
}

function changed(state: RibbonDialogState): void {
	for (const listener of state.listeners) listener()
}

// Closes the dialog `key` names (a later one stays).
function closer(state: RibbonDialogState, key: number): () => void {
	return () => {
		const dialog = state.dialog

		if (dialog?.key !== key) return

		state.dialog = undefined
		changed(state)
		returnRibbonFocus(dialog.origin, () => state.dialog !== undefined)
	}
}

function openDialog(session: PresentationSessionApi, owner: string, render: RibbonDialogRender): void {
	const state = stateOf(session)

	state.dialog = { key: state.next++, owner, render, origin: takeRibbonOrigin() }
	changed(state)
}

// A host shows the dialogs from mount to unmount.
function registerHost(session: PresentationSessionApi): () => void {
	const state = stateOf(session)

	state.hosts++
	changed(state)

	return () => {
		state.hosts--
		changed(state)
	}
}

function view(state: RibbonDialogState, editor: PresentationRibbonEditor, dialog: RibbonDialog): ReactNode {
	return <Fragment key={dialog.key}>{dialog.render(editor, closer(state, dialog.key))}</Fragment>
}

// Records which command a click ran, for a component that takes origins itself.
export function useRibbonFocusRecording(): void {
	useEffect(startRecording, [])
}

// A control's dialogs: `open` asks for one (replacing any other); `view` is where the control shows it while no host
// does.
export function useRibbonDialog(editor: PresentationRibbonEditor): { open: (render: RibbonDialogRender) => void; view: ReactNode } {
	const owner = useId()
	const state = stateOf(editor.session)

	useRibbonFocusRecording()

	const dialog = useSyncExternalStore(state.subscribe, () => state.dialog)
	const hosted = useSyncExternalStore(state.subscribe, () => state.hosts > 0)

	return {
		open: render => {
			openDialog(editor.session, owner, render)
		},
		view: hosted || dialog?.owner !== owner ? null : view(state, editor, dialog)
	}
}

// Shows the dialog a ribbon command asked for, from mount to unmount; mounted beside the ribbon.
export function RibbonDialogsHost({ editor }: { editor: PresentationRibbonEditor }) {
	const session = editor.session
	const state = stateOf(session)
	const dialog = useSyncExternalStore(state.subscribe, () => state.dialog)

	useEffect(() => registerHost(session), [session])

	return dialog === undefined ? null : view(state, editor, dialog)
}
