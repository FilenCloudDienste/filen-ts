// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useState } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { ClipboardIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import "@/lib/i18n"

// The ribbon's KeyTips: Alt+Windows shows badges on File and the tabs, a tab's letter shows its commands' badges, a
// command's tip runs it; Escape goes back a level, and a bare Alt does nothing in the browser.

const platform = vi.hoisted(() => ({ value: undefined as string | undefined }))
const stored = vi.hoisted(() => ({ values: new Map<string, unknown>() }))

vi.mock("@/lib/useElementSize", () => ({ useElementSize: () => ({ width: 2000, height: 40 }) }))
vi.mock("@/lib/desktop", () => ({ desktopPlatform: () => platform.value, desktopBridge: () => undefined }))
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(stored.values.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		stored.values.set(key, value)

		return Promise.resolve()
	},
	kvDelete: () => Promise.resolve()
}))

const { OfficeRibbon } = await import("@/features/office/components/ribbon/officeRibbon")
const { setRibbonCollapsed } = await import("@/features/office/lib/ribbonSettings")

const TABS = [
	{ id: "home", label: "Home" },
	{ id: "insert", label: "Insert" },
	{ id: "table", label: "Table", contextual: true }
]

function Harness({ onCommand }: { onCommand: (name: string) => void }) {
	const [tab, setTab] = useState("home")
	const command = (name: string) => (
		<Button
			key={name}
			aria-label={name}
			onClick={() => {
				onCommand(name)
			}}
		>
			{name}
		</Button>
	)

	return (
		<OfficeRibbon
			label="Ribbon"
			commandsLabel="Commands"
			tabs={TABS}
			tab={tab}
			onTab={setTab}
			file={
				<button
					data-ribbon-file
					onClick={() => {
						onCommand("File")
					}}
				>
					File
				</button>
			}
			groups={[
				{
					id: tab,
					label: tab,
					icon: ClipboardIcon,
					width: 100,
					priority: 1,
					content: tab === "home" ? [command("Bold"), command("Borders"), command("Paste")] : [command("Table")]
				}
			]}
		/>
	)
}

function chord(): void {
	fireEvent.keyDown(window, { key: "Alt", altKey: true })
	fireEvent.keyDown(window, { key: "Meta", altKey: true, metaKey: true })
	fireEvent.keyUp(window, { key: "Meta", altKey: true })
	fireEvent.keyUp(window, { key: "Alt" })
}

function badges(): string[] {
	return [...document.querySelectorAll("[data-ribbon-keytip]")].map(badge => badge.textContent)
}

function press(key: string, code = `Key${key.toUpperCase()}`): boolean {
	return fireEvent.keyDown(window, { key, code })
}

beforeEach(() => {
	// happy-dom lays nothing out: every target has a box.
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 20, 20))
})

afterEach(() => {
	cleanup()
	platform.value = undefined
	act(() => {
		setRibbonCollapsed(false)
	})
	vi.restoreAllMocks()
})

describe("OfficeRibbon KeyTips", () => {
	it("shows File's and the tabs' tips on Alt+Windows, then the picked tab's commands, and runs one", async () => {
		const onCommand = vi.fn()

		render(<Harness onCommand={onCommand} />)
		expect(document.querySelector("[data-ribbon-keytips]")).toBeNull()

		chord()
		await waitFor(() => {
			expect(badges()).toEqual(["F", "H", "N", "JT"])
		})

		// A key it takes does not reach the document.
		expect(press("n")).toBe(false)
		await waitFor(() => {
			expect(badges()).toEqual(["T"])
		})
		expect(screen.getByRole("tab", { name: "Insert" }).getAttribute("aria-selected")).toBe("true")

		press("t")
		expect(onCommand).toHaveBeenCalledWith("Table")
		await waitFor(() => {
			expect(document.querySelector("[data-ribbon-keytips]")).toBeNull()
		})
	})

	it("narrows by a typed prefix, and Escape goes back a level then hides them", async () => {
		const onCommand = vi.fn()

		render(<Harness onCommand={onCommand} />)
		chord()
		await waitFor(() => {
			expect(badges()).toContain("H")
		})
		press("h")
		await waitFor(() => {
			expect(badges()).toEqual(["BO", "BR", "P"])
		})
		press("b")
		await waitFor(() => {
			expect(badges()).toEqual(["BO", "BR"])
		})
		fireEvent.keyDown(window, { key: "Escape" })
		await waitFor(() => {
			expect(badges()).toEqual(["BO", "BR", "P"])
		})
		fireEvent.keyDown(window, { key: "Escape" })
		await waitFor(() => {
			expect(badges()).toEqual(["F", "H", "N", "JT"])
		})
		press("j")
		press("t")
		await waitFor(() => {
			expect(screen.getByRole("tab", { name: "Table" }).getAttribute("aria-selected")).toBe("true")
		})
		fireEvent.keyDown(window, { key: "Escape" })
		fireEvent.keyDown(window, { key: "Escape" })
		await waitFor(() => {
			expect(document.querySelector("[data-ribbon-keytips]")).toBeNull()
		})
		expect(onCommand).not.toHaveBeenCalled()
	})

	it("is hidden by a click, and a bare Alt or F10 does nothing in the browser", async () => {
		render(<Harness onCommand={vi.fn()} />)

		fireEvent.keyDown(window, { key: "Alt", altKey: true })
		fireEvent.keyUp(window, { key: "Alt" })
		fireEvent.keyDown(window, { key: "F10" })
		await new Promise(resolve => requestAnimationFrame(resolve))
		expect(document.querySelector("[data-ribbon-keytips]")).toBeNull()

		chord()
		await waitFor(() => {
			expect(badges()).toContain("H")
		})
		fireEvent.pointerDown(document.body)
		await waitFor(() => {
			expect(document.querySelector("[data-ribbon-keytips]")).toBeNull()
		})
	})

	it("takes a bare Alt and F10 in the Windows desktop shell, and shows a collapsed ribbon's row for a tab", async () => {
		platform.value = "win32"

		const onCommand = vi.fn()

		render(<Harness onCommand={onCommand} />)
		act(() => {
			setRibbonCollapsed(true)
		})
		expect(screen.queryByRole("toolbar", { name: "Commands" })).toBeNull()

		fireEvent.keyDown(window, { key: "F10" })
		await waitFor(() => {
			expect(badges()).toContain("H")
		})
		fireEvent.keyDown(window, { key: "F10" })
		await waitFor(() => {
			expect(document.querySelector("[data-ribbon-keytips]")).toBeNull()
		})

		fireEvent.keyDown(window, { key: "Alt", altKey: true })
		fireEvent.keyUp(window, { key: "Alt" })
		await waitFor(() => {
			expect(badges()).toContain("H")
		})
		press("h")
		await waitFor(() => {
			expect(badges()).toEqual(["BO", "BR", "P"])
		})
		expect(screen.getByRole("toolbar", { name: "Commands" })).toBeTruthy()
		press("p")
		expect(onCommand).toHaveBeenCalledWith("Paste")
	})
})
