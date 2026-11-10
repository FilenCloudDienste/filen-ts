// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render } from "@testing-library/react"
import type { ObjectKeyBindings } from "@filen/office/react/presentation"
import { PresentationShapeLayer } from "@/features/presentation/components/ribbon/arrange"
import type { PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import { clearUserCombo, setUserCombo } from "@/lib/keymap/registry"
import { registerAllActions } from "@/lib/keymap/actions"
import "@/lib/i18n"

// The slide canvas matches its object commands against the keymap as the user has it: a rebinding saved in the
// shortcuts catalog reaches the canvas live.

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))

const seen: ObjectKeyBindings[] = []

registerAllActions()

vi.mock("@filen/office/react/presentation", async importOriginal => ({
	...(await importOriginal<typeof import("@filen/office/react/presentation")>()),
	ShapeEditLayer: ({ bindings }: { bindings: ObjectKeyBindings }) => {
		seen.push(bindings)

		return null
	}
}))

afterEach(async () => {
	cleanup()
	seen.length = 0
	await clearUserCombo("presentation.objects.group")
})

describe("presentation canvas object bindings", () => {
	it("follow the user's overrides and keep one object while they are unchanged", async () => {
		const editor = {
			render: undefined,
			info: { size: { width: 960, height: 540 }, editable: true }
		} as unknown as PresentationRibbonEditor
		const view = render(
			<PresentationShapeLayer
				editor={editor}
				scale={1}
			/>
		)

		expect(seen.at(-1)?.group).toBe("mod+g")

		await act(() => setUserCombo("presentation.objects.group", "alt+g"))

		expect(seen.at(-1)?.group).toBe("alt+g")
		expect(seen.at(-1)?.ungroup).toBe("mod+shift+g")

		const before = seen.at(-1)

		view.rerender(
			<PresentationShapeLayer
				editor={editor}
				scale={2}
			/>
		)

		expect(seen.at(-1)).toBe(before)
	})
})
