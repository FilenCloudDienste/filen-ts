import { describe, expect, it } from "vitest"
import type { Personal } from "@filen/sdk-rs"
import {
	personalToFormState,
	formStateToUpdateInfo,
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
		const personal: Personal = { ...emptyPersonal(), firstName: "Jane", country: "DE" }

		expect(personalToFormState(personal)).toMatchObject({ firstName: "Jane", country: "DE" })
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
			country: "DE"
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
			country: "DE"
		})
	})
})

describe("PERSONAL_FIELD_ORDER", () => {
	it("lists all 9 UserPersonalUpdateInfo fields, no duplicates", () => {
		expect(PERSONAL_FIELD_ORDER).toHaveLength(9)
		expect(new Set(PERSONAL_FIELD_ORDER).size).toBe(9)
	})
})
