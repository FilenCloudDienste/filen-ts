import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomInt, randomUUID } from "node:crypto"
import type * as Sdk from "@filen/sdk-rs"
import type { Page } from "playwright-core"
import { LEGACY_KEYS } from "../../../src/main/legacyData.ts"
import { fail, waitFor } from "../support.ts"
import { type LegacyAnonymous, legacySeed } from "./seed.ts"

// Chain K's synthetic 3.x account (scripts/ci/e2e/chains/keyring.ts) and what its checks read. No real account is
// involved: the keys are random (the private key a real RSA key, which the web's session resume parses), the userIds
// random, and every launch of N runs behind the offline block, so the API never sees any of it. The values are written
// where 3.0.53's login and settings write them (seed.ts legacySeed for sdkConfig and desktopConfig), so N's migration
// reads them as it reads a real profile.

export interface KeyringSeed {
	// What sdk-rs would hand over for this account: the seed's sdkConfig is built from it like chain L's.
	client: Sdk.StringifiedClient
	// The account whose sync, drive and WebDAV settings sit beside the signed-in one (a second user of the machine).
	otherUserId: number
	pin: string
	// Seconds; the old lock (and so the PIN import) needs one.
	lockTimeout: number
	webdavPassword: string
}

export function keyringSeed(): KeyringSeed {
	const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
	const userId = randomInt(100_000_000, 900_000_000)

	return {
		client: {
			email: `e2e-keyring-${randomBytes(6).toString("hex")}@example.invalid`,
			userId: BigInt(userId),
			rootUuid: randomUUID(),
			authInfo: randomBytes(32).toString("hex"),
			privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
			apiKey: randomBytes(32).toString("hex"),
			authVersion: 2
		},
		otherUserId: userId + randomInt(1, 1000),
		pin: String(randomInt(100_000, 1_000_000)),
		lockTimeout: 3600,
		webdavPassword: randomBytes(18).toString("hex")
	}
}

// The public key 3.0.53 kept beside the private one (SPKI, as legacySeed writes it).
function publicKeyOf(seed: KeyringSeed): string {
	return createPublicKey(createPrivateKey({ key: Buffer.from(seed.client.privateKey, "base64"), format: "der", type: "pkcs8" }))
		.export({ type: "spki", format: "der" })
		.toString("base64")
}

// The values that must never be on disk in plaintext outside the old origin's stores, nor left there after the wipe:
// the account's keys, the PIN as 3.x stored it (JSON) and the other user's WebDAV password.
export function seedSecrets(seed: KeyringSeed): string[] {
	return [
		seed.client.apiKey,
		seed.client.authInfo,
		seed.client.privateKey,
		publicKeyOf(seed),
		seed.webdavPassword,
		JSON.stringify(seed.pin)
	]
}

// Everything the redactor masks: the secrets, and what identifies the synthetic accounts.
export function seedRedacted(seed: KeyringSeed): string[] {
	return [...seedSecrets(seed), seed.pin, seed.client.email, seed.client.rootUuid, String(seed.client.userId), String(seed.otherUserId)]
}

// The localStorage writes on top of 3.0.53's signed-out start: the account as its login stores it, the PIN with a lock
// timeout, both window prefs on, and sync pairs, a drive and WebDAV as its settings store them, for the other user.
export function keyringWrites(seed: KeyringSeed, anonymous: LegacyAnonymous): Record<string, string> {
	const { sdkConfig, desktopConfig } = legacySeed(seed.client, anonymous)
	const other = String(seed.otherUserId)
	const remoteDir = randomUUID()

	return {
		[LEGACY_KEYS.authed]: "true",
		[LEGACY_KEYS.sdkConfig]: sdkConfig,
		[LEGACY_KEYS.desktopConfig]: desktopConfig,
		[LEGACY_KEYS.lockPin]: JSON.stringify(seed.pin),
		[LEGACY_KEYS.lockTimeout]: JSON.stringify(seed.lockTimeout),
		[LEGACY_KEYS.minimizeToTray]: "true",
		[LEGACY_KEYS.startMinimized]: "true",
		[LEGACY_KEYS.sync]: JSON.stringify({
			[other]: {
				enabled: true,
				syncPairs: [
					{
						uuid: randomUUID(),
						name: "Other",
						localPath: "/home/other/Filen",
						remotePath: "/Other",
						remoteParentUUID: remoteDir,
						mode: "twoWay",
						excludeDotFiles: false,
						paused: false,
						localTrashDisabled: false
					}
				]
			}
		}),
		[LEGACY_KEYS.networkDrive]: JSON.stringify({ [other]: { enabled: true, readOnly: false, mountPoint: "/home/other/Filen Drive" } }),
		[LEGACY_KEYS.webdav]: JSON.stringify({
			[other]: {
				enabled: true,
				username: "other",
				password: seed.webdavPassword,
				hostname: "127.0.0.1",
				port: 1901,
				https: false,
				proxyMode: false,
				authMode: "basic"
			}
		})
	}
}

