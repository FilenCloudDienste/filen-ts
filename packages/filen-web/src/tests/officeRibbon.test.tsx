// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { useState } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { BoldIcon, ClipboardIcon, PilcrowIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import "@/lib/i18n"

// The office editors' ribbon on its own: tabs over one row of the selected tab's groups, the row one Tab stop that the
// arrow keys move through, groups collapsing into dropdowns and then the overflow menu as the row narrows, and Show
// tabs only (the chevron, Ctrl+F1) remembered on this device.

const size = vi.hoisted(() => ({ width: 2000 }))
const stored = vi.hoisted(() => ({ values: new Map<string, unknown>() }))

vi.mock("@/lib/useElementSize", () => ({ useElementSize: () => ({ width: size.width, height: 40 }) }))
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(stored.values.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		stored.values.set(key, value)

		return Promise.resolve()
	},
	kvDelete: () => Promise.resolve()
}))

const { OfficeCommandBar, OfficeRibbon } = await import("@/features/office/components/ribbon/officeRibbon")
const { onCommandBarF6 } = await import("@/features/office/components/ribbon/ribbonFocus")
const { setRibbonCollapsed } = await import("@/features/office/lib/ribbonSettings")

const TABS = [
	{ id: "home", label: "Home" },
	{ id: "insert", label: "Insert" },
	{ id: "table", label: "Table", contextual: true }
]

function Harness({ onCommand }: { onCommand: (name: string) => void }) {
	const [tab, setTab] = useState("home")
	const command = (name: string, disabled = false) => (
		<Button
			key={name}
			aria-label={name}
			disabled={disabled}
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
			file={<button data-ribbon-file>File</button>}
			status={<span>Status</span>}
			groups={
				tab === "home"
					? [
							{
								id: "undo",
								label: "Undo",
								icon: ClipboardIcon,
								width: 60,
								priority: Infinity,
								content: [command("Undo"), command("Redo", true)]
							},
							{
								id: "clipboard",
								label: "Clipboard",
								icon: ClipboardIcon,
								width: 200,
								priority: 2,
								content: [command("Paste"), command("Cut")]
							},
							{
								id: "font",
								label: "Font",
								icon: BoldIcon,
								width: 300,
								priority: 3,
								content: [command("Bold"), command("Italic")]
							},
							{
								id: "paragraph",
								label: "Paragraph",
								icon: PilcrowIcon,
								width: 300,
								priority: 1,
								content: [command("Center")]
							}
						]
					: [{ id: "tables", label: "Tables", icon: ClipboardIcon, width: 80, priority: 1, content: command("Table") }]
			}
		/>
	)
}

function renderRibbon() {
	const onCommand = vi.fn()

	render(<Harness onCommand={onCommand} />)

	return { onCommand }
}

function commands(): HTMLElement {
	return screen.getByRole("toolbar", { name: "Commands" })
}

afterEach(() => {
	cleanup()
	size.width = 2000
	act(() => {
		setRibbonCollapsed(false)
	})
	vi.restoreAllMocks()
})

