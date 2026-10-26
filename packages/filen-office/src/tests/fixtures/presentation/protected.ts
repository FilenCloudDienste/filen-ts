import { strToU8, zipSync } from "fflate"
import { createHash } from "node:crypto"
import { copyFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { cfbBytes } from "@filen/office/core/cfb"
import {
	dataSpaceDefinitionStream,
	dataSpaceMapStream,
	dataSpaceVersionStream,
	transformPrimaryStream
} from "@filen/office/core/encryption"
import { CORPUS_DIR } from "../../corpusDir"

// Protected, rights-managed and ambiguous presentation inputs for the refusal, gate and routing tests. Everything is
// built here or committed beside this file; no third-party bytes are kept in the repository.

// A one-slide ODP stored encrypted by LibreOffice 7.5 over UNO (ODF package encryption: AES-256-CBC, PBKDF2 with
// 100,000 iterations, SHA-256 start key). LibreOffice salts it at random, so it is committed rather than rebuilt.
export const ENCRYPTED_ODP = join(import.meta.dirname, "encrypted.odp")
export const ENCRYPTED_ODP_PASSWORD = "filen"

// A gettext template: the text file a .pot extension also names.
export const GETTEXT_POT = join(import.meta.dirname, "gettext.pot")

const P = "http://schemas.openxmlformats.org/presentationml/2006/main"
const A = "http://schemas.openxmlformats.org/drawingml/2006/main"
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const RELS = "http://schemas.openxmlformats.org/package/2006/relationships"
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

const EMPTY_TREE =
	'<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
	'<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>' +
	'<p:spPr><a:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="1143000"/></a:xfrm></p:spPr>' +
	'<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>TEXT</a:t></a:r></a:p></p:txBody></p:sp>' +
	"</p:spTree></p:cSld>"

const THEME =
	`<a:theme xmlns:a="${A}" name="Plain"><a:themeElements>` +
	'<a:clrScheme name="Plain"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>' +
	'<a:dk2><a:srgbClr val="1F1F1F"/></a:dk2><a:lt2><a:srgbClr val="EEEEEE"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1>' +
	'<a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>' +
	'<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink>' +
	'<a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>' +
	'<a:fontScheme name="Plain"><a:majorFont><a:latin typeface="Carlito"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
	'<a:minorFont><a:latin typeface="Carlito"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
	'<a:fmtScheme name="Plain"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
	'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
	'<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
	"</a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle>" +
	'<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
	'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>' +
	"</a:themeElements></a:theme>"

const COLOR_MAP =
	'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"'

function relationships(entries: readonly (readonly [id: string, type: string, target: string])[]): string {
	return `${XML}<Relationships xmlns="${RELS}">${entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join("")}</Relationships>`
}

// A one-slide pptx with a master, a layout and a theme; `protection` goes where ECMA-376 Part 1 §19.2.1.26 orders
// p:modifyVerifier (after p:defaultTextStyle). Deterministic: fixed zip times.
export function minimalPptx(title: string, protection = ""): Uint8Array {
	const ns = `xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"`
	const files: Record<string, string> = {
		"[Content_Types].xml":
			`${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
			'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
			'<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
			'<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
			'<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
			'<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' +
			'<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>',
		"_rels/.rels": relationships([["rId1", "officeDocument", "ppt/presentation.xml"]]),
		"ppt/presentation.xml":
			`${XML}<p:presentation ${ns}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
			'<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000" type="screen4x3"/>' +
			`<p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle/>${protection}</p:presentation>`,
		"ppt/_rels/presentation.xml.rels": relationships([
			["rId1", "slideMaster", "slideMasters/slideMaster1.xml"],
			["rId2", "slide", "slides/slide1.xml"],
			["rId3", "theme", "theme/theme1.xml"]
		]),
		"ppt/slideMasters/slideMaster1.xml":
			`${XML}<p:sldMaster ${ns}>${EMPTY_TREE.replace("TEXT", "")}<p:clrMap ${COLOR_MAP}/>` +
			'<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>',
		"ppt/slideMasters/_rels/slideMaster1.xml.rels": relationships([
			["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"],
			["rId2", "theme", "../theme/theme1.xml"]
		]),
		"ppt/slideLayouts/slideLayout1.xml": `${XML}<p:sldLayout ${ns} type="title">${EMPTY_TREE.replace("TEXT", "")}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
		"ppt/slideLayouts/_rels/slideLayout1.xml.rels": relationships([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]]),
		"ppt/slides/slide1.xml": `${XML}<p:sld ${ns}>${EMPTY_TREE.replace("TEXT", title)}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`,
		"ppt/slides/_rels/slide1.xml.rels": relationships([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"]]),
		"ppt/theme/theme1.xml": `${XML}${THEME}`
	}

	return zipSync(
		Object.fromEntries(Object.entries(files).map(([path, text]) => [path, [strToU8(text), { mtime: new Date(2020, 0, 1) }]]))
	)
}

// p:modifyVerifier's password and parameters: SHA-512, a fixed salt, the ISO hash of [MS-OFFCRYPTO] §2.4.2.4
// (H0 = H(salt + UTF-16LE password), Hn = H(Hn-1 + LE32(n-1))). A small spin count keeps the tests fast.
export const MODIFY_PASSWORD = "filen"
export const MODIFY_SPIN_COUNT = 1000
const MODIFY_SALT = Uint8Array.from({ length: 16 }, (_, index) => index + 1)

function modifyHash(password: string): string {
	let hash = createHash("sha512").update(MODIFY_SALT).update(Buffer.from(password, "utf16le")).digest()

	for (let index = 0; index < MODIFY_SPIN_COUNT; index++) {
		const counter = Buffer.alloc(4)

		counter.writeUInt32LE(index)
		hash = createHash("sha512").update(hash).update(counter).digest()
	}

	return hash.toString("base64")
}

// A pptx with a write-reservation password (opens view-only until MODIFY_PASSWORD is given).
export function modifyVerifierPptx(): Uint8Array {
	const salt = Buffer.from(MODIFY_SALT).toString("base64")

	return minimalPptx(
		"Reserved",
		`<p:modifyVerifier algorithmName="SHA-512" hashValue="${modifyHash(MODIFY_PASSWORD)}" saltValue="${salt}" spinValue="${MODIFY_SPIN_COUNT}"/>`
	)
}

// The Information Rights Management layout of an ECMA-376 document ([MS-OFFCRYPTO] §2.2.1–§2.2.6, §2.2.10): the
// EncryptedPackage stream mapped to DRMEncryptedDataSpace, whose one transform is the DRM transform with an XrML
// issuance licence. The licence and the protected content are placeholders: no rights server issued them.
export function irmPptx(): Promise<Uint8Array> {
	const licence = strToU8('<?xml version="1.0"?><XrML version="1.2"><BODY type="Microsoft Rights Label"/></XrML>')
	const primary = transformPrimaryStream("{C73DFACD-061F-43B0-8B64-0C620D2A8B50}", "Microsoft.Metadata.DRMTransform", false)
	// IRMDSTransformInfo (§2.2.6): TransformInfoHeader, ExtensibilityHeader (length 4), UTF-8-LP-P4 licence.
	const padded = Math.ceil(licence.length / 4) * 4
	const transform = new Uint8Array(primary.length + 8 + padded)
	const view = new DataView(transform.buffer)

	transform.set(primary)
	view.setUint32(primary.length, 4, true)
	view.setUint32(primary.length + 4, licence.length, true)
	transform.set(licence, primary.length + 8)

	// The protected content stream: StreamSize (8 bytes) then ciphertext no key here can open.
	const content = new Uint8Array(8 + 4096)

	new DataView(content.buffer).setUint32(0, 4096, true)
	content.fill(0xa5, 8)

	return cfbBytes([
		{ path: ["\u0006DataSpaces", "Version"], bytes: dataSpaceVersionStream() },
		{
			path: ["\u0006DataSpaces", "DataSpaceMap"],
			bytes: dataSpaceMapStream([{ components: ["EncryptedPackage"], dataSpace: "DRMEncryptedDataSpace" }])
		},
		{
			path: ["\u0006DataSpaces", "DataSpaceInfo", "DRMEncryptedDataSpace"],
			bytes: dataSpaceDefinitionStream(["DRMEncryptedTransform"])
		},
		{ path: ["\u0006DataSpaces", "TransformInfo", "DRMEncryptedTransform", "\u0006Primary"], bytes: transform },
		{ path: ["EncryptedPackage"], bytes: content }
	])
}

// The corpus .ppt the routing copies are made of (corpus/manifest.json pins it).
export const ROUTING_SOURCE = {
	path: "ppt/poi__Single_Coloured_Page.ppt",
	sha256: "120fd65304563887738ae9cfa1f366389acf9bddb40fefab4693e4653b50f9d0"
}

// Copies of ROUTING_SOURCE named .pps and .pot in `directory` (a slide show and a template are the same binary
// format), or undefined while the corpus is not fetched.
export function routingCopies(directory: string): { readonly pps: string; readonly pot: string } | undefined {
	const source = join(CORPUS_DIR, ROUTING_SOURCE.path)

	if (!existsSync(source)) return undefined

	const pps = join(directory, "Single_Coloured_Page.pps")
	const pot = join(directory, "Single_Coloured_Page.pot")

	copyFileSync(source, pps)
	copyFileSync(source, pot)

	return { pps, pot }
}
