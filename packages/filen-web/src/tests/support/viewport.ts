import { onTestFinished } from "vitest"

// jsdom lays nothing out. The virtualizer sizes its viewport off clientHeight and measures rows off offsetHeight,
// so both report `height` on the elements `isViewport` picks (0 elsewhere) until the test finishes.
export function mockViewportHeight(isViewport: (element: HTMLElement) => boolean, height: number): void {
	for (const property of ["offsetHeight", "clientHeight"] as const) {
		const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, property)

		Object.defineProperty(HTMLElement.prototype, property, {
			configurable: true,
			get(this: HTMLElement) {
				return isViewport(this) ? height : 0
			}
		})
		onTestFinished(() => {
			if (original === undefined) {
				Reflect.deleteProperty(HTMLElement.prototype, property)
			} else {
				Object.defineProperty(HTMLElement.prototype, property, original)
			}
		})
	}
}

// A PDF page column with room to scroll either way (jsdom's is 0 tall, every page "in view"), so its page steps are
// on: `[tabindex]` elements, the scroller, report a column taller than the view, scrolled part way, until the test
// finishes. Writes to scrollTop are dropped.
export function mockScrollablePageColumn(): void {
	const metrics = { scrollHeight: 10_000, clientHeight: 500, scrollTop: 100 }

	for (const property of ["scrollHeight", "clientHeight", "scrollTop"] as const) {
		const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, property)

		Object.defineProperty(HTMLElement.prototype, property, {
			configurable: true,
			get(this: HTMLElement) {
				return this.hasAttribute("tabindex") ? metrics[property] : 0
			},
			set() {
				// Nothing scrolls in jsdom.
			}
		})
		onTestFinished(() => {
			if (original === undefined) {
				Reflect.deleteProperty(HTMLElement.prototype, property)
			} else {
				Object.defineProperty(HTMLElement.prototype, property, original)
			}
		})
	}
}

// A scroll area `height` tall (jsdom's is 0 either way the virtualizer reads it), appended to the body, for a list
// to window against.
export function sizedScrollArea(height: number): HTMLDivElement {
	const element = document.createElement("div")

	for (const [property, value] of [
		["clientHeight", height],
		["offsetHeight", height],
		["clientWidth", 240],
		["offsetWidth", 240]
	] as const) {
		Object.defineProperty(element, property, { configurable: true, value })
	}

	document.body.appendChild(element)

	return element
}
