import type { Page } from "@playwright/test"
import { expect } from "../fixtures"
import { hitCenterOf } from "./geometry"

// HTML5 drags (the audio playlist's track rows; drive items drag on pointer events, see pointerDrag below).
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

// Drive items drag on pointer events (features/drive/lib/pointerDrag.ts), so their drags are real mouse
// drags: press on the source, move past the threshold onto the target, let go. The target must show the
// drop highlight for the drop's mode before the release (a solid ring for a move, a dashed outline for a
// copy) — the one sign it will take the drop, asserted so a target that stopped accepting fails here
// rather than as a missing write later.
async function pointerDrag(page: Page, source: DragEndpoint, target: DragEndpoint, copy: boolean): Promise<void> {
	const from = await hitCenterOf(page.locator(source.selector).filter({ hasText: source.text }).first())
	const targetElement = page.locator(target.selector).filter({ hasText: target.text }).first()
	const to = await hitCenterOf(targetElement)
	// The page's own copy modifier: Option on macOS, else Ctrl.
	const mac = await page.evaluate(() => /mac/i.test(navigator.userAgent) && !/iphone|ipad|ipod/i.test(navigator.userAgent))
	const modifier = mac ? "Alt" : "Control"

	await page.mouse.move(from.x, from.y)
	await page.mouse.down()
	await page.mouse.move(to.x, to.y, { steps: 8 })

	if (copy) {
		await page.keyboard.down(modifier)
	}

	try {
		await expect(targetElement).toHaveClass(copy ? /outline-dashed/ : /ring-primary\/60/)
	} finally {
		await page.mouse.up()

		if (copy) {
			await page.keyboard.up(modifier)
		}
	}
}

export async function pointerDragMove(page: Page, source: DragEndpoint, target: DragEndpoint): Promise<void> {
	await pointerDrag(page, source, target, false)
}

export async function pointerDragCopy(page: Page, source: DragEndpoint, target: DragEndpoint): Promise<void> {
	await pointerDrag(page, source, target, true)
}
