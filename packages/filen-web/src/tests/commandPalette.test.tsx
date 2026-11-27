// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useRef } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn((_options: unknown) => Promise.resolve()) }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))
vi.mock("@/lib/desktop", () => ({ isDesktopApp: () => false, desktopBridge: () => undefined }))
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate }) }))

await import("@/lib/i18n")

const { registerAllActions } = await import("@/lib/keymap/actions")
const { useAction, OUTSIDE_OVERLAYS } = await import("@/lib/keymap/useAction")
const { liveActionIds, runLiveAction, PALETTE_RUN_EVENT } = await import("@/lib/keymap/liveActions")
const { CommandPaletteHost, PaletteBody } = await import("@/features/palette/components/commandPalette")
const { resetPaletteRecent } = await import("@/features/palette/lib/paletteRun")

registerAllActions()

beforeEach(() => {
	Element.prototype.scrollIntoView = vi.fn()
	navigate.mockClear()
	resetPaletteRecent()
})

afterEach(() => {
	cleanup()
})

describe("live actions", () => {
	it("are offered while mounted and enabled, and run their handler on the focused element", () => {
		const handler = vi.fn((event: KeyboardEvent) => event.target)

		function Probe({ enabled }: { enabled: boolean }) {
			useAction("app.toggleTheme", handler, { enabled })

			return <button type="button">probe</button>
		}

		const view = render(<Probe enabled />)
		const button = screen.getByRole("button")

		expect(liveActionIds(null)).toContain("app.toggleTheme")
		expect(runLiveAction("app.toggleTheme", button)).toBe(true)
		expect(handler).toHaveBeenCalledTimes(1)
		expect(handler.mock.calls[0]?.[0].type).toBe(PALETTE_RUN_EVENT)
		expect(handler.mock.results[0]?.value).toBe(button)

		view.rerender(<Probe enabled={false} />)
		expect(liveActionIds(null)).not.toContain("app.toggleTheme")

		view.unmount()
		expect(runLiveAction("app.toggleTheme", null)).toBe(false)
	})

	it("stand down where their guard does", () => {
		const handler = vi.fn()

		function Probe() {
			useAction("app.toggleTheme", handler, OUTSIDE_OVERLAYS)

			return (
				<div
					role="dialog"
					data-open=""
				/>
			)
		}

		render(<Probe />)
		runLiveAction("app.toggleTheme", null)
		expect(handler).not.toHaveBeenCalled()
	})

	it("scoped to an element, are offered only with focus inside it", () => {
		function Probe() {
			const ref = useAction("drive.open", vi.fn())
			const outside = useRef<HTMLButtonElement>(null)

			return (
				<>
					<div ref={ref}>
						<button type="button">inside</button>
					</div>
					<button
						ref={outside}
						type="button"
					>
						outside
					</button>
				</>
			)
		}

		render(<Probe />)

		expect(liveActionIds(screen.getByText("inside"))).toContain("drive.open")
		expect(liveActionIds(screen.getByText("outside"))).not.toContain("drive.open")
	})
})

const ROWS = [
	{ key: "a", group: "navigation", title: "Cloud Drive", target: { kind: "directory", splat: "" } },
	{ key: "b", group: "actions", title: "Toggle theme", target: { kind: "action", id: "app.toggleTheme" } }
] as const

describe("PaletteBody", () => {
	function box(): HTMLInputElement {
		return screen.getByRole<HTMLInputElement>("combobox")
	}

	it("moves through the rows with the arrows and picks one with Enter", () => {
		const onPick = vi.fn()

		render(
			<PaletteBody
				items={ROWS}
				onPick={onPick}
				onClose={vi.fn()}
			/>
		)

		expect(screen.getAllByRole("option").map(option => option.getAttribute("aria-selected"))).toEqual(["true", "false"])

		fireEvent.keyDown(box(), { key: "ArrowDown" })
		expect(box().getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[1]?.id)

		fireEvent.keyDown(box(), { key: "ArrowDown" })
		fireEvent.keyDown(box(), { key: "ArrowUp" })
		fireEvent.keyDown(box(), { key: "Enter" })
		expect(onPick).toHaveBeenCalledWith(ROWS[1])
	})

	it("filters as words are typed, offers the drive search, and closes on Escape", () => {
		const onClose = vi.fn()

		render(
			<PaletteBody
				items={ROWS}
				onPick={vi.fn()}
				onClose={onClose}
			/>
		)

		fireEvent.change(box(), { target: { value: "theme" } })
		expect(screen.getAllByRole("option").map(option => option.textContent)).toEqual(["Toggle theme", "Search Cloud Drive for “theme”"])

		fireEvent.keyDown(box(), { key: "Escape" })
		expect(onClose).toHaveBeenCalled()
	})
})

describe("CommandPaletteHost", () => {
	it("opens on Mod+K and runs the picked action once closed", async () => {
		const toggle = vi.fn()

		function Page() {
			useAction("app.toggleTheme", toggle, OUTSIDE_OVERLAYS)

			return <CommandPaletteHost />
		}

		render(<Page />)

		act(() => {
			fireEvent.keyDown(document, { key: "k", code: "KeyK", ctrlKey: true })
		})

		const input = await screen.findByRole("combobox")

		fireEvent.change(input, { target: { value: "theme" } })

		const option = screen.getAllByRole("option").find(candidate => candidate.textContent.includes("Toggle theme"))

		expect(option).toBeDefined()

		act(() => {
			if (option !== undefined) {
				fireEvent.click(option)
			}
		})

		await waitFor(() => {
			expect(toggle).toHaveBeenCalledTimes(1)
		})
		expect(screen.queryByRole("combobox")).toBeNull()
	})
})