// The seed, on 3.0.53's sign-in screen once its signed-out setup stored the anonymous config. The values cross CDP as
// an evaluate argument; the page is not reloaded, so the old app never acts on the account. Returns the keys written.
export async function seedKeyringLegacy(page: Page, seed: KeyringSeed, timeoutMs: number): Promise<string[]> {
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

	const writes = keyringWrites(seed, anonymous)

	await page.evaluate(values => {
		for (const [key, value] of Object.entries(values)) {
			localStorage.setItem(key, value)
		}
	}, writes)

	return Object.keys(writes)
}

// What the old origin holds, read in its page (filendesktop://bundle): which of the keys 4.x imports are there, how
// many values hold one of `secrets` (passed in as an evaluate argument; only counts come back), whether desktopConfig
// still carries its sdkConfig copy, how many WebDAV entries still have a password, and whether the old web app's
// IndexedDB is there.
export interface LegacyOriginRead {
	present: string[]
	holding: number
	desktopSdkConfig: boolean
	webdavPasswords: number
	indexedDb: boolean
}

export async function readLegacyOrigin(page: Page, secrets: readonly string[]): Promise<LegacyOriginRead> {
	return page.evaluate(
		async ([keys, needles]) => {
			const parse = (key: string): unknown => {
				try {
					return JSON.parse(localStorage.getItem(key) ?? "null")
				} catch {
					return null
				}
			}
			const values: string[] = []

			for (let index = 0; index < localStorage.length; index++) {
				const key = localStorage.key(index)

				values.push(key === null ? "" : (localStorage.getItem(key) ?? ""))
			}

			const desktopConfig = parse(keys.desktopConfig)
			const webdav = parse(keys.webdav)
			// The page's own IndexedDB (no DOM types in the harness).
			const databases = await (
				globalThis as unknown as { indexedDB: { databases(): Promise<{ name?: string }[]> } }
			).indexedDB.databases()

			return {
				present: Object.values(keys).filter(key => localStorage.getItem(key) !== null),
				holding: values.filter(value => needles.some(needle => value.includes(needle))).length,
				desktopSdkConfig: typeof desktopConfig === "object" && desktopConfig !== null && "sdkConfig" in desktopConfig,
				webdavPasswords:
					typeof webdav === "object" && webdav !== null
						? Object.values(webdav).filter(entry => typeof entry === "object" && entry !== null && "password" in entry).length
						: 0,
				indexedDb: databases.some(database => database.name === "Filen")
			}
		},
		[LEGACY_KEYS, secrets] as const
	)
}

// What N's safeStorage did in a launch, from what main logged (src/main/index.ts sessionCipher, sessionVault.ts,
// migration.ts): no secure storage (isAsyncEncryptionAvailable false, or Linux's basic_text), the probe rejecting, an
// encryption the keychain refused (a deferral from a step that encrypts), Chromium's hardcoded fallback key ("v10", as
// without a working Secret Service, which N stores with all the same), or none of these (the keyring's key).
export type CipherSeen = "memory" | "probe-rejected" | "encrypt-rejected" | "fallback-key" | "encrypted"

