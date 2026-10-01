// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { type MouseEvent } from "react"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu"
import { LONG_PRESS_DELAY_MS, useTouchLongPress } from "@/lib/useTouchLongPress"

interface ItemProps {
	onLongPress: () => void
	onContextMenu?: () => void
	onClick?: (pointerType: string) => void
	onDragStart?: () => void
}

// The real shape every caller has: the hook's handlers on a ContextMenuTrigger's render element, so
// these cases also prove Base UI merges them to the right of (and so before) the trigger's own.
function Item({ onLongPress, onContextMenu, onClick, onDragStart }: ItemProps) {
	const press = useTouchLongPress<HTMLDivElement>({
		onLongPress,
		...(onContextMenu ? { onContextMenu } : {})
	})

	return (
		<ContextMenu>
			<ContextMenuTrigger
				render={
					<div
						data-testid="item"
						draggable
						{...press.handlers}
						onDragStart={onDragStart}
					>
						<a
							href="#target"
							data-testid="link"
							onClick={(event: MouseEvent<HTMLAnchorElement>) => {
								onClick?.(press.pointerType(event))
							}}
						>
							name
						</a>
						<button type="button">more</button>
					</div>
				}
			/>
			<ContextMenuContent>
				<ContextMenuItem>Open</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	)
}

function item(): HTMLElement {
	return screen.getByTestId("item")
}

function pointerDown(target: Element, pointerType: string, x = 10, y = 10): void {
	fireEvent.pointerDown(target, { pointerType, pointerId: 1, isPrimary: true, clientX: x, clientY: y, button: 0 })
}

// A touch begins with both a pointerdown and a touchstart; the trigger's own long-press runs off the latter.
function touchDown(target: Element, x = 10, y = 10): void {
	pointerDown(target, "touch", x, y)
	fireEvent.touchStart(target, { touches: [{ clientX: x, clientY: y }] })
}

function wait(ms: number): void {
	act(() => {
		vi.advanceTimersByTime(ms)
	})
}

function menuOpen(): boolean {
	return screen.queryByRole("menu") !== null
}

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	cleanup()
	vi.useRealTimers()
})

