import { createPrivateKey, createPublicKey } from "node:crypto"
import type { DesktopBridge } from "@filen/shared/desktop"
import type * as Sdk from "@filen/sdk-rs"
import { stringifyEnvelope } from "@filen/shared/session"
import type { Page } from "playwright-core"
import { LEGACY_KEYS } from "../../../src/main/legacyData.ts"
import { fail, waitFor } from "../support.ts"
import { canonicalClient } from "./session.ts"

// Signing an app in without its form. Logins are rate-limited (90 an hour per IP), so each OS signs in through a real
// form once per chain and run (the plan's signInPrevious and signInLegacy); every other deep entry is seeded with the
// run's handed session (scripts/ci/e2e/session.ts), stored exactly where and as a real sign-in stores it, so everything
// after the sign-in runs on the same data:
//
//   4.x     the envelope filen-web's persistSession hands window.desktop.session.set (stringifyEnvelope of the
//           StringifiedClient), passed as an evaluate argument and never as script text; then the page reloads and
//           resumes it as on any start
//   3.0.53  sdkConfig, desktopConfig and authed in its localStorage, as its login (filen-web 0.2.3 login.tsx) writes
//           them, on top of what its own signed-out start wrote; then the page reloads and its setup takes the account
//           as after a restart
//
// A real sign-in reads back what it stored (describeStored, in the page): the keys and value types, attached and
// compared with the seed's, and whether its API key is the handed session's (the account has one key, so it must be).

export type SignIn = "real" | "seeded"

export const SIGN_IN_ENV = "E2E_SIGN_IN"

// How this chain signs in (the plan's choice for the entry); real unless the workflow says seeded.
export function signInMode(): SignIn {
	const mode = process.env[SIGN_IN_ENV] ?? ""

	if (mode !== "" && mode !== "real" && mode !== "seeded") {
		fail(`${SIGN_IN_ENV} must be real or seeded (got "${mode}")`)
	}

	return mode === "seeded" ? "seeded" : "real"
}

// The 4.x seed: the blob persistSession stores.
export function sessionEnvelope(client: Sdk.StringifiedClient): string {
	return stringifyEnvelope(canonicalClient(client))
}

// What a real 4.x sign-in stores, keys and value types in order (the envelope carries userId as "$bigint:<digits>n").
export const SESSION_SHAPE: readonly string[] = [
	"email: string",
	"userId: string",
	"rootUuid: string",
	"authInfo: string",
	"privateKey: string",
	"apiKey: string",
	"authVersion: number"
]

// What 3.0.53's signed-out start writes before anyone signs in (its setup(), for a fresh install): the JS SDK's
// anonymous config with connectToSocket and metadataCache on, and desktopConfig's defaults around a copy of it.
export interface LegacyAnonymous {
	sdkConfig: Record<string, unknown>
	desktopConfig: Record<string, unknown>
}

export interface LegacySeed {
	// The raw localStorage values by key.
	sdkConfig: string
	desktopConfig: string
}

// The 3.0.53 seed. Its login spreads the SDK's config, which init() always builds as {...ANONYMOUS_SDK_CONFIG,
// ...params}: every key keeps the anonymous config's position, so the page's own signed-out config is the base, its
// tmpPath (whatever the browser build's os.tmpdir() gives) included. The fields are what @filen/sdk 0.4.2's login()
// sets: password and twoFactorCode "redacted", the master keys in sdk-rs's order (the derived key first, then the
// server's list, as the JS SDK orders them too), the public key as SPKI (as the server keeps it; derived from the
// private key), the userId a number. desktopConfig is the defaults with that config in place of the anonymous one.
// The private key is sdk-rs's PKCS#8 encoding of the same key, which may differ in bytes from the server's original.
export function legacySeed(client: Sdk.StringifiedClient, anonymous: LegacyAnonymous): LegacySeed {
	const publicKey = createPublicKey(createPrivateKey({ key: Buffer.from(client.privateKey, "base64"), format: "der", type: "pkcs8" }))
		.export({ type: "spki", format: "der" })
		.toString("base64")
	const sdkConfig = {
		...anonymous.sdkConfig,
		email: client.email,
		password: "redacted",
		masterKeys: client.authInfo.split("|"),
		connectToSocket: true,
		metadataCache: true,
		twoFactorCode: "redacted",
		publicKey,
		privateKey: client.privateKey,
		apiKey: client.apiKey,
		authVersion: client.authVersion,
		baseFolderUUID: client.rootUuid,
		userId: Number(client.userId)
	}

	return { sdkConfig: JSON.stringify(sdkConfig), desktopConfig: JSON.stringify({ ...anonymous.desktopConfig, sdkConfig }) }
}

// What a real 3.0.53 sign-in stores in sdkConfig, keys and value types in order: @filen/sdk 0.4.2's
// ANONYMOUS_SDK_CONFIG order.
export const LEGACY_SDK_CONFIG_SHAPE: readonly string[] = [
	"email: string",
	"password: string",
	"masterKeys: string[]",
	"connectToSocket: boolean",
	"metadataCache: boolean",
	"twoFactorCode: string",
	"publicKey: string",
	"privateKey: string",
	"apiKey: string",
	"authVersion: number",
	"baseFolderUUID: string",
	"userId: number",
	"tmpPath: string"
]

export interface StoredDescription {
	shape: string[]
	sameKey: boolean
}

