import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, hkdfSync, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { type } from "arktype"
import type * as Sdk from "@filen/sdk-rs"
import { parseEnvelope, sessionSchema, stringifyEnvelope } from "@filen/shared/session"
import { installedAddon } from "../../stageNapi.ts"
import { errorMessage, fail } from "../support.ts"

// The harness's own access to the e2e accounts. Logins are rate-limited (90 an hour per IP) and the backend hands every
// login the account's one API key, which no sign-out revokes (there is no logout endpoint; only a password change or
// reset rotates it). So a session, once minted, is kept: the `session` job restores it from the Actions cache, checks
// it against the API, and signs in (sdk-rs's Node-API addon, once) only when there is none, it is a week old or the API
// no longer knows its key. It is handed to every other job of the run.
//
// Both copies are sealed (AES-256-GCM) under keys derived (HKDF-SHA256) from one secret, FILEN_DESKTOP_E2E_SESSION_KEY:
// the cache's with a fixed info, the run's hand-off with the run id as salt, so a hand-off opens in its own run only.
// The slot is the additional data, so one slot's copy never opens as another's. Each lives in a file: the cache's in
// the cache, the hand-off in a short-lived artifact that each receiving job reads from SESSION_DIR_ENV. Neither ever
// travels in an environment variable or a job output, which GitHub prints with a step's settings. Every receiving job
// masks the sealed text and every value it decrypts before anything can print them.
//
// What a job reaches the cloud with is what rclone's filen backend takes (scripts/ci/e2e/cloud.ts): the account's keys
// as sdk-rs's Client::to_sdk_config gives them to its own rclone remote. The addon exposes no listing, upload or
// deletion, so the harness reaches the cloud through rclone, the way filen-cli's `rclone` command does. The stringified
// client itself seeds the apps that do not sign in through their form (scripts/ci/e2e/seed.ts).

// One account per slot, named for its role, never for its email: `test` is the account every deep entry uses, `quota`
// the one whose storage is kept full. A slot without its secrets is skipped.
export const SLOTS = {
	test: { email: "FILEN_DESKTOP_E2E_TEST_EMAIL", password: "FILEN_DESKTOP_E2E_TEST_PASSWORD" },
	quota: { email: "FILEN_DESKTOP_E2E_QUOTA_EMAIL", password: "FILEN_DESKTOP_E2E_QUOTA_PASSWORD" }
} as const

export type Slot = keyof typeof SLOTS

export function isSlot(value: string): value is Slot {
	return Object.hasOwn(SLOTS, value)
}

export const SESSION_KEY_ENV = "FILEN_DESKTOP_E2E_SESSION_KEY"
// The directories of the run's hand-off and of the cached copies, `<slot>.sealed` in each (not secrets themselves).
export const SESSION_DIR_ENV = "FILEN_DESKTOP_E2E_SESSION_DIR"
export const CACHE_DIR_ENV = "FILEN_DESKTOP_E2E_CACHE_DIR"

const LOGIN_TIMEOUT_MS = 90_000
const VALIDATE_TIMEOUT_MS = 15_000
// A cached session older than this is minted again even when the API still knows it: no copy of a key stays in the
// cache longer than a week.
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000
const CACHE_INFO = "filen-desktop-e2e:cache:v1"
const RUN_INFO = "filen-desktop-e2e:run:v1"
const USER_INFO_URL = "https://gateway.filen.io/v3/user/info"

export interface HarnessRemote {
	email: string
	apiKey: string
	masterKeys: string[]
	// Base64 DER: the private key PKCS#8, the public key PKCS#1, as to_sdk_config encodes them.
	privateKey: string
	publicKey: string
	authVersion: number
	rootUuid: string
}

export interface Credentials {
	email: string
	password: string
}

// What both sealed copies hold: the client as sdk-rs stringifies it, and when that login happened (ms since the epoch).
export interface SessionRecord {
	client: Sdk.StringifiedClient
	mintedAt: number
}

const recordSchema = type({ client: sessionSchema, mintedAt: "number.integer > 0" })

// The slot's credentials, taken out of the environment so that nothing started from here inherits them; null when the
// slot's secrets are not set.
export function slotCredentials(slot: Slot): Credentials | null {
	const names = SLOTS[slot]
	const email = process.env[names.email] ?? ""
	const password = process.env[names.password] ?? ""

	delete process.env[names.email]
	delete process.env[names.password]

	return email === "" || password === "" ? null : { email, password }
}

export function takeCredentials(slot: Slot = "test"): Credentials {
	return slotCredentials(slot) ?? fail(`${SLOTS[slot].email} and ${SLOTS[slot].password} must be set`)
}

