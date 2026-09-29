import type { Page } from "@playwright/test"
import { expect } from "../fixtures"

// Drives the exact browser event sequence a native HTML5 drag produces: one shared DataTransfer
// threaded through dragstart → dragenter → dragover → drop → dragend, dispatched on the real
// row/target elements so React's own onDragStart/onDrop handlers (and the module-level payload they
// set/read) run end-to-end.
//
// A dispatched sequence fires the handlers whether or not a real browser would ever have reached them,
// so the two gates a real drag has to clear first are asserted rather than assumed: the source must
// carry draggable="true" (nothing else starts a drag), and the target must cancel dragover (nothing
// else permits a drop) — dispatchEvent returning false IS that cancellation. Without them, a row that
// stopped being draggable or a target that stopped calling preventDefault would leave this green while
// the feature is dead for users.
//
// Both endpoints are resolved INSIDE the page, in the same synchronous turn that dispatches on them,
// rather than passed in as element handles: a background refetch re-renders the listing and detaches
// whatever a handle was pointing at, and the six events would then land on elements no longer in the
// document (silently — a detached node still dispatches).
export interface DragEndpoint {
	selector: string
	text: string
}

// `copy` holds the page's own copy modifier (Option on macOS, else Ctrl) from dragenter on, the way a
// user presses it once the drag is under way.
async function html5Drag(
	page: Page,
	source: DragEndpoint,
	target: DragEndpoint,
	copy: boolean
): Promise<{ draggable: string | null; dropAllowed: boolean; dropEffect: string }> {
	return page.evaluate(
		([src, tgt, withCopy]) => {
			function resolve(endpoint: { selector: string; text: string }): Element {
				const match = Array.from(document.querySelectorAll(endpoint.selector)).find(element =>
					element.textContent.includes(endpoint.text)
				)

				if (match === undefined) {
					throw new Error(`no ${endpoint.selector} element contains "${endpoint.text}"`)
				}

				return match
			}

			const mac = /mac/i.test(navigator.userAgent) && !/iphone|ipad|ipod/i.test(navigator.userAgent)
			const srcElement = resolve(src)
			const tgtElement = resolve(tgt)
			const dataTransfer = new DataTransfer()
			const fire = (element: Element, type: string, modifier: boolean): boolean =>
				element.dispatchEvent(
					new DragEvent(type, {
						bubbles: true,
						cancelable: true,
						dataTransfer,
						altKey: modifier && mac,
						ctrlKey: modifier && !mac
					})
				)

			// A synthetic transfer outside a real drag session drops what the handler writes to its drop
			// effect, so the write itself is recorded.
			let dropEffect = "unset"

			Object.defineProperty(dataTransfer, "dropEffect", {
				get: () => dropEffect,
				set: (value: string) => {
					dropEffect = value
				}
			})

			const draggable = srcElement.getAttribute("draggable")

			fire(srcElement, "dragstart", false)
			fire(tgtElement, "dragenter", withCopy)

			const dropAllowed = !fire(tgtElement, "dragover", withCopy)

			fire(tgtElement, "drop", withCopy)
			fire(srcElement, "dragend", withCopy)

			return { draggable, dropAllowed, dropEffect }
		},
		[source, target, copy] as const
	)
}

export async function html5DragMove(page: Page, source: DragEndpoint, target: DragEndpoint): Promise<void> {
	const contract = await html5Drag(page, source, target, false)

	expect(contract.draggable).toBe("true")
	expect(contract.dropAllowed).toBe(true)
}

// The copy variant: the target must also accept the drop AS a copy.
export async function html5DragCopy(page: Page, source: DragEndpoint, target: DragEndpoint): Promise<void> {
	const contract = await html5Drag(page, source, target, true)

	expect(contract.draggable).toBe("true")
	expect(contract.dropAllowed).toBe(true)
	expect(contract.dropEffect).toBe("copy")
}