describe("OfficeRibbon", () => {
	it("shows the File menu first, the tabs, the status and the selected tab's groups", () => {
		renderRibbon()

		const tabs = screen.getByRole("tablist", { name: "Ribbon" })

		expect(
			within(tabs)
				.getAllByRole("tab")
				.map(tab => tab.textContent)
		).toEqual(["Home", "Insert", "Table"])
		expect(screen.getByRole("tab", { name: "Home" }).getAttribute("aria-selected")).toBe("true")
		expect(screen.getByText("Status")).toBeTruthy()
		expect(
			within(commands())
				.getAllByRole("group")
				.map(group => group.getAttribute("aria-label"))
		).toEqual(["Undo", "Clipboard", "Font", "Paragraph"])

		fireEvent.click(screen.getByRole("tab", { name: "Insert" }))
		expect(within(commands()).getByRole("button", { name: "Table" })).toBeTruthy()
		// Only the selected tab's controls are there.
		expect(screen.queryByRole("button", { name: "Paste" })).toBeNull()
	})

	it("is one Tab stop the arrow keys, Home and End move through, past disabled controls", () => {
		renderRibbon()

		const row = commands()
		const stops = () =>
			within(row)
				.getAllByRole("button")
				.filter(button => button.tabIndex === 0)

		expect(stops().map(button => button.getAttribute("aria-label"))).toEqual(["Undo"])

		const undo = within(row).getByRole("button", { name: "Undo" })

		act(() => {
			undo.focus()
		})
		fireEvent.keyDown(undo, { key: "ArrowRight" })
		// Redo is off: Paste is next.
		expect(document.activeElement?.getAttribute("aria-label")).toBe("Paste")
		expect(stops().map(button => button.getAttribute("aria-label"))).toEqual(["Paste"])
		fireEvent.keyDown(document.activeElement ?? row, { key: "End" })
		expect(document.activeElement?.getAttribute("aria-label")).toBe("Center")
		fireEvent.keyDown(document.activeElement ?? row, { key: "ArrowRight" })
		expect(document.activeElement?.getAttribute("aria-label")).toBe("Undo")
		fireEvent.keyDown(document.activeElement ?? row, { key: "ArrowLeft" })
		expect(document.activeElement?.getAttribute("aria-label")).toBe("Center")
		fireEvent.keyDown(document.activeElement ?? row, { key: "Home" })
		expect(document.activeElement?.getAttribute("aria-label")).toBe("Undo")
	})

	it("collapses the lowest priority groups into a dropdown each as the row narrows, their commands closing it", async () => {
		// 860 px of groups with dividers, 584 inside the row's padding.
		size.width = 600

		const { onCommand } = renderRibbon()
		const row = commands()

		expect(within(row).queryByRole("group", { name: "Paragraph" })).toBeNull()
		expect(within(row).queryByRole("group", { name: "Clipboard" })).toBeNull()
		expect(within(row).getByRole("group", { name: "Font" })).toBeTruthy()

		fireEvent.click(within(row).getByRole("button", { name: "Clipboard" }))

		const flyout = await screen.findByRole("toolbar", { name: "Clipboard" })

		fireEvent.click(within(flyout).getByRole("button", { name: "Cut" }))
		expect(onCommand).toHaveBeenCalledWith("Cut")
		await waitFor(() => {
			expect(screen.queryByRole("toolbar", { name: "Clipboard" })).toBeNull()
		})
	})

	it("puts focus back in the document as soon as a dropdown's command runs, before the dropdown has closed", async () => {
		size.width = 600

		const page = document.createElement("div")

		page.tabIndex = -1
		document.body.append(page)
		page.focus()

		renderRibbon()
		fireEvent.click(within(commands()).getByRole("button", { name: "Clipboard" }))

		const flyout = await screen.findByRole("toolbar", { name: "Clipboard" })
		const cut = within(flyout).getByRole("button", { name: "Cut" })

		cut.focus()
		fireEvent.click(cut)

		// Keys typed straight after the command reach the document, not the closing dropdown.
		expect(document.activeElement).toBe(page)
		page.remove()
	})

	it("moves groups into the overflow menu on a phone, under their names", async () => {
		vi.spyOn(window, "matchMedia").mockImplementation(
			query =>
				({
					matches: query.includes("max-width"),
					media: query,
					addEventListener: () => undefined,
					removeEventListener: () => undefined
				}) as unknown as MediaQueryList
		)
		size.width = 360

		const { onCommand } = renderRibbon()
		const row = commands()

		// Nothing collapses on a phone.
		expect(within(row).queryByRole("button", { name: "Clipboard" })).toBeNull()
		fireEvent.click(within(row).getByRole("button", { name: "More commands" }))
		expect(await screen.findByText("Paragraph")).toBeTruthy()
		fireEvent.click(within(screen.getByRole("toolbar", { name: "Paragraph" })).getByRole("button", { name: "Center" }))
		expect(onCommand).toHaveBeenCalledWith("Center")
	})

	it("shows tabs only with the chevron or Ctrl+F1, a tab showing its commands until one runs, and remembers it", async () => {
		const { onCommand } = renderRibbon()

		fireEvent.click(screen.getByRole("button", { name: "Show tabs only" }))
		expect(screen.queryByRole("toolbar", { name: "Commands" })).toBeNull()
		await waitFor(() => {
			expect(stored.values.get("office.ribbonCollapsed.v1")).toBe(true)
		})

		// A tab shows its commands over the content.
		fireEvent.click(screen.getByRole("tab", { name: "Insert" }))
		fireEvent.click(within(await screen.findByRole("toolbar", { name: "Commands" })).getByRole("button", { name: "Table" }))
		expect(onCommand).toHaveBeenCalledWith("Table")
		await waitFor(() => {
			expect(screen.queryByRole("toolbar", { name: "Commands" })).toBeNull()
		})

		fireEvent.keyDown(window, { key: "F1", ctrlKey: true })
		expect(await screen.findByRole("toolbar", { name: "Commands" })).toBeTruthy()
		expect(screen.getByRole("button", { name: "Show tabs only" }).getAttribute("aria-pressed")).toBe("false")
		fireEvent.keyDown(window, { key: "F1", ctrlKey: true })
		expect(screen.getByRole("button", { name: "Always show the ribbon" }).getAttribute("aria-pressed")).toBe("true")
	})
})

