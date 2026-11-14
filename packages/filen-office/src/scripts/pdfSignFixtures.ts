import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import * as asn1js from "asn1js"
import * as pkijs from "pkijs"

// Generates the signed-PDF fixtures in src/tests/fixtures/pdfsign/. The PDF structure is written by hand here and
// every signature is made by the system OpenSSL (`openssl cms -sign`, `openssl ts`), so the verifier is tested
// against a signer that shares no code with it. Keys and certificates are generated per run and discarded.
//
//   pnpm exec tsx src/scripts/pdfSignFixtures.ts [path/to/openssl]

const OUT = fileURLToPath(new URL("../tests/fixtures/pdfsign/", import.meta.url))
const OPENSSL = process.argv[2] ?? "openssl"
const CONTENTS_BYTES = 6000
const latin1 = (text: string): Buffer => Buffer.from(text, "latin1")

const work = mkdtempSync(join(tmpdir(), "pdfsign-"))
let serial = 1

function ossl(args: readonly string[], input?: Buffer): Buffer {
	return execFileSync(OPENSSL, args, { cwd: work, input, stdio: ["pipe", "pipe", "pipe"] })
}

function file(name: string): string {
	return join(work, name)
}

interface Identity {
	readonly key: string
	readonly cert: string
}

type KeySpec = readonly string[]

const RSA2048: KeySpec = ["-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048"]
const RSA1024: KeySpec = ["-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:1024"]
const curve = (name: string): KeySpec => ["-algorithm", "EC", "-pkeyopt", `ec_paramgen_curve:${name}`]
const ED25519: KeySpec = ["-algorithm", "ED25519"]

function key(name: string, spec: KeySpec): string {
	const path = file(`${name}.key`)

	ossl(["genpkey", ...spec, "-out", path])

	return path
}

function extensions(name: string, lines: readonly string[]): string {
	const path = file(`${name}.ext`)

	writeFileSync(path, lines.join("\n") + "\n")

	return path
}

const ROOT_KEY = key("root", RSA2048)
const ROOT: Identity = { key: ROOT_KEY, cert: file("root.crt") }

ossl(["req", "-x509", "-new", "-key", ROOT_KEY, "-subj", "/CN=Fixture Root CA/O=Filen Fixtures", "-days", "7300", "-out", ROOT.cert])

// A leaf issued by the fixture root (or self-signed), valid from notBefore to notAfter (YYYYMMDDHHMMSSZ).
function identity(
	name: string,
	spec: KeySpec,
	options: {
		readonly selfSigned?: boolean
		readonly notBefore?: string
		readonly notAfter?: string
		readonly ext?: readonly string[]
	} = {}
): Identity {
	const leafKey = key(name, spec)
	const cert = file(`${name}.crt`)
	const subject = `/CN=${name} signer/O=Filen Fixtures`
	const validity = [
		...(options.notBefore === undefined ? [] : ["-not_before", options.notBefore]),
		...(options.notAfter === undefined ? ["-days", "3650"] : ["-not_after", options.notAfter])
	]
	const ext = extensions(name, options.ext ?? ["keyUsage=critical,digitalSignature,nonRepudiation", "basicConstraints=CA:FALSE"])

	if (options.selfSigned === true) {
		ossl([
			"req",
			"-x509",
			"-new",
			"-key",
			leafKey,
			"-subj",
			subject,
			...validity,
			"-extensions",
			"v3",
			"-config",
			config(ext),
			"-out",
			cert
		])
	} else {
		const csr = file(`${name}.csr`)

		ossl(["req", "-new", "-key", leafKey, "-subj", subject, "-out", csr])
		ossl([
			"x509",
			"-req",
			"-in",
			csr,
			"-CA",
			ROOT.cert,
			"-CAkey",
			ROOT.key,
			"-set_serial",
			String(serial++ + 1000),
			...validity,
			"-extfile",
			ext,
			"-out",
			cert
		])
	}

	return { key: leafKey, cert }
}

function config(ext: string): string {
	const path = `${ext}.cnf`

	writeFileSync(path, `[req]\ndistinguished_name=dn\n[dn]\n[v3]\n${readFileSync(ext, "latin1")}`)

	return path
}

