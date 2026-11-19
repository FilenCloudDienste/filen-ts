// @vitest-environment happy-dom
import { act } from "react"
import { afterEach, describe, expect, it } from "vitest"
import type { ShapeRef, TextBody } from "../core/presentation/model"
import type { PresentationSessionApi } from "../dom/presentation/protocol"
import { createTextEditing } from "../react/presentation/edit/text/editing"
import { fakeSession, frameWithLayers, laid, mountEditor } from "./presentationTextEditorFixtures.dom"

// Typed text shows in the frame of the key: before the worker answers, the typed characters are in the painted span
// they extend and the caret is past them; the worker's page then replaces the echo.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe("presentation text echo", () => {
	afterEach(() => {
		document.body.replaceChildren()
	})

	it("paints typed text and moves the caret before the worker's layout, which then replaces the echo", async () => {
		const answers: ((value: unknown) => void)[] = []
		const frame = frameWithLayers()
		const editing = createTextEditing()
		const session = {
			...fakeSession([], []),
			layoutText: (_shape: ShapeRef, body: TextBody) =>
				new Promise(resolve => {
					answers.push(() => resolve({ ...laid(body), revision: 2 }))
				})
		} as unknown as PresentationSessionApi

		const { root } = await mountEditor(frame, { session, editing })

		const controller = editing.active
		const painted = (): string => frame.querySelector(".fo-text-edit-box .fo-docx-text")?.textContent ?? ""
		const caretX = (): number => Number.parseFloat((frame.querySelector(".fo-text-caret") as HTMLElement).style.left)
		const before = caretX()

		expect(painted()).toContain("Hello")
		act(() => {
			controller?.dispatch(controller.state.tr.insertText("ab", controller.state.doc.content.size - 1), true)
		})

		// No answer yet: the echo.
		expect(painted()).toContain("Helloab")
		expect(caretX()).toBeGreaterThan(before)

		const echoed = caretX()

		await act(async () => {
			for (const answer of answers.splice(0)) answer(undefined)
			await new Promise(resolve => setTimeout(resolve, 0))
		})

		expect(painted()).toContain("Helloab")
		expect(painted()).not.toContain("Helloabab")
		expect(caretX()).toBeCloseTo(echoed, 3)

		await act(async () => {
			root.unmount()
		})
	})
})
