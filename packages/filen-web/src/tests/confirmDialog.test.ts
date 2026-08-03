import { describe, expect, it } from "vitest"
import { confirmInitialFocus } from "@/components/dialogs/confirmDialog.logic"

describe("confirmInitialFocus (ConfirmDialog destructive tier)", () => {
	it("focuses Cancel on a destructive confirm so a blind Enter cannot fire it", () => {
		expect(confirmInitialFocus(true)).toBe("cancel")
	})

	it("keeps the confirm button focused on a reversible confirm", () => {
		expect(confirmInitialFocus(false)).toBe("confirm")
	})
})
