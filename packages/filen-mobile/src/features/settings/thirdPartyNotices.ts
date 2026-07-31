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
 * The license terms that ship with a package — empty when it shipped no license file.
 *
 * Empty is deliberately not filled in from another package's text of the same license: an MIT file is
 * only distinguishable by its copyright line, so borrowing one would attribute the wrong holder.
 *
 * More than one text means the declared license is a conjunction ("MIT AND Zlib") and every text
 * applies, so all of them render.
 */
export function thirdPartyLicenseTexts(notice: ThirdPartyNotice): string[] {
	return notice.texts.map(index => LICENSE_TEXTS[index]).filter((text): text is string => text !== undefined)
}
