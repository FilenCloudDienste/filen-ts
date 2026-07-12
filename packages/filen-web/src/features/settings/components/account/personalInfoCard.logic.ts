import type { Personal, UserPersonalUpdateInfo } from "@filen/sdk-rs"

// Pure form <-> wasm-shape mapping, split out of the component (react-refresh requires a component
// file to export components only) so it is unit-testable without a DOM. `Personal` and
// `UserPersonalUpdateInfo` share the same 9 optional-string fields — this is the one place that
// bridges the "" empty-input default a plain text field needs and the `undefined` wasm expects for
// "field not set".
export type PersonalFormState = Record<keyof UserPersonalUpdateInfo, string>

export const PERSONAL_FIELD_ORDER: (keyof UserPersonalUpdateInfo)[] = [
	"firstName",
	"lastName",
	"companyName",
	"vatId",
	"street",
	"streetNumber",
	"city",
	"postalCode",
	"country"
]

export function personalToFormState(personal: Personal): PersonalFormState {
	return {
		firstName: personal.firstName ?? "",
		lastName: personal.lastName ?? "",
		companyName: personal.companyName ?? "",
		vatId: personal.vatId ?? "",
		street: personal.street ?? "",
		streetNumber: personal.streetNumber ?? "",
		city: personal.city ?? "",
		postalCode: personal.postalCode ?? "",
		country: personal.country ?? ""
	}
}

// The dirty-gate P15 needed: true when ANY field differs from the snapshot taken when the card's
// form state was frozen (see personalInfoCard.tsx's own comment on the freeze-on-mount invariant).
// Mirrors nicknameCard's single-field `trimmed !== (nickName ?? "")` check, generalized to every
// PERSONAL_FIELD_ORDER key — raw (untrimmed) comparison on purpose: trailing whitespace the user just
// typed should still enable Save even though formStateToUpdateInfo will trim it away on submit.
export function isPersonalFormDirty(form: PersonalFormState, initial: PersonalFormState): boolean {
	return PERSONAL_FIELD_ORDER.some(key => form[key] !== initial[key])
}

// Trims every field and folds a blank result to `undefined` (never an empty string) — matches
// wasm's own "absent means not set" convention for every other optional string field on this
// worker (see setNickname's `?: string | null`).
export function formStateToUpdateInfo(form: PersonalFormState): UserPersonalUpdateInfo {
	return {
		firstName: form.firstName.trim() || undefined,
		lastName: form.lastName.trim() || undefined,
		companyName: form.companyName.trim() || undefined,
		vatId: form.vatId.trim() || undefined,
		street: form.street.trim() || undefined,
		streetNumber: form.streetNumber.trim() || undefined,
		city: form.city.trim() || undefined,
		postalCode: form.postalCode.trim() || undefined,
		country: form.country.trim() || undefined
	}
}
