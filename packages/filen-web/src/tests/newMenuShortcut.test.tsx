// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import type { ReactElement, ReactNode } from "react"

// The real useAction + react-hotkeys-hook, with only the combo lookup pinned to the default "n".
vi.mock("@/lib/keymap/registry", () => ({ isRecordingCombo: () => false, useComboFor: () => "n" }))
vi.mock("@/components/ui/dropdown-menu", () => ({
	DropdownMenu: (props: { children: ReactNode }) => props.children,
	DropdownMenuTrigger: (props: { render: ReactElement }) => props.render,
	DropdownMenuContent: () => null
}))
vi.mock("@/features/drive/components/destinationMenu", () => ({ DestinationEntries: () => null }))
vi.mock("@/features/drive/components/directoryTreeSubmenu", () => ({ CONTEXT_TREE_MENU_FAMILY: {}, DROPDOWN_TREE_MENU_FAMILY: {} }))
vi.mock("@/features/drive/hooks/useUploadMenuActions", () => ({
	useUploadMenuActions: () => ({
		newTextFile: vi.fn(),
		newOffice: vi.fn(),
		pickFiles: vi.fn(),
		pickDirectory: vi.fn(),
		busy: false,
		host: null
	})
}))
vi.mock("@/features/drive/queries/drive", () => ({ driveListingQueryUpdate: vi.fn() }))
vi.mock("@/components/dialogs/inputDialog", () => ({
	InputDialog: (props: { open: boolean }) => (props.open ? <div data-testid="new-directory-dialog" /> : null)
}))

import "@/lib/i18n"
import { NewMenu } from "@/features/drive/components/uploadMenu"

function pressN(): void {
	act(() => {
		document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "n", code: "KeyN", bubbles: true }))
	})
}

afterEach(cleanup)

describe("NewMenu new-directory shortcut", () => {
	it("opens the name dialog", () => {
		render(
			<NewMenu
				parentUuid={null}
				openPreview={vi.fn()}
			/>
		)
		pressN()

		expect(screen.getAllByTestId("new-directory-dialog")).toHaveLength(1)
	})

	// An empty writable listing shows the menu twice: in the toolbar and in the empty state.
	it("opens one dialog when a second copy of the menu is on screen without the shortcut", () => {
		render(
			<>
				<NewMenu
					parentUuid={null}
					openPreview={vi.fn()}
				/>
				<NewMenu
					openPreview={vi.fn()}
					parentUuid={null}
					shortcut={false}
				/>
			</>
		)
		pressN()

		expect(screen.getAllByTestId("new-directory-dialog")).toHaveLength(1)
	})

	it("stays shut while disabled", () => {
		render(
			<NewMenu
				openPreview={vi.fn()}
				parentUuid={null}
				disabled
			/>
		)
		pressN()

		expect(screen.queryByTestId("new-directory-dialog")).toBeNull()
	})

	it("stays shut while a dialog is open", () => {
		const dialog = document.createElement("div")
		dialog.setAttribute("role", "dialog")
		dialog.setAttribute("data-open", "")
		document.body.append(dialog)
		render(
			<NewMenu
				parentUuid={null}
				openPreview={vi.fn()}
			/>
		)
		pressN()
		dialog.remove()

		expect(screen.queryByTestId("new-directory-dialog")).toBeNull()
	})
})
