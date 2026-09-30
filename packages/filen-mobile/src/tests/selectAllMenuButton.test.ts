import { vi, describe, it, expect } from "vitest"
import { type TFunction } from "i18next"
import { selectAllMenuButton } from "@/components/ui/selectAllMenuButton"

const t = ((key: string) => key) as unknown as TFunction

describe("selectAllMenuButton", () => {
	it("selects all when not everything is selected", () => {
		const onClear = vi.fn()
		const onSelectAll = vi.fn()
		const button = selectAllMenuButton({ t, allSelected: false, onClear, onSelectAll })

		expect(button).toMatchObject({ id: "selectAll", title: "select_all", icon: "select" })

		button.onPress?.()

		expect(onSelectAll).toHaveBeenCalledOnce()
		expect(onClear).not.toHaveBeenCalled()
	})

	it("clears when everything is selected and honours a custom id", () => {
		const onClear = vi.fn()
		const onSelectAll = vi.fn()
		const button = selectAllMenuButton({ t, id: "selectAllTracks", allSelected: true, onClear, onSelectAll })

		expect(button).toMatchObject({ id: "selectAllTracks", title: "deselect_all" })

		button.onPress?.()

		expect(onClear).toHaveBeenCalledOnce()
		expect(onSelectAll).not.toHaveBeenCalled()
	})
})
