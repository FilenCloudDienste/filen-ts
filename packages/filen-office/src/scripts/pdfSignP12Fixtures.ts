import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import forge from "node-forge"

// Generates the PKCS#12 fixtures in src/tests/fixtures/pdfsign/p12/ for the certificate signer. Keys, certificates and
// containers come from the system OpenSSL (`openssl genpkey`, `req`, `x509`, `pkcs12 -export`), so the importer is
// tested against files it shares no code with; the one container OpenSSL refuses to write (a key with another key's
// certificate) is written by node-forge. Every leaf is issued by a fixture root, which each container carries.
// Generated with OpenSSL 4.1.0; keys are discarded after each run.
//
//   pnpm exec tsx src/scripts/pdfSignP12Fixtures.ts [path/to/openssl]

const OUT = fileURLToPath(new URL("../tests/fixtures/pdfsign/p12/", import.meta.url))
const OPENSSL = process.argv[2] ?? "openssl"
// Every container's password, except the non-ASCII ones.
const P12_PASSWORD = "fixture-password"
// Non-ASCII, with a character outside Latin-1: PBKDF2 takes it as UTF-8, the PKCS#12 MAC and legacy PBE as BMPString.
const P12_UNICODE_PASSWORD = "Pässwörd-密码"

const work = mkdtempSync(join(tmpdir(), "pdfsign-p12-"))
let serial = 1

function ossl(args: readonly string[]): Buffer {
	return execFileSync(OPENSSL, args, { cwd: work, stdio: ["pipe", "pipe", "pipe"] })
}

function file(name: string): string {
	return join(work, name)
}

function key(name: string, spec: readonly string[]): string {
	const path = file(`${name}.key`)

	ossl(["genpkey", ...spec, "-out", path])

	return path
}

const EXT = file("leaf.ext")

writeFileSync(EXT, "keyUsage=critical,digitalSignature,nonRepudiation\nbasicConstraints=CA:FALSE\n")

const ROOT_KEY = key("root", ["-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048"])
const ROOT_CERT = file("root.crt")

ossl(["req", "-x509", "-new", "-key", ROOT_KEY, "-subj", "/CN=Fixture Signing Root/O=Filen Fixtures", "-days", "7300", "-out", ROOT_CERT])

// A leaf for `keyPath` issued by the fixture root.
function leaf(name: string, keyPath: string): string {
	const csr = file(`${name}.csr`)
	const cert = file(`${name}.crt`)

	ossl(["req", "-new", "-key", keyPath, "-subj", `/CN=${name} signer/O=Filen Fixtures`, "-out", csr])
	ossl([
		"x509",
		"-req",
		"-in",
		csr,
		"-CA",
		ROOT_CERT,
		"-CAkey",
		ROOT_KEY,
		"-set_serial",
		String(2000 + serial++),
		"-days",
		"3650",
		"-extfile",
		EXT,
		"-out",
		cert
	])

	return cert
}

const fixtures = new Map<string, Buffer>()

// `pkcs12 -export` of the key, its leaf and the root. OpenSSL 4's default: PBES2 (PBKDF2-HMAC-SHA256, AES-256-CBC) for
// both bags, an HMAC-SHA256 MAC.
function p12(
	name: string,
	spec: readonly string[],
	options: { readonly password?: string; readonly extra?: readonly string[] } = {}
): void {
	const keyPath = key(name, spec)
	const cert = leaf(name, keyPath)
	const out = file(`${name}.p12`)

	ossl([
		"pkcs12",
		"-export",
		"-inkey",
		keyPath,
		"-in",
		cert,
		"-certfile",
		ROOT_CERT,
		"-name",
		`${name} signer`,
		"-passout",
		`pass:${options.password ?? P12_PASSWORD}`,
		...(options.extra ?? []),
		"-out",
		out
	])
	fixtures.set(`${name}.p12`, readFileSync(out))
}

const RSA2048 = ["-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048"]
const curve = (curveName: string): string[] => ["-algorithm", "EC", "-pkeyopt", `ec_paramgen_curve:${curveName}`]
// The legacy defaults of older exports (macOS Keychain, Windows): 3DES-encrypted key, SHA-1 MAC; -legacy adds RC2-40 for
// the certificates.
const TRIPLE_DES = ["-keypbe", "PBE-SHA1-3DES", "-certpbe", "PBE-SHA1-3DES", "-macalg", "sha1"]

p12("rsa2048", RSA2048)
p12("rsa4096", ["-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:4096"])
p12("rsapss", ["-algorithm", "RSA-PSS", "-pkeyopt", "rsa_keygen_bits:2048"])
p12("p256", curve("P-256"))
p12("p384", curve("P-384"))
p12("p521", curve("P-521"))
p12("ed25519", ["-algorithm", "ED25519"])
p12("brainpool", curve("brainpoolP256r1"))
p12("rsa1024", ["-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:1024"])
p12("legacy-rc2", RSA2048, { extra: ["-legacy"] })
p12("legacy-3des", RSA2048, { extra: TRIPLE_DES })
p12("legacy-3des-p256", curve("P-256"), { extra: TRIPLE_DES })
p12("unicode", RSA2048, { password: P12_UNICODE_PASSWORD })
p12("unicode-3des", RSA2048, { password: P12_UNICODE_PASSWORD, extra: TRIPLE_DES })

// A key with a certificate for another key: OpenSSL will not export that, node-forge does.
const otherKey = key("other", RSA2048)
const otherCert = leaf("other", otherKey)
const mismatchKey = forge.pki.privateKeyFromPem(readFileSync(key("mismatch", RSA2048), "utf8"))
const mismatch = forge.pkcs12.toPkcs12Asn1(
	mismatchKey,
	[forge.pki.certificateFromPem(readFileSync(otherCert, "utf8")), forge.pki.certificateFromPem(readFileSync(ROOT_CERT, "utf8"))],
	P12_PASSWORD,
	{ algorithm: "aes256", friendlyName: "mismatch signer" }
)

fixtures.set("mismatch.p12", Buffer.from(forge.asn1.toDer(mismatch).getBytes(), "binary"))

mkdirSync(OUT, { recursive: true })

for (const [name, bytes] of fixtures) writeFileSync(join(OUT, name), bytes)

rmSync(work, { recursive: true, force: true })
console.log(`wrote ${fixtures.size} fixtures to ${OUT}`)