let sessionKey: string | undefined

// The sealing secret, taken out of the environment on first use.
export function takeSessionKey(): string {
	if (sessionKey === undefined) {
		const value = process.env[SESSION_KEY_ENV] ?? ""

		delete process.env[SESSION_KEY_ENV]

		if (value.length < 32) {
			fail(`infra: ${SESSION_KEY_ENV} must be set (at least 32 characters)`)
		}

		sessionKey = value
	}

	return sessionKey
}

// Every value that must never appear in a log; GitHub masks them from here on.
export function secretsOf(remote: HarnessRemote): string[] {
	return [remote.apiKey, ...remote.masterKeys, remote.privateKey, remote.publicKey]
}

export function mask(values: readonly string[]): void {
	for (const value of values) {
		if (value.length >= 4 && process.env["GITHUB_ACTIONS"] === "true") {
			console.log(`::add-mask::${value}`)
		}
	}
}

// The stringified client's fields as to_sdk_config maps them: auth info is the master keys joined with "|" (auth v1,
// v2) or the single data encryption key (v3); the public key is the private key's.
export function remoteOf(client: Sdk.StringifiedClient): HarnessRemote {
	const publicKey = createPublicKey(createPrivateKey({ key: Buffer.from(client.privateKey, "base64"), format: "der", type: "pkcs8" }))
		.export({ type: "pkcs1", format: "der" })
		.toString("base64")

	return {
		email: client.email,
		apiKey: client.apiKey,
		masterKeys: client.authInfo.split("|"),
		privateKey: client.privateKey,
		publicKey,
		authVersion: client.authVersion,
		rootUuid: client.rootUuid
	}
}

export function cacheKey(secret: string): Buffer {
	return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), CACHE_INFO, 32))
}

// The run's own salt: a re-run attempt of a job opens the hand-off the first attempt's session job made, another run's
// never.
export function runKey(secret: string, runId: string): Buffer {
	return Buffer.from(hkdfSync("sha256", secret, runId, RUN_INFO, 32))
}

function additionalData(slot: Slot): Buffer {
	return Buffer.from(`v1|${slot}`, "utf8")
}

export function sealRecord(record: SessionRecord, key: Buffer, slot: Slot): string {
	const iv = randomBytes(12)
	const cipher = createCipheriv("aes-256-gcm", key, iv)

	cipher.setAAD(additionalData(slot))

	const sealed = Buffer.concat([cipher.update(stringifyEnvelope(record), "utf8"), cipher.final()])

	return [iv, cipher.getAuthTag(), sealed].map(part => part.toString("base64")).join(".")
}

