import { LICENSE_TEXTS, THIRD_PARTY_NOTICES, type ThirdPartyNotice } from "@/features/settings/thirdPartyNotices.generated"

export { THIRD_PARTY_NOTICES, type ThirdPartyNotice }

/**
 * Resolves one package by the identity the route carries.
 *
 * Name AND version, because the same package legitimately appears at two versions in one tree, and
 * because an index into the generated array would silently point at a different package the next time
 * the payload is regenerated.
 */
export function findThirdPartyNotice(name: string, version: string): ThirdPartyNotice | null {
	return THIRD_PARTY_NOTICES.find(notice => notice.name === name && notice.version === version) ?? null
}

/**
 * The license terms for a package, or null when it shipped no license file.
 *
 * Null is deliberately not filled in from another package's text of the same license: an MIT file is
 * only distinguishable by its copyright line, so borrowing one would attribute the wrong holder.
 */
export function thirdPartyLicenseText(notice: ThirdPartyNotice): string | null {
	return notice.text >= 0 ? (LICENSE_TEXTS[notice.text] ?? null) : null
}