// ---- PDF writing ----

class PdfWriter {
	private readonly parts: Buffer[] = []
	private size = 0
	private readonly offsets = new Map<number, number>()
	private lastXref = -1
	objectCount = 0

	append(bytes: Buffer | string): void {
		const buffer = typeof bytes === "string" ? latin1(bytes) : bytes

		this.parts.push(buffer)
		this.size += buffer.length
	}

	object(num: number, body: string): void {
		this.offsets.set(num, this.size)
		this.objectCount = Math.max(this.objectCount, num)
		this.append(`${num} 0 obj\n${body}\nendobj\n`)
	}

	stream(num: number, dict: string, data: string): void {
		this.object(num, `<< ${dict} /Length ${latin1(data).length} >>\nstream\n${data}\nendstream`)
	}

	// Ends a revision: an xref section listing the objects written since the last one.
	revision(nums: readonly number[], trailer: string): void {
		const start = this.size
		const sorted = [...nums].sort((a, b) => a - b)
		let xref = "xref\n"

		if (this.lastXref < 0) {
			xref += `0 ${this.objectCount + 1}\n0000000000 65535 f \n`

			for (let num = 1; num <= this.objectCount; num++) xref += `${String(this.offsets.get(num) ?? 0).padStart(10, "0")} 00000 n \n`
		} else {
			xref += "0 1\n0000000000 65535 f \n"

			for (const num of sorted) xref += `${num} 1\n${String(this.offsets.get(num) ?? 0).padStart(10, "0")} 00000 n \n`
		}

		const prev = this.lastXref < 0 ? "" : ` /Prev ${this.lastXref}`

		this.append(`${xref}trailer\n<< /Size ${this.objectCount + 1} ${trailer}${prev} >>\nstartxref\n${start}\n%%EOF\n`)
		this.lastXref = start
	}

	bytes(): Buffer {
		return Buffer.concat(this.parts)
	}

	replace(bytes: Buffer): void {
		this.parts.length = 0
		this.parts.push(bytes)
		this.size = bytes.length
	}

	get length(): number {
		return this.size
	}
}

const ID = "[<0123456789ABCDEF0123456789ABCDEF> <0123456789ABCDEF0123456789ABCDEF>]"
const TRAILER = `/Root 1 0 R /Info 9 0 R /ID ${ID}`
// 1 catalog, 2 pages, 3 page, 4 content, 5 font, 6 AcroForm, 7 signature widget/field, 8 text field, 9 info
const PAGE_ANNOTS = "[7 0 R 8 0 R]"

function page(annots: string, extra = ""): string {
	return `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R /Annots ${annots}${extra} >>`
}

