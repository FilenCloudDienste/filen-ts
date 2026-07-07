// Referral/affiliate attribution read from cookies set by the marketing site before it redirects a
// visitor into registration (a share link mints `refId`; an affiliate link likewise mints `affId`).
// This app only ever READS these two — nothing here sets them. Guard mirrors the legacy web app's
// contract: a value must be non-empty and under 128 chars, or it is dropped rather than forwarded
// to the SDK's register call.
const MAX_COOKIE_VALUE_LENGTH = 128

function readCookie(name: string): string | undefined {
	const cookies = document.cookie.length > 0 ? document.cookie.split("; ") : []

	for (const cookie of cookies) {
		const separatorIndex = cookie.indexOf("=")

		if (separatorIndex === -1 || cookie.slice(0, separatorIndex) !== name) {
			continue
		}

		const raw = cookie.slice(separatorIndex + 1)

		let value: string

		try {
			value = decodeURIComponent(raw)
		} catch {
			// Malformed percent-sequence: treat the cookie as an opaque raw string rather than
			// dropping it outright.
			value = raw
		}

		return value.length > 0 && value.length < MAX_COOKIE_VALUE_LENGTH ? value : undefined
	}

	return undefined
}

// Conditional spread only — never an explicit `undefined` property — so the result composes
// directly into the SDK's RegisterParams (`...(refId ? { refId } : {})`).
export function getReferral(): { refId?: string; affId?: string } {
	const refId = readCookie("refId")
	const affId = readCookie("affId")

	return {
		...(refId ? { refId } : {}),
		...(affId ? { affId } : {})
	}
}
