// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import type { ReactElement, ReactNode } from "react"

// The real useAction + react-hotkeys-hook, with only the combo lookup pinned to the default "n".
vi.mock("@/lib/keymap/registry", () => ({ isRecordingCombo: () => false, useComboFor: () => "n" }))
vi.mock("@/lib/keymap/kbd", () => ({ Kbd: () => null }))
vi.mock("@/components/ui/tooltip", () => ({
	Tooltip: (props: { children: ReactNode }) => props.children,
	TooltipTrigger: (props: { render: ReactElement }) => props.render,
	TooltipContent: () => null
}))
// Reaches the Vite `?worker` client, unresolvable under vitest; nothing here submits.
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/features/drive/queries/drive", () => ({ driveListingQueryUpdate: vi.fn() }))
vi.mock("@/components/dialogs/inputDialog", () => ({
	InputDialog: (props: { open: boolean }) => (props.open ? <div data-testid="new-directory-dialog" /> : null)
}))

import "@/lib/i18n"
import { NewDirectory } from "@/features/drive/components/newDirectory"

function pressN(): void {
	act(() => {
		document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "n", code: "KeyN", bubbles: true }))
	})
}

afterEach(cleanup)

describe("NewDirectory shortcut", () => {
	it("opens the name dialog", () => {
		render(
			<NewDirectory
				parentUuid={null}
				dialogOpen={false}
			/>
		)
		pressN()

		expect(screen.getAllByTestId("new-directory-dialog")).toHaveLength(1)
	})

	// An empty writable listing shows the control twice: in the toolbar and in the empty state.
	it("opens one dialog when a second copy of the control is on screen without the shortcut", () => {
		render(
			<>
				<NewDirectory
					parentUuid={null}
					dialogOpen={false}
				/>
				<NewDirectory
					parentUuid={null}
					dialogOpen={false}
					shortcut={false}
				/>
			</>
		)
		pressN()

		expect(screen.getAllByTestId("new-directory-dialog")).toHaveLength(1)
	})

	it("stays shut while disabled", () => {
		render(
			<NewDirectory
				parentUuid={null}
				dialogOpen={false}
				disabled
			/>
		)
		pressN()

		expect(screen.queryByTestId("new-directory-dialog")).toBeNull()
	})
})
