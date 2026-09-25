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

export async function html5DragMove(page: Page, source: DragEndpoint, target: DragEndpoint): Promise<void> {
	const contract = await page.evaluate(
		([src, tgt]) => {
			function resolve(endpoint: { selector: string; text: string }): Element {
				const match = Array.from(document.querySelectorAll(endpoint.selector)).find(element =>
					element.textContent.includes(endpoint.text)
				)

				if (match === undefined) {
					throw new Error(`no ${endpoint.selector} element contains "${endpoint.text}"`)
				}

				return match
			}

			const srcElement = resolve(src)
			const tgtElement = resolve(tgt)
			const dataTransfer = new DataTransfer()
			const fire = (element: Element, type: string): boolean => {
				return element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }))
			}

			const draggable = srcElement.getAttribute("draggable")

			fire(srcElement, "dragstart")
			fire(tgtElement, "dragenter")

			const dropAllowed = !fire(tgtElement, "dragover")

			fire(tgtElement, "drop")
			fire(srcElement, "dragend")

			return { draggable, dropAllowed }
		},
		[source, target] as const
	)

	expect(contract.draggable).toBe("true")
	expect(contract.dropAllowed).toBe(true)
}