function base(): PdfWriter {
	const pdf = new PdfWriter()

	pdf.append("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
	pdf.object(1, "<< /Type /Catalog /Pages 2 0 R /AcroForm 6 0 R >>")
	pdf.object(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
	pdf.object(3, page(PAGE_ANNOTS))
	pdf.stream(4, "", "BT /F1 24 Tf 72 760 Td (Signed fixture) Tj ET")
	pdf.object(5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
	pdf.object(6, "<< /Fields [7 0 R 8 0 R] >>")
	pdf.object(7, "<< /Type /Annot /Subtype /Widget /FT /Sig /T (Signature1) /F 132 /Rect [72 600 272 660] /P 3 0 R >>")
	pdf.object(8, "<< /Type /Annot /Subtype /Widget /FT /Tx /T (Name) /F 4 /Rect [72 500 372 530] /P 3 0 R /DA (/F1 12 Tf 0 g) >>")
	pdf.object(9, "<< /Producer (Filen fixture generator) >>")
	pdf.revision([], TRAILER)

	return pdf
}

interface SignOptions {
	readonly signer: Identity
	readonly md?: string
	readonly pss?: boolean
	readonly subFilter?: "ETSI.CAdES.detached" | "adbe.pkcs7.detached" | "ETSI.RFC3161"
	// /Reference entries of a certification (DocMDP) or FieldMDP lock.
	readonly reference?: string
	readonly certify?: number
	// Bytes changed after the CMS was computed, or ByteRange values distorted, for attack fixtures.
	readonly tamper?: (bytes: Buffer, range: readonly [number, number, number, number]) => void
	readonly range?: (actual: readonly [number, number, number, number]) => readonly [number, number, number, number]
	readonly cms?: (data: Buffer) => Buffer
	readonly fieldNum?: number
	readonly fieldName?: string
	readonly rect?: string
}

function cmsSign(data: Buffer, options: SignOptions): Buffer {
	const input = file("data.bin")

	writeFileSync(input, data)

	const args = [
		"cms",
		"-sign",
		"-binary",
		"-in",
		input,
		"-signer",
		options.signer.cert,
		"-inkey",
		options.signer.key,
		"-outform",
		"DER",
		"-nosmimecap"
	]

	if (options.signer.cert !== ROOT.cert) args.push("-certfile", ROOT.cert)
	if (options.md !== undefined) args.push("-md", options.md)
	if (options.pss === true) args.push("-keyopt", "rsa_padding_mode:pss")

	return ossl(args)
}

// Appends a signing revision: the signature dictionary with placeholders, then ByteRange and Contents patched.
function sign(pdf: PdfWriter, options: SignOptions): void {
	const sigNum = pdf.objectCount + 1
	const fieldNum = options.fieldNum ?? 7
	const subFilter = options.subFilter ?? "ETSI.CAdES.detached"
	const reference = options.reference === undefined ? "" : ` /Reference [${options.reference}]`
	const placeholder = "/ByteRange [0 0000000000 0000000000 0000000000]"
	const filter =
		subFilter === "ETSI.RFC3161"
			? "/Type /DocTimeStamp"
			: "/Type /Sig /M (D:20260101120000+00'00') /Name (Fixture Signer) /Reason (Approval)"

	pdf.object(
		sigNum,
		`<< ${filter} /Filter /Adobe.PPKLite /SubFilter /${subFilter}${reference} ${placeholder} /Contents <${"0".repeat(CONTENTS_BYTES * 2)}> >>`
	)
	pdf.object(
		fieldNum,
		`<< /Type /Annot /Subtype /Widget /FT /Sig /T (${options.fieldName ?? "Signature1"}) /F 132 /Rect ${options.rect ?? "[72 600 272 660]"} /P 3 0 R /V ${sigNum} 0 R >>`
	)

	const updated = [sigNum, fieldNum]

	if (options.certify !== undefined) {
		pdf.object(1, `<< /Type /Catalog /Pages 2 0 R /AcroForm 6 0 R /Perms << /DocMDP ${sigNum} 0 R >> >>`)
		updated.push(1)
	}

	pdf.object(6, `<< /Fields [7 0 R 8 0 R${fieldNum > 9 ? ` ${fieldNum} 0 R` : ""}] /SigFlags 3 >>`)
	updated.push(6)
	pdf.revision(updated, TRAILER)

	const bytes = pdf.bytes()
	const sigAt = bytes.lastIndexOf(latin1(`${sigNum} 0 obj`))
	const lt = bytes.indexOf(latin1("/Contents <"), sigAt) + "/Contents ".length
	const gt = bytes.indexOf(latin1(">"), lt) + 1
	const actual = [0, lt, gt, bytes.length - gt] as const
	const range = options.range?.(actual) ?? actual
	const text = `/ByteRange [${range.join(" ")}]`
	const rangeAt = bytes.indexOf(latin1(placeholder), sigAt)

	bytes.write(text.padEnd(placeholder.length, " "), rangeAt, "latin1")

	const data = Buffer.concat([bytes.subarray(range[0], range[0] + range[1]), bytes.subarray(range[2], range[2] + range[3])])
	const der = options.cms?.(data) ?? (subFilter === "ETSI.RFC3161" ? timestampToken(data) : cmsSign(data, options))
	const hex = der.toString("hex").toUpperCase()

	if (hex.length > CONTENTS_BYTES * 2) throw new Error("signature larger than the placeholder")

	bytes.write(hex, lt + 1, "latin1")
	options.tamper?.(bytes, range)
	pdf.replace(bytes)
}

// ---- RFC 3161 ----

const TSA = identity("tsa", RSA2048, {
	ext: ["keyUsage=critical,digitalSignature", "extendedKeyUsage=critical,timeStamping", "basicConstraints=CA:FALSE"]
})
const TSA_CONFIG = file("tsa.cnf")

writeFileSync(
	TSA_CONFIG,
	[
		"[tsa]",
		"default_tsa=tsa_config",
		"[tsa_config]",
		`serial=${file("tsaserial")}`,
		"signer_digest=sha256",
		"default_policy=1.2.3.4.1",
		"digests=sha256,sha384,sha512",
		"accuracy=secs:1",
		"ess_cert_id_alg=sha256",
		"ordering=yes",
		"tsa_name=no",
		"ess_cert_id_chain=no"
	].join("\n") + "\n"
)
writeFileSync(file("tsaserial"), "01\n")

function timestampToken(data: Buffer): Buffer {
	writeFileSync(file("ts.bin"), data)
	ossl(["ts", "-query", "-data", file("ts.bin"), "-sha256", "-cert", "-no_nonce", "-out", file("ts.tsq")])
	ossl([
		"ts",
		"-reply",
		"-config",
		TSA_CONFIG,
		"-queryfile",
		file("ts.tsq"),
		"-signer",
		TSA.cert,
		"-inkey",
		TSA.key,
		"-chain",
		ROOT.cert,
		"-token_out",
		"-out",
		file("ts.tsr")
	])

	return readFileSync(file("ts.tsr"))
}

// A CMS signature with a signature timestamp (an RFC 3161 token over the signature value) as unsigned attribute.
function withSignatureTimestamp(der: Buffer): Buffer {
	const info = pkijs.ContentInfo.fromBER(der)
	const signed = new pkijs.SignedData({ schema: info.content })
	const signer = signed.signerInfos[0]

	if (signer === undefined) throw new Error("no signer")

	const token = timestampToken(Buffer.from(signer.signature.valueBlock.valueHexView))

	signer.unsignedAttrs = new pkijs.SignedAndUnsignedAttributes({
		type: 1,
		attributes: [new pkijs.Attribute({ type: "1.2.840.113549.1.9.16.2.14", values: [asn1js.fromBER(token).result] })]
	})

	return Buffer.from(
		new pkijs.ContentInfo({ contentType: pkijs.ContentInfo.SIGNED_DATA, content: signed.toSchema(true) }).toSchema().toBER()
	)
}

// ---- incremental changes after signing ----

function fillName(pdf: PdfWriter, value: string): void {
	pdf.object(
		8,
		`<< /Type /Annot /Subtype /Widget /FT /Tx /T (Name) /F 4 /Rect [72 500 372 530] /P 3 0 R /DA (/F1 12 Tf 0 g) /V (${value}) >>`
	)
	pdf.revision([8], TRAILER)
}

function annotate(pdf: PdfWriter): void {
	const num = pdf.objectCount + 1

	pdf.object(num, "<< /Type /Annot /Subtype /Text /Rect [400 700 420 720] /Contents (A note) /T (Reviewer) /P 3 0 R >>")
	pdf.object(3, page(`[7 0 R 8 0 R ${num} 0 R]`))
	pdf.revision([num, 3], TRAILER)
}

function changeContent(pdf: PdfWriter): void {
	pdf.stream(4, "", "BT /F1 24 Tf 72 760 Td (Replaced after signing) Tj ET")
	pdf.revision([4], TRAILER)
}

// ---- fixtures ----

const RSA = identity("rsa2048", RSA2048)
const fixtures = new Map<string, Buffer>()

function make(name: string, build: (pdf: PdfWriter) => void): void {
	const pdf = base()

	build(pdf)
	fixtures.set(name, pdf.bytes())
}

make("unsigned.pdf", () => undefined)
make("approval-rsa.pdf", pdf => sign(pdf, { signer: RSA }))
make("approval-pkcs7.pdf", pdf => sign(pdf, { signer: RSA, subFilter: "adbe.pkcs7.detached" }))
make("approval-rsa-sha512.pdf", pdf => sign(pdf, { signer: RSA, md: "sha512" }))
make("approval-pss.pdf", pdf => sign(pdf, { signer: RSA, pss: true }))
make("approval-p256.pdf", pdf => sign(pdf, { signer: identity("p256", curve("P-256")) }))
make("approval-p384.pdf", pdf => sign(pdf, { signer: identity("p384", curve("P-384")), md: "sha384" }))
make("approval-p521.pdf", pdf => sign(pdf, { signer: identity("p521", curve("P-521")), md: "sha512" }))
make("approval-ed25519.pdf", pdf => sign(pdf, { signer: identity("ed25519", ED25519), md: "sha512" }))
make("approval-selfsigned.pdf", pdf => sign(pdf, { signer: identity("self", RSA2048, { selfSigned: true }) }))
make("approval-expired.pdf", pdf =>
	sign(pdf, { signer: identity("expired", RSA2048, { notBefore: "20200101000000Z", notAfter: "20210101000000Z" }) })
)
make("approval-brainpool.pdf", pdf => sign(pdf, { signer: identity("brainpool", curve("brainpoolP256r1")) }))
make("approval-timestamped.pdf", pdf => sign(pdf, { signer: RSA, cms: data => withSignatureTimestamp(cmsSign(data, { signer: RSA })) }))
make("doc-timestamp.pdf", pdf => sign(pdf, { signer: TSA, subFilter: "ETSI.RFC3161" }))

const docMdp = (p: number, num: number): string =>
	`<< /Type /SigRef /TransformMethod /DocMDP /TransformParams << /Type /TransformParams /P ${p} /V /1.2 >> /Data ${num} 0 R >>`

for (const p of [1, 2, 3]) {
	make(`certified-p${p}.pdf`, pdf => sign(pdf, { signer: RSA, certify: p, reference: docMdp(p, 1) }))
	make(`certified-p${p}-filled.pdf`, pdf => {
		sign(pdf, { signer: RSA, certify: p, reference: docMdp(p, 1) })
		fillName(pdf, "Ada")
	})
	make(`certified-p${p}-annotated.pdf`, pdf => {
		sign(pdf, { signer: RSA, certify: p, reference: docMdp(p, 1) })
		annotate(pdf)
	})
}

make("approval-filled.pdf", pdf => {
	sign(pdf, { signer: RSA })
	fillName(pdf, "Ada")
})
make("approval-annotated.pdf", pdf => {
	sign(pdf, { signer: RSA })
	annotate(pdf)
})
make("approval-content-changed.pdf", pdf => {
	sign(pdf, { signer: RSA })
	changeContent(pdf)
})
// A FieldMDP lock on Name: filling it after signing is a change the signer did not allow.
make("fieldmdp-locked-filled.pdf", pdf => {
	sign(pdf, {
		signer: RSA,
		reference:
			"<< /Type /SigRef /TransformMethod /FieldMDP /TransformParams << /Type /TransformParams /Action /Include /Fields [(Name)] /V /1.2 >> >>"
	})
	fillName(pdf, "Mallory")
})
// Two approval signatures, the second after the first.
make("two-signatures.pdf", pdf => {
	sign(pdf, { signer: RSA })

	const field = pdf.objectCount + 1

	pdf.object(field, "<< /Type /Annot /Subtype /Widget /FT /Sig /T (Signature2) /F 132 /Rect [300 600 500 660] /P 3 0 R >>")
	pdf.object(3, page(`[7 0 R 8 0 R ${field} 0 R]`))
	pdf.revision([field, 3], TRAILER)
	sign(pdf, { signer: identity("second", curve("P-256")), fieldNum: field, fieldName: "Signature2", rect: "[300 600 500 660]" })
})

// ---- tampered and attack fixtures (all must verify as invalid) ----

make("tampered-in-range.pdf", pdf =>
	sign(pdf, {
		signer: RSA,
		tamper: bytes => {
			const at = bytes.indexOf(latin1("(Signed fixture)")) + 1

			bytes.write("s", at, "latin1")
		}
	})
)
// The gap starts one byte before the `<` of /Contents, so a byte outside the hex string is unsigned.
make("gap-wider-than-contents.pdf", pdf => sign(pdf, { signer: RSA, range: ([a, b, c, d]) => [a, b - 1, c, d] }))
// The second range stops short of the revision's %%EOF, leaving its trailer unsigned.
make("range-not-at-eof.pdf", pdf => sign(pdf, { signer: RSA, range: ([a, b, c, d]) => [a, b, c, d - 20] }))
make("two-signer-infos.pdf", pdf =>
	sign(pdf, {
		signer: RSA,
		cms: data => {
			const first = file("first.der")
			const content = file("content.bin")
			const second = identity("cosigner", RSA2048)

			writeFileSync(first, cmsSign(data, { signer: RSA }))
			writeFileSync(content, data)

			return ossl([
				"cms",
				"-resign",
				"-binary",
				"-inform",
				"DER",
				"-in",
				first,
				"-content",
				content,
				"-signer",
				second.cert,
				"-inkey",
				second.key,
				"-outform",
				"DER",
				"-nosmimecap"
			])
		}
	})
)
make("sha1.pdf", pdf => sign(pdf, { signer: RSA, md: "sha1" }))
make("rsa1024.pdf", pdf => sign(pdf, { signer: identity("rsa1024", RSA1024) }))
// Signature wrapping: the gap holds the hex string plus bytes after its `>` (where an attacker hides objects).
make("wrapping.pdf", pdf =>
	sign(pdf, {
		signer: RSA,
		range: ([a, b, c, d]) => [a, b, c + 8, d - 8]
	})
)
// Incremental saving attack: a later revision redefines the signature dictionary with a ByteRange covering the
// whole file, so a naive check of "the signature covers the file" passes.
make("isa-redefined-sig.pdf", pdf => {
	sign(pdf, { signer: RSA })

	const bytes = pdf.bytes()
	const sigNum = 10
	const sigAt = bytes.lastIndexOf(latin1(`${sigNum} 0 obj`))
	const end = bytes.indexOf(latin1("endobj"), sigAt)
	const original = bytes.subarray(sigAt, end).toString("latin1")
	const contents = /\/Contents <([0-9A-F]+)>/.exec(original)?.[1] ?? ""

	pdf.stream(4, "", "BT /F1 24 Tf 72 760 Td (Shadowed content) Tj ET")
	pdf.revision([4], TRAILER)

	const total = pdf.length + 400
	const lt = bytes.indexOf(latin1("/Contents <"), sigAt) + "/Contents ".length

	pdf.object(
		sigNum,
		`<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached /ByteRange [0 ${lt} ${lt + contents.length + 2} ${total}] /Contents <${contents}> >>`
	)
	pdf.revision([sigNum], TRAILER)
})
// Shadow attack (hide-and-replace): the signed revision carries an unused page content; a later revision swaps it
// in through the page dictionary only.
make("shadow-hide-replace.pdf", pdf => {
	pdf.stream(20, "", "BT /F1 24 Tf 72 760 Td (Pay 1,000,000 to Mallory) Tj ET")
	pdf.revision([20], TRAILER)
	sign(pdf, { signer: RSA })
	pdf.object(
		3,
		`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 20 0 R /Annots ${PAGE_ANNOTS} >>`
	)
	pdf.revision([3], TRAILER)
})
// Bytes appended after the signed revision without an xref section (viewers repair and show them).
make("appended-without-xref.pdf", pdf => {
	sign(pdf, { signer: RSA })
	pdf.append("4 0 obj\n<< /Length 44 >>\nstream\nBT /F1 24 Tf 72 760 Td (Appended text) Tj ET\nendstream\nendobj\n")
})

mkdirSync(OUT, { recursive: true })

for (const [name, bytes] of fixtures) writeFileSync(join(OUT, name), bytes)

rmSync(work, { recursive: true, force: true })
console.log(`wrote ${fixtures.size} fixtures to ${OUT}`)
