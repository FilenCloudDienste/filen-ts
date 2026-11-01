import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, randomBytes, scryptSync } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import type * as Sdk from "@filen/sdk-rs"
import { installedAddon } from "../../stageNapi.ts"
import { fail } from "../support.ts"

// The harness's own access to the e2e account: one sign-in per workflow run, through @filen/sdk-rs's Node-API addon,
// handed to every other job. The hand-off is the session encrypted (AES-256-GCM) under a key derived from the account
// password, which every receiving job holds anyway, in a file: the session job writes it, the workflow carries it as a
// short-lived artifact and each receiving job hands the harness its path (SESSION_FILE_ENV). It never travels in an
// environment variable or a job output, which GitHub prints with a step's settings. Each receiving job masks the sealed
// text and every value it decrypts before anything can print them.
//
// What is handed over is what rclone's filen backend takes (scripts/ci/e2e/cloud.ts): the account's keys as sdk-rs's
// Client::to_sdk_config gives them to its own rclone remote. The addon exposes no listing, upload or deletion, so the
// harness reaches the cloud through rclone, the way filen-cli's `rclone` command does.

export const EMAIL_ENV = "FILEN_DESKTOP_E2E_TEST_EMAIL"
export const PASSWORD_ENV = "FILEN_DESKTOP_E2E_TEST_PASSWORD"
// The path of the sealed session (not a secret itself).
export const SESSION_FILE_ENV = "FILEN_DESKTOP_E2E_SESSION_FILE"

const LOGIN_TIMEOUT_MS = 90_000

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

// The account's credentials, taken out of the environment so that nothing started from here inherits them.
export function takeCredentials(): Credentials {
	const email = process.env[EMAIL_ENV] ?? ""
	const password = process.env[PASSWORD_ENV] ?? ""

	if (email === "" || password === "") {
		fail(`${EMAIL_ENV} and ${PASSWORD_ENV} must be set`)
	}

	delete process.env[EMAIL_ENV]
	delete process.env[PASSWORD_ENV]

	return { email, password }
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

// The run's own salt: a re-run attempt of a job decrypts the session the first attempt's session job made.
function keyFor(password: string, runId: string): Buffer {
	return scryptSync(password, `filen-desktop-e2e:${runId}`, 32)
}

export function sealRemote(remote: HarnessRemote, password: string, runId: string): string {
	const iv = randomBytes(12)
	const cipher = createCipheriv("aes-256-gcm", keyFor(password, runId), iv)
	const sealed = Buffer.concat([cipher.update(JSON.stringify(remote), "utf8"), cipher.final()])

	return [iv, cipher.getAuthTag(), sealed].map(part => part.toString("base64")).join(".")
}

export function openRemote(sealed: string, password: string, runId: string): HarnessRemote {
	const [iv, tag, data] = sealed.split(".").map(part => Buffer.from(part, "base64"))

	if (iv === undefined || tag === undefined || data === undefined) {
		fail("the handed session is malformed")
	}

	const decipher = createDecipheriv("aes-256-gcm", keyFor(password, runId), iv)

	decipher.setAuthTag(tag)

	const remote = JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8")) as HarnessRemote

	mask(secretsOf(remote))

	return remote
}

export function runId(): string {
	const id = process.env["GITHUB_RUN_ID"] ?? ""

	if (!/^\d+$/.test(id)) {
		fail("GITHUB_RUN_ID is not set: the harness session belongs to a workflow run")
	}

	return id
}

// The sealed session in the file SESSION_FILE_ENV names.
export function readSealed(): string {
	const file = process.env[SESSION_FILE_ENV] ?? ""
	const sealed = file === "" || !existsSync(file) ? "" : readFileSync(file, "utf8").trim()

	if (sealed === "") {
		fail(`${SESSION_FILE_ENV} names no sealed session (${file || "unset"}): the session job did not run or failed`)
	}

	mask([sealed])

	return sealed
}

// Writes the run's sealed session to the file SESSION_FILE_ENV names, readable by this user only.
export function writeSealed(sealed: string): string {
	const file = process.env[SESSION_FILE_ENV] ?? fail(`${SESSION_FILE_ENV} is not set`)

	mkdirSync(path.dirname(file), { recursive: true })
	writeFileSync(file, sealed, { mode: 0o600 })

	return file
}

// The handed session, decrypted with the account password from `credentials`.
export function harnessRemote(credentials: Credentials): HarnessRemote {
	return openRemote(readSealed(), credentials.password, runId())
}

// The run's one harness sign-in. Never retried: logins are rate-limited per account.
export async function signInHarness(credentials: Credentials): Promise<HarnessRemote> {
	const addon = installedAddon(process.arch === "arm64" ? "arm64" : "x64") ?? fail("infra: @filen/sdk-rs has no addon for this runner")
	const sdk = createRequire(import.meta.url)(addon) as typeof Sdk

	sdk.init()

	const client = await sdk.UnauthJsClient.fromConfig({ logLevel: sdk.LogLevel.Warn }).login(
		{ email: credentials.email, password: credentials.password },
		{ signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS) }
	)
	const remote = remoteOf(await client.toStringified({ signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS) }))

	mask(secretsOf(remote))

	return remote
}
