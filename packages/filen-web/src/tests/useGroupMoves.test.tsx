// @vitest-environment jsdom

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest"
import { cleanup, render } from "@testing-library/react"
import { useRef } from "react"
import { orderAttributes, useGroupMoves } from "@/features/transfers/hooks/useGroupMoves"
import { TRANSFER_GROUP, type TransferGroup } from "@/features/transfers/lib/order"

const ROW_HEIGHT = 50

interface Row {
	id: string
	group: TransferGroup
}

function List({ rows }: { rows: Row[] }) {
	const ref = useRef<HTMLUListElement>(null)

	useGroupMoves(ref)

	return (
		<ul ref={ref}>
			{rows.map(row => (
				<li
					key={row.id}
					{...orderAttributes(row.id, row.group)}
				>
					{row.id}
				</li>
			))}
		</ul>
	)
}

// jsdom lays nothing out: each row stands one row height below the one before it.
function mockRowOffsets(): void {
	const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop")

	Object.defineProperty(HTMLElement.prototype, "offsetTop", {
		configurable: true,
		get(this: HTMLElement) {
			return [...document.querySelectorAll("[data-order-id]")].indexOf(this) * ROW_HEIGHT
		}
	})
	onTestFinished(() => {
		if (original === undefined) {
			Reflect.deleteProperty(HTMLElement.prototype, "offsetTop")
		} else {
			Object.defineProperty(HTMLElement.prototype, "offsetTop", original)
		}
	})
}

function mockAnimate(): ReturnType<typeof vi.fn> {
	const animate = vi.fn()

	Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, writable: true, value: animate })
	onTestFinished(() => {
		Reflect.deleteProperty(HTMLElement.prototype, "animate")
	})

	return animate
}

function mockReducedMotion(reduced: boolean): ReturnType<typeof vi.fn> {
	const matchMedia = vi.fn((query: string) => ({ matches: reduced && query.includes("reduce") }))

	vi.stubGlobal("matchMedia", matchMedia)
	onTestFinished(() => {
		vi.unstubAllGlobals()
	})

	return matchMedia
}

const ACTIVE: Row[] = [
	{ id: "a", group: TRANSFER_GROUP.active },
	{ id: "b", group: TRANSFER_GROUP.active },
	{ id: "c", group: TRANSFER_GROUP.active }
]
const A_FAILED: Row[] = [
	{ id: "b", group: TRANSFER_GROUP.active },
	{ id: "c", group: TRANSFER_GROUP.active },
	{ id: "a", group: TRANSFER_GROUP.failed }
]

afterEach(() => {
	cleanup()
})

describe("useGroupMoves", () => {
	it("slides a row that changed group, once, from where it stood", () => {
		mockRowOffsets()
		mockReducedMotion(false)

		const animate = mockAnimate()
		const { container, rerender } = render(<List rows={ACTIVE} />)

		rerender(<List rows={A_FAILED} />)

		expect(animate).toHaveBeenCalledTimes(1)
		expect(animate.mock.contexts[0]).toBe(container.querySelector('[data-order-id="a"]'))
		expect(animate.mock.calls[0]?.[0]).toEqual([{ transform: `translate(0px, ${String(-2 * ROW_HEIGHT)}px)` }, { transform: "none" }])

		rerender(<List rows={A_FAILED} />)

		expect(animate).toHaveBeenCalledTimes(1)
	})

	it("neither animates nor asks for the motion preference on a commit that changes no group", () => {
		mockRowOffsets()

		const matchMedia = mockReducedMotion(false)
		const animate = mockAnimate()
		const { rerender } = render(<List rows={ACTIVE} />)

		rerender(<List rows={[...ACTIVE]} />)
		rerender(<List rows={[...ACTIVE]} />)

		expect(animate).not.toHaveBeenCalled()
		expect(matchMedia).not.toHaveBeenCalled()
	})

	it("moves the row without sliding it under reduced motion", () => {
		mockRowOffsets()
		mockReducedMotion(true)

		const animate = mockAnimate()
		const { container, rerender } = render(<List rows={ACTIVE} />)

		rerender(<List rows={A_FAILED} />)

		expect([...container.querySelectorAll("li")].map(row => row.textContent)).toEqual(["b", "c", "a"])
		expect(animate).not.toHaveBeenCalled()
	})
})
