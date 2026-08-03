import {
	LICENSE_TEXTS,
	THIRD_PARTY_NOTICES,
	THIRD_PARTY_NOTICES_FILEN_RS_REF,
	THIRD_PARTY_NOTICES_SDK_VERSION,
	type ThirdPartyNotice
} from "@/features/settings/thirdPartyNotices.gen"

export { THIRD_PARTY_NOTICES, THIRD_PARTY_NOTICES_SDK_VERSION, THIRD_PARTY_NOTICES_FILEN_RS_REF, type ThirdPartyNotice }

/**
 * Resolves one package by name AND version: the same package legitimately appears at two versions in
 * this tree, and an index into the generated array would point at a different package after the next
 * regeneration.
 */
export function findThirdPartyNotice(name: string, version: string): ThirdPartyNotice | null {
	return THIRD_PARTY_NOTICES.find(notice => notice.name === name && notice.version === version) ?? null
}

/**
 * The license terms that ship with a package — empty when it shipped no license file.
 *
 * Empty is deliberately not filled in from another package's text of the same license: an MIT file is
 * only distinguishable by its copyright line, so borrowing one would attribute the wrong holder. More
 * than one text means the declared license is a conjunction and every text applies.
 */
export function thirdPartyLicenseTexts(notice: ThirdPartyNotice): string[] {
	return notice.texts.map(index => LICENSE_TEXTS[index]).filter((text): text is string => text !== undefined)
}

/** Case-insensitive substring over name + SPDX id. An empty query returns the input array identity, so
 *  the virtualizer's item list stays referentially stable while the filter box is untouched. */
export function filterThirdPartyNotices(notices: readonly ThirdPartyNotice[], query: string): readonly ThirdPartyNotice[] {
	const needle = query.trim().toLowerCase()

	if (needle.length === 0) {
		return notices
	}

	return notices.filter(notice => notice.name.toLowerCase().includes(needle) || notice.license.toLowerCase().includes(needle))
}