describe("useTouchLongPress", () => {
	it("fires on a held touch after the delay, and the trigger's own long-press menu never opens", () => {
		const onLongPress = vi.fn()
		render(<Item onLongPress={onLongPress} />)

		touchDown(screen.getByTestId("link"))
		wait(LONG_PRESS_DELAY_MS - 1)
		expect(onLongPress).not.toHaveBeenCalled()

		wait(1)
		expect(onLongPress).toHaveBeenCalledOnce()

		wait(LONG_PRESS_DELAY_MS)
		expect(menuOpen()).toBe(false)
	})

	it("is what keeps the menu shut: the bare trigger opens it on the same press", () => {
		render(
			<ContextMenu>
				<ContextMenuTrigger render={<div data-testid="item" />} />
				<ContextMenuContent>
					<ContextMenuItem>Open</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenu>
		)

		touchDown(item())
		wait(LONG_PRESS_DELAY_MS)

		expect(menuOpen()).toBe(true)
	})

	it("never fires for a press that moves past the slop (a scroll), lifts early or is taken over", () => {
		const onLongPress = vi.fn()
		render(<Item onLongPress={onLongPress} />)

		touchDown(item())
		fireEvent.pointerMove(item(), { pointerType: "touch", pointerId: 1, clientX: 10, clientY: 25 })
		wait(LONG_PRESS_DELAY_MS)

		touchDown(item())
		fireEvent.pointerUp(item(), { pointerType: "touch", pointerId: 1 })
		wait(LONG_PRESS_DELAY_MS)

		touchDown(item())
		fireEvent.pointerCancel(item(), { pointerType: "touch", pointerId: 1 })
		wait(LONG_PRESS_DELAY_MS)

		expect(onLongPress).not.toHaveBeenCalled()
	})

	it("tolerates a jitter inside the slop", () => {
		const onLongPress = vi.fn()
		render(<Item onLongPress={onLongPress} />)

		touchDown(item())
		fireEvent.pointerMove(item(), { pointerType: "touch", pointerId: 1, clientX: 18, clientY: 4 })
		wait(LONG_PRESS_DELAY_MS)

		expect(onLongPress).toHaveBeenCalledOnce()
	})

	it("swallows the click a long-press ends in — a Link's navigation included — but not the next tap's", () => {
		const onLongPress = vi.fn()
		const onClick = vi.fn()
		render(
			<Item
				onLongPress={onLongPress}
				onClick={onClick}
			/>
		)
		const link = screen.getByTestId("link")

		touchDown(link)
		wait(LONG_PRESS_DELAY_MS)
		fireEvent.pointerUp(link, { pointerType: "touch", pointerId: 1 })

		const swallowed = new window.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })

		link.dispatchEvent(swallowed)
		expect(swallowed.defaultPrevented).toBe(true)
		expect(onClick).not.toHaveBeenCalled()

		touchDown(link)
		fireEvent.pointerUp(link, { pointerType: "touch", pointerId: 1 })
		fireEvent.click(link, { detail: 1 })
		expect(onClick).toHaveBeenCalledExactlyOnceWith("touch")
	})

	it("starts nothing for a mouse or pen, whose right-click still opens the menu through the item's own handler", () => {
		const onLongPress = vi.fn()
		const onContextMenu = vi.fn()
		render(
			<Item
				onLongPress={onLongPress}
				onContextMenu={onContextMenu}
			/>
		)

		pointerDown(item(), "mouse")
		wait(LONG_PRESS_DELAY_MS)
		pointerDown(item(), "pen")
		wait(LONG_PRESS_DELAY_MS)
		expect(onLongPress).not.toHaveBeenCalled()

		pointerDown(item(), "mouse")
		act(() => {
			fireEvent.contextMenu(item(), { clientX: 10, clientY: 10 })
		})

		expect(onContextMenu).toHaveBeenCalledOnce()
		expect(menuOpen()).toBe(true)
	})

	it("takes a touch contextmenu (Android's long-press) as the long-press: no menu, no browser menu", () => {
		const onLongPress = vi.fn()
		const onContextMenu = vi.fn()
		render(
			<Item
				onLongPress={onLongPress}
				onContextMenu={onContextMenu}
			/>
		)

		touchDown(item())
		wait(LONG_PRESS_DELAY_MS - 100)

		const contextMenu = new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true })

		act(() => {
			item().dispatchEvent(contextMenu)
		})

		expect(contextMenu.defaultPrevented).toBe(true)
		expect(onLongPress).toHaveBeenCalledOnce()
		expect(onContextMenu).not.toHaveBeenCalled()

		// The timer it replaced does not fire it a second time.
		wait(LONG_PRESS_DELAY_MS)
		expect(onLongPress).toHaveBeenCalledOnce()
		expect(menuOpen()).toBe(false)
	})

	it("starts no press on a button inside the item (the ⋯ trigger)", () => {
		const onLongPress = vi.fn()
		render(<Item onLongPress={onLongPress} />)

		touchDown(screen.getByRole("button", { name: "more" }))
		wait(LONG_PRESS_DELAY_MS)

		expect(onLongPress).not.toHaveBeenCalled()
	})

	it("cancels a native drag a touch press would start, and leaves a mouse drag alone", () => {
		const onDragStart = vi.fn()
		render(
			<Item
				onLongPress={() => undefined}
				onDragStart={onDragStart}
			/>
		)

		touchDown(item())

		const touchDrag = new window.Event("dragstart", { bubbles: true, cancelable: true })

		item().dispatchEvent(touchDrag)
		expect(touchDrag.defaultPrevented).toBe(true)
		expect(onDragStart).not.toHaveBeenCalled()

		pointerDown(item(), "mouse")
		fireEvent.dragStart(item())
		expect(onDragStart).toHaveBeenCalledOnce()
	})

	it("reports the pressing pointer for a click, and none for a keyboard one", () => {
		const onClick = vi.fn()
		render(
			<Item
				onLongPress={() => undefined}
				onClick={onClick}
			/>
		)
		const link = screen.getByTestId("link")

		pointerDown(link, "mouse")
		fireEvent.click(link, { detail: 1 })
		touchDown(link)
		fireEvent.pointerUp(link, { pointerType: "touch", pointerId: 1 })
		fireEvent.click(link, { detail: 1 })
		fireEvent.click(link, { detail: 0 })

		expect(onClick.mock.calls).toEqual([["mouse"], ["touch"], [""]])
	})

	it("clears a pending press on unmount", () => {
		const onLongPress = vi.fn()
		const { unmount } = render(<Item onLongPress={onLongPress} />)

		touchDown(item())
		unmount()
		wait(LONG_PRESS_DELAY_MS)

		expect(onLongPress).not.toHaveBeenCalled()
	})
})
