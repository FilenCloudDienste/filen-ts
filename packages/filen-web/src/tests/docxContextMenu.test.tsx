// @vitest-environment happy-dom

import "@/tests/support/officeKeys"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { DOCX_EDITOR_COMMANDS, NO_REVIEW, NO_VALUES, type DocxEditorSnapshot } from "@filen/office/core/docx/edit"
import "@/lib/i18n"
import type { DocxSurface } from "@/features/preview/components/docxEditor.logic"
import { DocxContextCommands } from "@/features/preview/components/docxContextMenu"
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu"

// The context menu's items where the selection is: a picture's wrap as a submenu, its crop only on the pages,
// a new comment asked for, the change at the caret accepted.

const DRAWING = { kind: "picture", resizable: true, rotation: 0 } as unknown as NonNullable<DocxEditorSnapshot["context"]["drawing"]>

function snapshot(overrides: Partial<DocxEditorSnapshot["context"]> = {}, current: string | null = null): DocxEditorSnapshot {
	return {
		version: 1,
		readOnly: false,
		readOnlyReasons: [],
		dirty: false,
		canUndo: false,
		canRedo: false,
		selection: { empty: true, from: 1, to: 1, locked: null, paragraphs: 1 },
		formats: { bold: "off", italic: "off", underline: "off", strike: "off" },
		paragraph: { style: "normal", styleName: null, align: "start", list: "none", level: null },
		values: NO_VALUES,
		context: {
			story: { kind: "body", index: 0 },
			table: null,
			drawing: null,
			control: null,
			field: null,
			link: null,
			comment: null,
			equation: null,
			...overrides
		},
		review: { ...NO_REVIEW, current, revisionCount: current === null ? 0 : 1 },
		enabled: Object.fromEntries(DOCX_EDITOR_COMMANDS.map(command => [command.type, true])) as DocxEditorSnapshot["enabled"]
	}
}

function renderMenu(state: DocxEditorSnapshot, surface: DocxSurface) {
	const execute = vi.fn()
	const requestInput = vi.fn()

	render(
		<ContextMenu open>
			<ContextMenuTrigger>target</ContextMenuTrigger>
			<ContextMenuContent>
				<DocxContextCommands
					snapshot={state}
					readOnly={false}
					execute={execute}
					requestInput={requestInput}
					surface={surface}
				/>
			</ContextMenuContent>
		</ContextMenu>
	)

	return { execute, requestInput }
}

afterEach(() => {
	cleanup()
})

describe("DocxContextCommands", () => {
	it("offers a picture's wrapping as a submenu and its crop on the pages only", async () => {
		const { execute, requestInput } = renderMenu(snapshot({ drawing: DRAWING }), "pages")

		fireEvent.click(await screen.findByRole("menuitem", { name: "Crop" }))
		expect(requestInput).toHaveBeenCalledWith("drawing.crop")
		fireEvent.click(screen.getByRole("menuitem", { name: "Wrap text" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Square" }))
		expect(execute).toHaveBeenCalledWith({ type: "drawing.wrap", mode: "square" })
		cleanup()

		renderMenu(snapshot({ drawing: DRAWING }), "reflow")
		expect(await screen.findByRole("menuitem", { name: "Wrap text" })).toBeTruthy()
		expect(screen.queryByRole("menuitem", { name: "Crop" })).toBeNull()
	})

	it("asks for a new comment's text and accepts the change at the caret", async () => {
		const { execute, requestInput } = renderMenu(snapshot({}, "7"), "pages")

		fireEvent.click(await screen.findByRole("menuitem", { name: "New comment" }))
		expect(requestInput).toHaveBeenCalledWith("comment.add")
		expect(execute).not.toHaveBeenCalled()
		fireEvent.click(screen.getByRole("menuitem", { name: "Accept change" }))
		expect(execute).toHaveBeenCalledWith({ type: "review.accept" })
	})
})
