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