describe("OfficeCommandBar", () => {
	function bar(file: boolean) {
		render(
			<div
				onKeyDown={event => {
					onCommandBarF6(event, () => {
						document.getElementById("content")?.focus()
					})
				}}
			>
				<OfficeCommandBar
					label="Commands"
					file={file ? <button data-ribbon-file>File</button> : undefined}
					groups={[
						{
							id: "pages",
							label: "Pages",
							icon: ClipboardIcon,
							width: 120,
							priority: Infinity,
							content: <Button aria-label="Next">Next</Button>
						},
						{
							id: "zoom",
							label: "Zoom",
							icon: ClipboardIcon,
							width: 300,
							priority: 2,
							content: <Button aria-label="Zoom in">+</Button>
						}
					]}
					status={<span>Page 1 of 3</span>}
				/>
				<div
					id="content"
					tabIndex={-1}
				/>
			</div>
		)
	}

	it("is one row: File, the groups, the status, with no tabs and no Show tabs only", () => {
		bar(true)

		const row = document.querySelector("[data-office-ribbon]")

		expect(row?.firstElementChild?.textContent).toBe("File")
		expect(row?.lastElementChild?.textContent).toBe("Page 1 of 3")
		expect(screen.queryByRole("tablist")).toBeNull()
		expect(screen.queryByRole("button", { name: "Show tabs only" })).toBeNull()
		expect(
			within(commands())
				.getAllByRole("group")
				.map(group => group.getAttribute("aria-label"))
		).toEqual(["Pages", "Zoom"])

		fireEvent.keyDown(window, { key: "F1", ctrlKey: true })
		expect(screen.getByRole("toolbar", { name: "Commands" })).toBeTruthy()
	})

	it("fits its groups as the ribbon's row does", () => {
		size.width = 250
		bar(true)

		expect(within(commands()).queryByRole("group", { name: "Zoom" })).toBeNull()
		expect(within(commands()).getByRole("group", { name: "Pages" })).toBeTruthy()
	})

	it("takes F6 to its File menu and back, or to its row's stop without one", () => {
		bar(true)
		document.getElementById("content")?.focus()
		fireEvent.keyDown(document.getElementById("content") ?? document.body, { key: "F6" })
		expect(document.activeElement?.textContent).toBe("File")
		fireEvent.keyDown(screen.getByText("File"), { key: "F6" })
		expect(document.activeElement?.id).toBe("content")
		cleanup()

		bar(false)
		fireEvent.keyDown(document.getElementById("content") ?? document.body, { key: "F6" })
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Next" }))
	})
})
