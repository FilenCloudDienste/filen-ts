import { randomBytes } from "node:crypto"
import { type } from "arktype"
import type { DesktopServeProtocol } from "@filen/shared/desktop"
import { authKindOf, basicAuthSchema, type NativeServeAuth, s3AuthSchema, SERVE_PROTOCOLS } from "../../shared/nativeProtocol.ts"
import { type AtomicFile, codedError, errorCode } from "../atomicFile.ts"
import { serialQueue } from "../../shared/serial.ts"
import type { VaultCipher } from "../sessionVault.ts"

// The servers' credentials, encrypted with the session vault's cipher. They reach rclone only in the body of an
// authenticated loopback rc call; nothing here ever logs one.

export type ServeCredentials = Exclude<NativeServeAuth, { kind: "none" }>

// nfs has no authentication.
export type CredentialProtocol = Exclude<DesktopServeProtocol, "nfs">

export const CREDENTIAL_PROTOCOLS = SERVE_PROTOCOLS.filter((protocol): protocol is CredentialProtocol => protocol !== "nfs")

const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

// Uniform over `alphabet`: bytes past the largest multiple of its length are drawn again.
function randomString(alphabet: string, length: number): string {
	const limit = 256 - (256 % alphabet.length)
	let result = ""

	while (result.length < length) {
		for (const byte of randomBytes(length * 2)) {
			if (byte < limit && result.length < length) {
				result += alphabet[byte % alphabet.length]
			}
		}
	}

	return result
}

// A user `filen-<8 hex>` with a 256-bit password; for s3 an AWS-style 20-character key id and 40-character secret.
export function generateCredentials(protocol: CredentialProtocol): ServeCredentials {
	if (protocol === "s3") {
		return {
			kind: "s3",
			accessKeyId: randomString("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 20),
			secretAccessKey: randomString(ALPHANUMERIC, 40)
		}
	}

	return { kind: "basic", user: `filen-${randomBytes(4).toString("hex")}`, password: randomBytes(32).toString("base64url") }
}

export const MIN_SECRET_LENGTH = 12

// Common passwords long enough to pass the length check.
const COMMON = new Set(["passwordpassword", "123456789012", "1234567890123", "qwertyuiop123", "administrator", "adminadminadmin"])

// Why stored or typed credentials cannot be kept: `invalid` ones rclone cannot take (a ":" or "," in them, an s3 key
// id that is not 16-128 letters and digits); `weak` ones are short, common, the user name again, or made of few
// distinct characters (the old client's admin/admin among them).
export function credentialsProblem(credentials: ServeCredentials): "invalid" | "weak" | null {
	const valid = credentials.kind === "basic" ? basicAuthSchema(credentials) : s3AuthSchema(credentials)

	if (valid instanceof type.errors) {
		return "invalid"
	}

	const [name, secret] =
		credentials.kind === "basic" ? [credentials.user, credentials.password] : [credentials.accessKeyId, credentials.secretAccessKey]
	const lower = secret.toLowerCase()

	return secret.length < MIN_SECRET_LENGTH || COMMON.has(lower) || lower === name.toLowerCase() || new Set(secret).size < 5
		? "weak"
		: null
}

const fileSchema = type({ version: "1", serves: type({ "[string]": "unknown" }), "+": "delete" })

const entrySchema = basicAuthSchema.or(s3AuthSchema)

type Stored = Partial<Record<CredentialProtocol, ServeCredentials>>

function parseStored(text: string, warn: (message: string) => void): Stored {
	let json: unknown

	try {
		json = JSON.parse(text)
	} catch {
		json = undefined
	}

	const file = fileSchema(json)

	if (file instanceof type.errors) {
		warn("mounts: the credentials file is invalid; starting empty")

		return {}
	}

	const stored: Stored = {}

	for (const protocol of CREDENTIAL_PROTOCOLS) {
		const value = file.serves[protocol]
		const entry = value === undefined ? undefined : entrySchema(value)

		if (entry instanceof type.errors || (entry !== undefined && entry.kind !== authKindOf(protocol))) {
			warn(`mounts: dropping invalid stored ${protocol} credentials`)
		} else if (entry !== undefined) {
			stored[protocol] = entry
		}
	}

	return stored
}

export interface CredentialStore {
	// null when none were made yet.
	get(protocol: CredentialProtocol): Promise<ServeCredentials | null>
	// The stored ones, or new random ones stored first.
	ensure(protocol: CredentialProtocol): Promise<ServeCredentials>
	regenerate(protocol: CredentialProtocol): Promise<ServeCredentials>
	// Credentials the user chose or the migration kept; the caller checked them with credentialsProblem.
	set(protocol: CredentialProtocol, credentials: ServeCredentials): Promise<void>
	// false: there is no secure storage (Linux basic_text, no OS encryption), so they last for this run only.
	persistent(): Promise<boolean>
}

// `<userData>/mounts/<userId>/credentials.bin`, decrypted once and served from memory. A file that cannot be decrypted
// now (a locked keychain) is read again on the next call and never overwritten, so the credentials in it are not
// lost; until then every call rejects. Without a cipher nothing is written.
export function createCredentialStore(
	file: AtomicFile,
	cipher: () => Promise<VaultCipher | null>,
	warn: (message: string) => void
): CredentialStore {
	let cached: Stored | undefined
	const serial = serialQueue()

	async function load(): Promise<Stored> {
		if (cached !== undefined) {
			return cached
		}

		const active = await cipher()

		if (active === null) {
			cached = {}

			return cached
		}

		const data = await file.read()

		if (data === null) {
			cached = {}

			return cached
		}

		let text: string
		let reEncrypt: boolean

		try {
			const decrypted = await active.decrypt(data)

			text = decrypted.result
			reEncrypt = decrypted.shouldReEncrypt
		} catch (error) {
			warn(`mounts: the credentials could not be decrypted: ${errorCode(error)}`)

			throw codedError("credentialsUnreadable")
		}

		cached = parseStored(text, warn)

		if (reEncrypt) {
			await store(cached).catch((error: unknown) => {
				warn(`mounts: credentials re-encryption failed: ${errorCode(error)}`)
			})
		}

		return cached
	}

	async function store(next: Stored): Promise<void> {
		const active = await cipher()

		if (active !== null) {
			await file.write(await active.encrypt(JSON.stringify({ version: 1, serves: next })))
		}

		cached = next
	}

	async function put(protocol: CredentialProtocol, credentials: ServeCredentials): Promise<ServeCredentials> {
		if (credentials.kind !== authKindOf(protocol)) {
			throw codedError("credentialsKind")
		}

		await store({ ...(await load()), [protocol]: credentials })

		return credentials
	}

	return {
		get: protocol => serial(async () => (await load())[protocol] ?? null),
		ensure: protocol => serial(async () => (await load())[protocol] ?? put(protocol, generateCredentials(protocol))),
		regenerate: protocol => serial(() => put(protocol, generateCredentials(protocol))),
		set: (protocol, credentials) =>
			serial(async () => {
				await put(protocol, credentials)
			}),
		persistent: async () => (await cipher()) !== null
	}
}
