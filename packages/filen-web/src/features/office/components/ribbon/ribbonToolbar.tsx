import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react"
import { cn } from "@filen/shared"

// A row of ribbon controls as one Tab stop (WAI-ARIA toolbar): the arrow keys move between its controls, Home and End
// to the first and last, and Tab leaves for what follows. Which control holds the stop is kept in the DOM (roving
// tabindex), whatever renders the controls (buttons, menu and popover triggers, selects), so nothing below needs to
// know it sits in a toolbar.

// Every control; those that take part are enabled (not those in a popup opened from one: portalled elsewhere anyway).
const CONTROLS = 'button, [role="combobox"], input'

function enabled(element: HTMLElement): boolean {
	return !element.matches(":disabled") && !element.hasAttribute("data-disabled")
}

function items(root: HTMLElement): HTMLElement[] {
	return Array.from(root.querySelectorAll<HTMLElement>(CONTROLS)).filter(enabled)
}

// The control that holds the stop: the one marked while it is enabled, else the first enabled one; every other
// control is out of the Tab order, so one turned on later does not become a second stop.
function sync(root: HTMLElement): void {
	const all = Array.from(root.querySelectorAll<HTMLElement>(CONTROLS))
	const current =
		all.find(element => element.hasAttribute("data-ribbon-current") && enabled(element)) ?? all.find(element => enabled(element))

	for (const element of all) {
		element.tabIndex = element === current ? 0 : -1
	}
}

function mark(root: HTMLElement, target: HTMLElement): void {
	for (const element of root.querySelectorAll<HTMLElement>("[data-ribbon-current]")) {
		element.removeAttribute("data-ribbon-current")
	}

	target.setAttribute("data-ribbon-current", "")
	sync(root)
}

export function RibbonToolbar({ label, className, children }: { label: string; className?: string | undefined; children: ReactNode }) {
	const ref = useRef<HTMLDivElement>(null)

	useLayoutEffect(() => {
		if (ref.current !== null) {
			sync(ref.current)
		}
	})

	// Controls that mount, unmount or turn on and off with the selection (their own renders) keep one stop.
	useEffect(() => {
		const root = ref.current

		if (root === null) {
			return undefined
		}

		const observer = new MutationObserver(() => {
			sync(root)
		})

		observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "data-disabled"] })

		return () => {
			observer.disconnect()
		}
	}, [])

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
		const root = ref.current
		const target = event.target

		if (root === null || !(target instanceof HTMLElement) || event.altKey || event.ctrlKey || event.metaKey) {
			return
		}

		// Keys typed into a field are the field's.
		if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
			return
		}

		const all = items(root)
		const at = all.indexOf(target)

		if (at < 0) {
			return
		}

		const rtl = getComputedStyle(root).direction === "rtl"
		let next: number

		switch (event.key) {
			case "ArrowRight":
				next = rtl ? at - 1 : at + 1
				break
			case "ArrowLeft":
				next = rtl ? at + 1 : at - 1
				break
			case "Home":
				next = 0
				break
			case "End":
				next = all.length - 1
				break
			default:
				return
		}

		const element = all[(next + all.length) % all.length]

		if (element !== undefined) {
			event.preventDefault()
			mark(root, element)
			element.focus()
		}
	}

	return (
		<div
			ref={ref}
			role="toolbar"
			aria-label={label}
			aria-orientation="horizontal"
			className={cn("flex items-center gap-0.5", className)}
			onKeyDown={onKeyDown}
			onFocus={event => {
				const root = ref.current

				if (root !== null && event.target instanceof HTMLElement && items(root).includes(event.target)) {
					mark(root, event.target)
				}
			}}
		>
			{children}
		</div>
	)
}