// A stored session's keys with each value's JSON type, in order, and whether its apiKey is `expected`; nothing else
// leaves the page. Self-contained: it also runs in the page, from its own source (storedDescription).
export function describeStored(raw: string, expected: string): StoredDescription {
	const kind = (item: unknown): string =>
		item === null ? "null" : Array.isArray(item) ? `${[...new Set((item as unknown[]).map(kind))].join("|")}[]` : typeof item
	const value: unknown = JSON.parse(raw)
	const entries = typeof value === "object" && value !== null && !Array.isArray(value) ? Object.entries(value) : []

	return {
		shape: entries.map(([key, item]) => `${key}: ${kind(item)}`),
		sameKey: entries.some(([key, item]) => key === "apiKey" && item === expected)
	}
}

// describeStored applied in the page to what `read` finds there (null when nothing is stored). The function's source
// crosses CDP as code; the API key to compare crosses as an evaluate argument, and only the description comes back.
async function storedDescription(
	page: Page,
	read: (describe: typeof describeStored, input: { expected: string; key: string }) => Promise<StoredDescription | null>,
	input: { expected: string; key: string }
): Promise<StoredDescription | null> {
	const describe = await page.evaluateHandle<typeof describeStored>(`(${describeStored.toString()})`)

	try {
		return await describe.evaluate(read, input)
	} finally {
		await describe.dispose()
	}
}

// The 4.x vault's session as the page reads it.
export function describeVault(page: Page, expected: string): Promise<StoredDescription | null> {
	return storedDescription(
		page,
		async (describe, { expected: apiKey }) => {
			const read = await (globalThis as unknown as { desktop: DesktopBridge }).desktop.session.get()

			return read.status === "present" ? describe(read.blob, apiKey) : null
		},
		{ expected, key: "" }
	)
}

// 3.0.53's sdkConfig as the page holds it.
export function describeLegacy(page: Page, expected: string): Promise<StoredDescription | null> {
	return storedDescription(
		page,
		(describe, { expected: apiKey, key }) => {
			const raw = localStorage.getItem(key)

			return Promise.resolve(raw === null ? null : describe(raw, apiKey))
		},
		{ expected, key: LEGACY_KEYS.sdkConfig }
	)
}

// The 4.x seed, on the sign-in screen: the envelope through the vault, then a reload, which resumes it. Done when the
// shell shows (its account button).
export async function seedSession(page: Page, client: Sdk.StringifiedClient, timeoutMs: number): Promise<string> {
	await page.getByText("Sign in to Filen").waitFor({ state: "visible", timeout: timeoutMs })
	await page.evaluate(blob => (globalThis as unknown as { desktop: DesktopBridge }).desktop.session.set(blob), sessionEnvelope(client))
	await page.reload()
	await page.getByRole("button", { name: "Account", exact: true }).waitFor({ state: "visible", timeout: timeoutMs })

	return "seeded through session.set; the reloaded page resumed it"
}

// The 3.0.53 seed, on its sign-in screen once its signed-out setup has stored the anonymous config: the account written
// as its login writes it, then a reload. Done when its setup took the account (it leaves the sign-in route only then);
// returns the userId.
export async function seedLegacy(page: Page, client: Sdk.StringifiedClient, timeoutMs: number): Promise<number> {
	await page.locator("input#email").waitFor({ state: "visible", timeout: timeoutMs })

	const anonymous = await waitFor("the old app's signed-out config", timeoutMs, async () => {
		const read = (await page
			.evaluate(
				([sdkKey, desktopKey]) => {
					const sdkConfig: unknown = JSON.parse(localStorage.getItem(sdkKey) ?? "null")
					const desktopConfig: unknown = JSON.parse(localStorage.getItem(desktopKey) ?? "null")

					return sdkConfig !== null && desktopConfig !== null ? { sdkConfig, desktopConfig } : null
				},
				[LEGACY_KEYS.sdkConfig, LEGACY_KEYS.desktopConfig] as const
			)
			.catch(() => null)) as LegacyAnonymous | null

		return read
	})

	if (anonymous.sdkConfig["apiKey"] !== "anonymous" || anonymous.sdkConfig["userId"] !== 1) {
		fail("the old app's stored config is not the signed-out one")
	}

	const seed = legacySeed(client, anonymous)

	// Its login also clears the rest of localStorage and its IndexedDB caches, which a fresh install has nothing in.
	await page.evaluate(
		([keys, values]) => {
			localStorage.setItem(keys.sdkConfig, values.sdkConfig)
			localStorage.setItem(keys.desktopConfig, values.desktopConfig)
			localStorage.setItem(keys.authed, "true")
		},
		[LEGACY_KEYS, seed] as const
	)
	await page.reload()
	await waitFor("the old app to take the account", timeoutMs, async () => {
		// The hash router stays on /login until setup is done; a probe during the reload may lose its context.
		const left = (await page
			.evaluate("!location.hash.includes('/login') && !document.querySelector('input#email')")
			.catch(() => false)) as boolean

		return left ? true : null
	})

	return Number(client.userId)
}

// After a real sign-in: what it stored has the shape the seed builds (`expected`), and its API key is the handed
// session's. Returns the evidence line; the shape is attached either way.
export function crossCheck(stored: StoredDescription | null, expected: readonly string[], attach: (text: string) => void): string {
	if (stored === null) {
		fail("nothing is stored")
	}

	attach(`${JSON.stringify(stored.shape, null, "\t")}\n`)

	const shape = stored.shape.join(", ")

	if (shape !== expected.join(", ")) {
		fail(`stored ${shape}; the seed builds ${expected.join(", ")}`)
	}

	if (!stored.sameKey) {
		fail("its API key is not the handed session's: a password change or reset rotated it")
	}

	return `the seed's shape (${String(stored.shape.length)} keys); the handed session's API key`
}
