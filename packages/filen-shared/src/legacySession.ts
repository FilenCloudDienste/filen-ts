import { type } from "arktype"

// The previous Filen web and desktop clients (3.x) kept the signed-in account in localStorage, each value written with
// JSON.stringify (usehooks' useLocalStorage), `authed` included ("true").
export const LEGACY_SESSION_KEYS = {
	authed: "authed:4:4:4",
	sdkConfig: "sdkConfig:4:4"
} as const

// A safe integer: the old userId is a JS number. The old client treats 1 (and anything not positive) as signed out.
export const LEGACY_USER_ID = "1 < number.integer <= 9007199254740991"

// The old JS SDK's FilenSDKConfig, only the fields the session needs. `password` and `twoFactorCode` were stored as
// "redacted" and are never read. The old client's own test for a real key: longer than 32 and not "anonymous".
const sdkConfigSchema = type({
	email: "string > 0",
	masterKeys: type("string > 0").array().atLeastLength(1),
	apiKey: "string > 32",
	privateKey: "string > 0",
	authVersion: "1 | 2 | 3",
	baseFolderUUID: "string > 0",
	userId: LEGACY_USER_ID
})

// The `@filen/sdk-rs` StringifiedClient fields a converted account carries.
export interface LegacySessionClient {
	email: string
	rootUuid: string
	authInfo: string
	privateKey: string
	apiKey: string
	userId: bigint
	authVersion: 1 | 2 | 3
}

export type LegacySessionFailure = "not-signed-in" | "invalid-account"

export type LegacySessionResult = { ok: true; session: LegacySessionClient; userId: number } | { ok: false; reason: LegacySessionFailure }

function parseJson(raw: string | null | undefined): unknown {
	if (raw === null || raw === undefined) {
		return undefined
	}

	try {
		return JSON.parse(raw) as unknown
	} catch {
		return undefined
	}
}

// The old account converted like sdk-rs's `From<FilenSDKConfig> for StringifiedClient`: rootUuid is baseFolderUUID,
// authInfo the master keys joined by "|", the public key dropped (derived from the private key). Takes the raw
// stored strings. A value starting with "$" would need the session envelope's escape; no real one does, so such an
// account is refused instead. Failures name a reason, never a value.
export function convertLegacySession(authedRaw: string | null | undefined, sdkConfigRaw: string | null | undefined): LegacySessionResult {
	if (authedRaw !== "true") {
		return { ok: false, reason: "not-signed-in" }
	}

	const config = sdkConfigSchema(parseJson(sdkConfigRaw))

	if (config instanceof type.errors || config.apiKey === "anonymous" || config.masterKeys.some(key => key.includes("|"))) {
		return { ok: false, reason: "invalid-account" }
	}

	const session: LegacySessionClient = {
		email: config.email,
		rootUuid: config.baseFolderUUID,
		authInfo: config.masterKeys.join("|"),
		privateKey: config.privateKey,
		apiKey: config.apiKey,
		userId: BigInt(config.userId),
		authVersion: config.authVersion
	}

	if ([session.email, session.rootUuid, session.authInfo, session.privateKey, session.apiKey].some(value => value.startsWith("$"))) {
		return { ok: false, reason: "invalid-account" }
	}

	return { ok: true, session, userId: config.userId }
}