export function cipherSeen(log: string): CipherSeen {
	if (log.includes("keeping the session in memory only")) {
		return "memory"
	}

	if (log.includes("session vault encryption unavailable")) {
		return "probe-rejected"
	}

	if (/migration: deferred, tried again next launch: [\w ]+: safeStorage/.test(log)) {
		return "encrypt-rejected"
	}

	if (/secure storage: available, .*probe v10\b/.test(log)) {
		return "fallback-key"
	}

	return "encrypted"
}

// The safeStorage and migration lines of a launch's main.log, for the evidence (no values: main logs none).
export function keychainLines(log: string): string[] {
	return log
		.split("\n")
		.filter(line => /secure storage:|session vault|migration:|app lock/.test(line))
		.map(line => line.trim())
}

export interface MarkerRead {
	stage?: unknown
	failedStarts?: unknown
	stashOnly?: unknown
	volatileStash?: unknown
	deferred?: unknown
	prefsImported?: unknown
	userId?: unknown
	importedAt?: unknown
	wiped?: unknown
	logsDeleted?: unknown
}

// What B1 (src/main/migration.ts) leaves after a launch without a working keyring: the attempt waits, uncounted, with
// the prefs imported and nothing wiped. Without secure storage at all (`memory`) the read worked and its stash lives in
// memory only (volatileStash, read again next launch); on the fallback key (`fallback-key`) N stores with it, so the
// import proceeds as with the keyring (imported, nothing deferred or in memory); otherwise the keychain refused and the
// session is left undecided (deferred). Never abandoned. The problems, empty when it is so.
export function heldProblems(marker: MarkerRead | null, seen: CipherSeen): string[] {
	if (marker === null) {
		return ["no migration.json"]
	}

	const problems: string[] = []

	if (marker.stage !== (seen === "fallback-key" ? "imported" : "started")) {
		problems.push(`stage ${String(marker.stage)}`)
	}

	// An attempt that reached imported keeps the count it started with.
	if (seen !== "fallback-key" && marker.failedStarts !== 0) {
		problems.push(`failedStarts ${String(marker.failedStarts)} (counted as a failure)`)
	}

	if (marker.prefsImported !== true) {
		problems.push("prefs not imported")
	}

	if (marker.wiped === true) {
		problems.push("wiped")
	}

	if (seen === "memory") {
		if (marker.volatileStash !== true || marker.stashOnly !== true || marker.deferred === true) {
			problems.push(
				`in memory: volatileStash ${String(marker.volatileStash)}, stashOnly ${String(marker.stashOnly)}, deferred ${String(marker.deferred)}`
			)
		}
	} else if (seen === "fallback-key") {
		if (marker.volatileStash === true || marker.deferred === true) {
			problems.push(`on the fallback key: volatileStash ${String(marker.volatileStash)}, deferred ${String(marker.deferred)}`)
		}
	} else if (seen === "encrypted") {
		problems.push("safeStorage encrypted: nothing held the import")
	} else if (marker.deferred !== true || marker.volatileStash === true) {
		problems.push(`refused: deferred ${String(marker.deferred)}, volatileStash ${String(marker.volatileStash)}`)
	}

	return problems
}

// The marker with its import moved `ms` into the past (the wait for the wipe then runs out on the next launch).
export function backdateImport(text: string, ms: number): string {
	const marker = JSON.parse(text) as Record<string, unknown>

	if (typeof marker["importedAt"] !== "number") {
		fail(`migration.json has no importedAt: stage ${String(marker["stage"])}`)
	}

	return JSON.stringify({ ...marker, importedAt: marker["importedAt"] - ms })
}

// Chromium's Linux encryption with the key it keeps in the Secret Service ("v11"; "v10" is the hardcoded fallback key).
export function keyringEncrypted(data: Buffer | null): boolean {
	return data !== null && data.subarray(0, 3).toString("latin1") === "v11"
}

// Chromium's Linux encryption with its hardcoded fallback key ("v10").
export function fallbackKeyEncrypted(data: Buffer | null): boolean {
	return data !== null && data.subarray(0, 3).toString("latin1") === "v10"
}
