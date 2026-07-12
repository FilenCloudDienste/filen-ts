import { describe, expect, it } from "vitest"
import type { Personal } from "@filen/sdk-rs"
import {
	personalToFormState,
	formStateToUpdateInfo,
	isPersonalFormDirty,
	PERSONAL_FIELD_ORDER
} from "@/features/settings/components/account/personalInfoCard.logic"

function emptyPersonal(): Personal {
	return {
		firstName: undefined,
		lastName: undefined,
		companyName: undefined,
		vatId: undefined,
		street: undefined,
		streetNumber: undefined,
		city: undefined,
		postalCode: undefined,
		country: undefined
	}
}

describe("personalToFormState", () => {
	it("maps every undefined field to an empty string", () => {
		expect(personalToFormState(emptyPersonal())).toEqual({
			firstName: "",
			lastName: "",
			companyName: "",
			vatId: "",
			street: "",
			streetNumber: "",
			city: "",
			postalCode: "",
			country: ""
		})
	})

	it("passes populated fields through verbatim", () => {
		const personal: Personal = { ...emptyPersonal(), firstName: "Jane", country: "Germany" }

		expect(personalToFormState(personal)).toMatchObject({ firstName: "Jane", country: "Germany" })
	})

	it("folds a country outside the closed list (legacy free-text data) to unset", () => {
		const personal: Personal = { ...emptyPersonal(), country: "DE" }

		expect(personalToFormState(personal)).toMatchObject({ country: "" })
	})
})

describe("formStateToUpdateInfo", () => {
	it("trims whitespace and folds a blank field to undefined, never an empty string", () => {
		const form = personalToFormState(emptyPersonal())
		form.firstName = "  Jane  "
		form.lastName = "   "

		expect(formStateToUpdateInfo(form)).toMatchObject({ firstName: "Jane", lastName: undefined })
	})

	it("round-trips a fully populated form", () => {
		const form = personalToFormState({
			firstName: "Jane",
			lastName: "Doe",
			companyName: "Filen",
			vatId: "DE123",
			street: "Main St",
			streetNumber: "1",
			city: "Berlin",
			postalCode: "10115",
			country: "Germany"
		})

		expect(formStateToUpdateInfo(form)).toEqual({
			firstName: "Jane",
			lastName: "Doe",
			companyName: "Filen",
			vatId: "DE123",
			street: "Main St",
			streetNumber: "1",
			city: "Berlin",
			postalCode: "10115",
			country: "Germany"
		})
	})
})

describe("PERSONAL_FIELD_ORDER", () => {
	it("lists all 9 UserPersonalUpdateInfo fields, no duplicates", () => {
		expect(PERSONAL_FIELD_ORDER).toHaveLength(9)
		expect(new Set(PERSONAL_FIELD_ORDER).size).toBe(9)
	})
})

describe("isPersonalFormDirty", () => {
	it("is false when the form is identical to the initial snapshot", () => {
		const form = personalToFormState(emptyPersonal())

		expect(isPersonalFormDirty(form, form)).toBe(false)
		expect(isPersonalFormDirty({ ...form }, { ...form })).toBe(false)
	})

	it("is true when any single field differs", () => {
		const initial = personalToFormState(emptyPersonal())
		const form = { ...initial, city: "Berlin" }

		expect(isPersonalFormDirty(form, initial)).toBe(true)
	})

	it("is true for a country change alone", () => {
		const initial = personalToFormState({ ...emptyPersonal(), country: "Germany" })
		const form = { ...initial, country: "France" }

		expect(isPersonalFormDirty(form, initial)).toBe(true)
	})
})
