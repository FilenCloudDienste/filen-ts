// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuGroup,
	ContextMenuItem,
	ContextMenuLabel,
	ContextMenuTrigger
} from "@/components/ui/context-menu"

// Menus mount inside the rows they act on, and a portaled popup still bubbles through the React tree,
// so the popup itself must keep every click (items and chrome alike) from reaching the row.

afterEach(() => {
	cleanup()
})

async function renderInRow(menu: ReactNode) {
	const onClick = vi.fn()
	const onDoubleClick = vi.fn()

	await act(async () => {
		render(
			<div
				onClick={onClick}
				onDoubleClick={onDoubleClick}
			>
				{menu}
			</div>
		)
		await Promise.resolve()
	})

	return { onClick, onDoubleClick }
}

function clickEverywhere(): void {
	for (const target of [screen.getByRole("menuitem", { name: "Item" }), screen.getByText("Label"), screen.getByRole("menu")]) {
		fireEvent.click(target)
		fireEvent.doubleClick(target)
	}
}

describe("menu popup click propagation", () => {
	it("stops dropdown popup clicks and double-clicks from reaching the row", async () => {
		const onItem = vi.fn()
		const row = await renderInRow(
			<DropdownMenu defaultOpen={true}>
				<DropdownMenuTrigger>Open</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuGroup>
						<DropdownMenuLabel>Label</DropdownMenuLabel>
						<DropdownMenuItem
							closeOnClick={false}
							onClick={onItem}
						>
							Item
						</DropdownMenuItem>
					</DropdownMenuGroup>
				</DropdownMenuContent>
			</DropdownMenu>
		)

		clickEverywhere()

		expect(onItem).toHaveBeenCalled()
		expect(row.onClick).not.toHaveBeenCalled()
		expect(row.onDoubleClick).not.toHaveBeenCalled()
	})

	it("stops context popup clicks and double-clicks from reaching the row", async () => {
		const onItem = vi.fn()
		const row = await renderInRow(
			<ContextMenu defaultOpen={true}>
				<ContextMenuTrigger>Open</ContextMenuTrigger>
				<ContextMenuContent>
					<ContextMenuGroup>
						<ContextMenuLabel>Label</ContextMenuLabel>
						<ContextMenuItem
							closeOnClick={false}
							onClick={onItem}
						>
							Item
						</ContextMenuItem>
					</ContextMenuGroup>
				</ContextMenuContent>
			</ContextMenu>
		)

		clickEverywhere()

		expect(onItem).toHaveBeenCalled()
		expect(row.onClick).not.toHaveBeenCalled()
		expect(row.onDoubleClick).not.toHaveBeenCalled()
	})
})
