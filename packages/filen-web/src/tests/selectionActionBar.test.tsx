// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { TrashIcon, XIcon } from "lucide-react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { BulkActionButton, BulkActionMenuButton } from "@/components/selectionActionBar"
import "@/lib/i18n"

afterEach(() => {
	cleanup()
})

const REASON = "A note is still syncing"

async function renderSettled(node: ReactNode) {
	await act(async () => {
		render(<TooltipProvider>{node}</TooltipProvider>)
		await Promise.resolve()
	})
}

function pressEnter(element: HTMLElement): void {
	fireEvent.keyDown(element, { key: "Enter" })
	fireEvent.keyUp(element, { key: "Enter" })
}

describe("BulkActionButton", () => {
	it("keeps a disabled button with a reason focusable, described by the reason and inert", async () => {
		const onClick = vi.fn()

		await renderSettled(
			<BulkActionButton
				icon={TrashIcon}
				label="Trash"
				disabled={true}
				disabledReason={REASON}
				onClick={onClick}
			/>
		)

		const button = screen.getByRole("button", { name: "Trash" })

		expect(button).not.toHaveProperty("disabled", true)
		expect(button.getAttribute("aria-disabled")).toBe("true")
		expect(button.hasAttribute("title")).toBe(false)
		expect(button.getAttribute("aria-describedby")).not.toBeNull()
		expect(document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent).toBe(REASON)

		act(() => {
			button.focus()
		})

		expect(document.activeElement).toBe(button)

		fireEvent.click(button)
		pressEnter(button)

		expect(onClick).not.toHaveBeenCalled()
	})

	it("stays natively disabled without a reason", async () => {
		await renderSettled(
			<BulkActionButton
				icon={TrashIcon}
				label="Trash"
				disabled={true}
				onClick={vi.fn()}
			/>
		)

		const button = screen.getByRole("button", { name: "Trash" })

		expect(button).toHaveProperty("disabled", true)
		expect(button.hasAttribute("aria-describedby")).toBe(false)
	})

	it("does not describe an enabled button", async () => {
		const onClick = vi.fn()

		await renderSettled(
			<BulkActionButton
				icon={TrashIcon}
				label="Trash"
				onClick={onClick}
			/>
		)

		const button = screen.getByRole("button", { name: "Trash" })

		expect(button.hasAttribute("aria-describedby")).toBe(false)

		fireEvent.click(button)

		expect(onClick).toHaveBeenCalledTimes(1)
	})
})

describe("BulkActionMenuButton", () => {
	async function renderMenuButton(props: { disabled?: boolean; disabledReason?: string }) {
		await renderSettled(
			<BulkActionMenuButton
				icon={TrashIcon}
				label="More"
				{...props}
			>
				<DropdownMenuItem>Entry</DropdownMenuItem>
			</BulkActionMenuButton>
		)

		return screen.getByRole("button", { name: "More" })
	}

	it("keeps a disabled menu button with a reason focusable and described, and never opens its menu", async () => {
		const button = await renderMenuButton({ disabled: true, disabledReason: REASON })

		expect(button).not.toHaveProperty("disabled", true)
		expect(button.getAttribute("aria-disabled")).toBe("true")
		expect(button.hasAttribute("title")).toBe(false)
		expect(document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent).toBe(REASON)

		act(() => {
			button.focus()
		})

		expect(document.activeElement).toBe(button)

		await act(async () => {
			fireEvent.pointerDown(button)
			fireEvent.mouseDown(button)
			fireEvent.mouseUp(button)
			fireEvent.click(button)
			pressEnter(button)
			fireEvent.keyDown(button, { key: "ArrowDown" })
			await Promise.resolve()
		})

		expect(screen.queryByRole("menu")).toBeNull()
		expect(button.getAttribute("aria-expanded")).not.toBe("true")
	})

	it("opens its menu when enabled", async () => {
		const button = await renderMenuButton({})

		await act(async () => {
			fireEvent.mouseDown(button)
			fireEvent.click(button)
			await Promise.resolve()
		})

		expect(screen.getByRole("menu")).not.toBeNull()
	})

	it("stays natively disabled without a reason", async () => {
		const button = await renderMenuButton({ disabled: true })

		expect(button).toHaveProperty("disabled", true)
	})
})

describe("TooltipIconButton", () => {
	it("explains a disabled button through its accessible description instead of a title", async () => {
		const onClick = vi.fn()

		await renderSettled(
			<TooltipIconButton
				label="Clear"
				disabled={true}
				title={REASON}
				onClick={onClick}
			>
				<XIcon />
			</TooltipIconButton>
		)

		const button = screen.getByRole("button", { name: "Clear" })

		expect(button).not.toHaveProperty("disabled", true)
		expect(button.hasAttribute("title")).toBe(false)
		expect(document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent).toBe(REASON)

		fireEvent.click(button)
		pressEnter(button)

		expect(onClick).not.toHaveBeenCalled()
	})

	it("stays natively disabled without a reason", async () => {
		await renderSettled(
			<TooltipIconButton
				label="Clear"
				disabled={true}
			>
				<XIcon />
			</TooltipIconButton>
		)

		expect(screen.getByRole("button", { name: "Clear" })).toHaveProperty("disabled", true)
	})
})
