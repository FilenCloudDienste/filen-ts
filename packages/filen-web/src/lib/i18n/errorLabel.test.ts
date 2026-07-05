import { describe, expect, it } from "vitest"
import { errorLabel } from "@/lib/i18n/errorLabel"
import type { ErrorDTO } from "@/lib/sdk/errors"

// Importing errorLabel transitively imports @/lib/i18n, which runs its i18next.init() as a module
// side effect — no separate test-side i18n bootstrap needed (node-env compatible: no DOM, no
// React render, just i18n.exists/i18n.t called directly, mirroring how errorLabel itself works).
describe("errorLabel", () => {
	it("returns the catalog translation for a kind seeded in the errors namespace", () => {
		const dto: ErrorDTO = { species: "sdk", kind: "WrongPassword", message: "wrong password", label: "wrong password" }

		expect(errorLabel(dto)).toBe("Wrong password. Please try again.")
	})

	it("falls back to labelFirst for a real SdkErrorKind that has no catalog entry", () => {
		const dto: ErrorDTO = {
			species: "sdk",
			kind: "Internal",
			message: "boom",
			serverMessage: "server said boom",
			label: "server said boom"
		}

		expect(errorLabel(dto)).toBe("server said boom")
	})

	it("falls back to labelFirst when the DTO carries no kind at all", () => {
		const dto: ErrorDTO = { species: "plain", message: "plain failure", label: "plain failure" }

		expect(errorLabel(dto)).toBe("plain failure")
	})
})
