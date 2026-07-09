import { describe, expect, it } from "vitest"
import { isTextEditingTarget } from "@/components/preview/preview-overlay.logic"

// Minimal duck-typed stand-in for a DOM EventTarget — no jsdom/happy-dom in this project
// (vitest.config.ts: environment "node"), mirroring lib/auth/referral.test.ts's own stubbed `document`
// idiom for the same reason.
function fakeTarget(closestResult: object | null): EventTarget {
	return { closest: (_selector: string) => closestResult } as unknown as EventTarget
}

describe("isTextEditingTarget", () => {
	it("is false for a null target", () => {
		expect(isTextEditingTarget(null)).toBe(false)
	})

	it("is false for a target with no closest method at all (not element-shaped)", () => {
		expect(isTextEditingTarget({} as unknown as EventTarget)).toBe(false)
	})

	it("is false when closest finds no enclosing .cm-editor", () => {
		expect(isTextEditingTarget(fakeTarget(null))).toBe(false)
	})

	it("is true once closest resolves a .cm-editor ancestor — editable or read-only alike", () => {
		expect(isTextEditingTarget(fakeTarget({}))).toBe(true)
	})

	it("queries exactly .cm-editor, not a broader or unrelated selector", () => {
		let queried: string | undefined
		const target = {
			closest: (selector: string) => {
				queried = selector
				return {}
			}
		} as unknown as EventTarget

		isTextEditingTarget(target)

		expect(queried).toBe(".cm-editor")
	})
})
