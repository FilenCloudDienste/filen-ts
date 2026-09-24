import { describe, expect, it } from "vitest"
import { errorLabel, errorLabelOr } from "@/lib/i18n/errorLabel"
import type { ErrorDTO } from "@/lib/sdk/errors"

// Importing errorLabel transitively imports @/lib/i18n, which runs its i18next.init() as a module
// side effect — no separate test-side i18n bootstrap needed (node-env compatible: no DOM, no
// React render, just i18n.exists/i18n.t called directly, mirroring how errorLabel itself works).
describe("errorLabel", () => {
	it("returns the catalog translation for a kind seeded in the errors namespace", () => {
		const dto: ErrorDTO = { species: "sdk", kind: "WrongPassword", message: "wrong password", label: "wrong password" }

		expect(errorLabel(dto)).toBe("Wrong password. Please try again.")
	})

	it("returns the localized message for InvalidName instead of the raw Rust detail", () => {
		const dto: ErrorDTO = {
			species: "sdk",
			kind: "InvalidName",
			message: "invalid name",
			innerMessage: `invalid filename "My:File": filename contains forbidden character ':' at position 2`,
			label: "invalid name"
		}

		expect(errorLabel(dto)).toBe(
			"That name can't be used. A name can't contain \\ / : * ? \" < > |, can't start or end with a space, can't end with a dot, and must be 255 bytes or shorter."
		)
	})

	it("falls back to labelFirst for a real SdkErrorKind that has no catalog entry", () => {
		const dto: ErrorDTO = {
			species: "sdk",
			kind: "Walk",
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

	it("translates a network error instead of showing the SDK's own text", () => {
		const message = "Error of kind Reqwest: error: error sending request for url (https://gateway.filen.io/v3/upload)"
		const dto: ErrorDTO = { species: "sdk", kind: "Reqwest", message, label: message }

		expect(errorLabel(dto)).toBe("Network error. Please check your connection and try again.")
	})

	// "Server" is the kind for the server's own refusals: what it said is the reason.
	it("shows a server error's own message, and its kind's text only when the server sent none", () => {
		const message = "Error of kind Server: error: API Error"

		expect(errorLabel({ species: "sdk", kind: "Server", message, serverMessage: "Upload rejected", label: "Upload rejected" })).toBe(
			"Upload rejected"
		)
		expect(errorLabel({ species: "sdk", kind: "Server", message, label: message })).toBe(
			"The server returned an error. Please try again later."
		)
	})
})

describe("errorLabelOr", () => {
	it("takes the kind's text, then the server's message, then the fallback, never the error's own message", () => {
		const message = "Error of kind Walk: error: walk failed"

		expect(errorLabelOr({ species: "sdk", kind: "FileChunkNotFound", message, label: message }, "fallback")).toBe(
			"This file's data could not be found on the server. It may have been deleted."
		)
		expect(errorLabelOr({ species: "sdk", kind: "Walk", message, serverMessage: "said so", label: "said so" }, "fallback")).toBe(
			"said so"
		)
		expect(errorLabelOr({ species: "sdk", kind: "Walk", message, label: message }, "fallback")).toBe("fallback")
		expect(errorLabelOr({ species: "plain", message: "no authenticated client", label: "no authenticated client" }, "fallback")).toBe(
			"fallback"
		)
	})
})