// Throws on a wrong key or slot and on tampered text; the record's shape is checked before anything uses it.
export function openRecord(sealed: string, key: Buffer, slot: Slot): SessionRecord {
	const [iv, tag, data, extra] = sealed.split(".").map(part => Buffer.from(part, "base64"))

	if (iv === undefined || tag === undefined || data === undefined || extra !== undefined) {
		fail("the sealed session is malformed")
	}

	const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 })

	decipher.setAAD(additionalData(slot))
	decipher.setAuthTag(tag)

	const record = recordSchema(parseEnvelope(Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8")))

	if (record instanceof type.errors) {
		// Paths only, never values.
		fail(`the sealed session is not a session record (${record.map(error => error.path.join(".")).join(", ")})`)
	}

	return record
}

export function runId(): string {
	const id = process.env["GITHUB_RUN_ID"] ?? ""

	if (!/^\d+$/.test(id)) {
		fail("GITHUB_RUN_ID is not set: the harness session belongs to a workflow run")
	}

	return id
}

function slotFile(dirEnv: string, slot: Slot): string {
	const dir = process.env[dirEnv] ?? ""

	return dir === "" ? fail(`${dirEnv} is not set`) : path.join(dir, `${slot}.sealed`)
}

// The sealed text in `file`, masked; null when there is none.
function readSealedFile(file: string): string | null {
	const sealed = existsSync(file) ? readFileSync(file, "utf8").trim() : ""

	if (sealed === "") {
		return null
	}

	mask([sealed])

	return sealed
}

// Writes sealed text readable by this user only.
function writeSealedFile(file: string, sealed: string): string {
	mask([sealed])
	mkdirSync(path.dirname(file), { recursive: true })
	writeFileSync(file, sealed, { mode: 0o600 })

	return file
}

// The run's hand-off of `slot`: sealed text in the file SESSION_DIR_ENV/<slot>.sealed.
export function readHandOff(slot: Slot): string {
	const file = slotFile(SESSION_DIR_ENV, slot)

	return (
		readSealedFile(file) ??
		fail(`${SESSION_DIR_ENV} holds no sealed ${slot} session (${file}): the session job did not run, failed or skipped the slot`)
	)
}

export function writeHandOff(slot: Slot, record: SessionRecord, secret: string): string {
	return writeSealedFile(slotFile(SESSION_DIR_ENV, slot), sealRecord(record, runKey(secret, runId()), slot))
}

// The cached copy of `slot` as the cache restored it; null when there is none or it does not open (another key, a
// damaged file): either is a miss, never an error.
export function readCached(slot: Slot, secret: string): SessionRecord | null {
	const sealed = readSealedFile(slotFile(CACHE_DIR_ENV, slot))

	if (sealed === null) {
		return null
	}

	try {
		return openRecord(sealed, cacheKey(secret), slot)
	} catch (error) {
		console.log(`the cached ${slot} session does not open (${errorMessage(error)})`)

		return null
	}
}

export function writeCached(slot: Slot, record: SessionRecord, secret: string): string {
	return writeSealedFile(slotFile(CACHE_DIR_ENV, slot), sealRecord(record, cacheKey(secret), slot))
}

// The handed session of `slot`, opened with the sealing secret: the client (for seeding) and the remote rclone takes.
export function harnessSession(slot: Slot = "test"): { client: Sdk.StringifiedClient; remote: HarnessRemote } {
	const { client } = openRecord(readHandOff(slot), runKey(takeSessionKey(), runId()), slot)
	const remote = remoteOf(client)

	mask(secretsOf(remote))

	return { client, remote }
}

export type Verdict = "valid" | "unknown-key" | "other-account"

const userInfoSchema = type({ status: "boolean", "code?": "string", "data?": { id: "number.integer" } })

// What the API says about a cached session: GET /v3/user/info is not rate-limited and answers api_key_not_found for a
// key it does not know. Any other answer, a timeout or a network error is the infrastructure failing, never a reason to
// log in: a login spent on an outage proves nothing and costs the budget.
export async function validateSession(client: Sdk.StringifiedClient): Promise<Verdict> {
	let response: Response

	try {
		response = await fetch(USER_INFO_URL, {
			headers: { Authorization: `Bearer ${client.apiKey}` },
			signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS)
		})
	} catch (error) {
		fail(`infra: /v3/user/info did not answer: ${errorMessage(error)}`)
	}

	const answer = userInfoSchema(response.ok ? await response.json().catch(() => null) : null)

	if (answer instanceof type.errors) {
		fail(`infra: /v3/user/info answered HTTP ${String(response.status)} without its JSON`)
	}

	if (answer.status && answer.data !== undefined) {
		return BigInt(answer.data.id) === client.userId ? "valid" : "other-account"
	}

	if (answer.code === "api_key_not_found") {
		return "unknown-key"
	}

	fail(`infra: /v3/user/info answered ${answer.code ?? "no code"}`)
}

// The client with sdk-rs's StringifiedClient fields in its declaration order, which wasm's toStringified (filen-web)
// creates them in; the two optional limits only when set, as serde leaves them out of the page's object otherwise.
export function canonicalClient(client: Sdk.StringifiedClient): Sdk.StringifiedClient {
	const { email, userId, rootUuid, authInfo, privateKey, apiKey, authVersion, maxParallelRequests, maxIoMemoryUsage } = client

	return {
		email,
		userId,
		rootUuid,
		authInfo,
		privateKey,
		apiKey,
		authVersion,
		...(typeof maxParallelRequests === "number" ? { maxParallelRequests } : {}),
		...(typeof maxIoMemoryUsage === "number" ? { maxIoMemoryUsage } : {})
	}
}

// One login. Never retried: logins are rate-limited.
export async function signInHarness(credentials: Credentials): Promise<Sdk.StringifiedClient> {
	const addon = installedAddon(process.arch === "arm64" ? "arm64" : "x64") ?? fail("infra: @filen/sdk-rs has no addon for this runner")
	const sdk = createRequire(import.meta.url)(addon) as typeof Sdk

	sdk.init()

	const client = await sdk.UnauthJsClient.fromConfig({ logLevel: sdk.LogLevel.Warn }).login(
		{ email: credentials.email, password: credentials.password },
		{ signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS) }
	)
	const stringified = canonicalClient(await client.toStringified({ signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS) }))

	mask(secretsOf(remoteOf(stringified)))

	return stringified
}
