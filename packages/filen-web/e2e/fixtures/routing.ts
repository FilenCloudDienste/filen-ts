import { crc32 } from "node:zlib"
import { buildZip, prng } from "../helpers/archiveFixtures"
import { JPEG_BYTES, PNG_BYTES } from "../helpers/fixtureBytes"
import { scenarioModule } from "./scenarios"

// The routing spec's files (preview-routing.spec.ts): extensions that open in an existing viewer by their name or by
// what their stored type says, and the ones that must not.

// One stored entry big enough to put the package past the archive gate's 8 MiB.
export const ROUTING_PACKAGE_ENTRY = "classes.dex"
export const ROUTING_PACKAGE_ENTRY_BYTES = 9 * 1024 * 1024

export const ROUTING_YAML_TEXT = "name: routing\nitems:\n  - one\n  - two\n"
export const ROUTING_SUBTITLE_TEXT = "1\n00:00:01,000 --> 00:00:02,000\nHello from a subtitle\n"
// Windows-1252 (not UTF-8, so the editor opens read-only): the cue's line as it reads once decoded.
export const ROUTING_LATIN1_LINE = "Café crème à la carte"
export const ROUTING_MAIL_TEXT = "From: a@example.com\r\nTo: b@example.com\r\nSubject: Routing probe\r\n\r\nHello from a message\r\n"

// The one entry of the Chrome extension fixture.
export const ROUTING_EXTENSION_ENTRY = "manifest.json"

// A PNG chunk: its data's length, the type, the data, then a CRC over type and data.
function pngChunk(type: string, data: Buffer): Buffer {
	const body = Buffer.concat([Buffer.from(type, "latin1"), data])
	const head = Buffer.alloc(4)
	const tail = Buffer.alloc(4)

	head.writeUInt32BE(data.length)
	tail.writeUInt32BE(crc32(body))

	return Buffer.concat([head, body, tail])
}

// The fixture PNG as a one-frame APNG: acTL and the frame's fcTL after IHDR (signature 8 + IHDR chunk 25 bytes), the
// default image as that frame.
function apngBytes(): Buffer {
	const actl = Buffer.alloc(8)
	const fctl = Buffer.alloc(26)

	actl.writeUInt32BE(1, 0)
	fctl.writeUInt32BE(0, 0)
	fctl.writeUInt32BE(PNG_BYTES.readUInt32BE(16), 4)
	fctl.writeUInt32BE(PNG_BYTES.readUInt32BE(20), 8)

	return Buffer.concat([PNG_BYTES.subarray(0, 33), pngChunk("acTL", actl), pngChunk("fcTL", fctl), PNG_BYTES.subarray(33)])
}

// An icon of one PNG-encoded 32 bpp entry at the PNG's size: ICONDIR, one ICONDIRENTRY, the PNG.
function icoBytes(): Buffer {
	const header = Buffer.alloc(22)

	header.writeUInt16LE(1, 2)
	header.writeUInt16LE(1, 4)
	header.writeUInt8(PNG_BYTES.readUInt32BE(16), 6)
	header.writeUInt8(PNG_BYTES.readUInt32BE(20), 7)
	header.writeUInt16LE(1, 10)
	header.writeUInt16LE(32, 12)
	header.writeUInt32LE(PNG_BYTES.length, 14)
	header.writeUInt32LE(header.length, 18)

	return Buffer.concat([header, PNG_BYTES])
}

// A CRX3 Chrome extension: `Cr24`, version 3, the signed header's length and an opaque header, then a plain zip.
function crxBytes(): Buffer {
	const head = Buffer.alloc(12)
	const signedHeader = Buffer.alloc(64, 0xa5)

	head.write("Cr24", 0, "latin1")
	head.writeUInt32LE(3, 4)
	head.writeUInt32LE(signedHeader.length, 8)

	return Buffer.concat([head, signedHeader, buildZip([{ name: ROUTING_EXTENSION_ENTRY, data: "{}\n" }])])
}

// A compiled gettext catalog's header: little-endian magic, then NULs.
const MO_BYTES = Buffer.concat([Buffer.from([0xde, 0x12, 0x04, 0x95]), Buffer.alloc(28)])

export const ROUTING_SCENARIOS = scenarioModule(
	{
		"routing-code": ["routing-config.yml", "routing-blob.mo"],
		"routing-text": ["routing-subs.srt", "routing-latin1.srt", "routing-mail.eml"],
		"routing-images": ["routing-photo.jfif", "routing-generic.jpg"],
		// Synthesized on disk (over 8 MiB), so it is a scenario of its own; the browser types it by its extension.
		"routing-package": ["routing-app.apk"],
		// Thumbnailed by the SDK, which the client never decodes itself.
		"routing-thumbnails": ["routing-icon.ico", "routing-animation.apng"],
		// No extension of the SDK's lists it; it reads the zip by its bytes.
		"routing-extension": ["routing-extension.crx"]
	},
	() => ({
		"routing-config.yml": { buffer: Buffer.from(ROUTING_YAML_TEXT, "utf8"), mimeType: "application/x-yaml" },
		"routing-blob.mo": { buffer: MO_BYTES, mimeType: "application/octet-stream" },
		"routing-subs.srt": { buffer: Buffer.from(ROUTING_SUBTITLE_TEXT, "utf8"), mimeType: "application/x-subrip" },
		"routing-latin1.srt": {
			buffer: Buffer.from(`1\n00:00:01,000 --> 00:00:02,000\n${ROUTING_LATIN1_LINE}\n`, "latin1"),
			mimeType: "text/plain"
		},
		"routing-mail.eml": { buffer: Buffer.from(ROUTING_MAIL_TEXT, "utf8"), mimeType: "message/rfc822" },
		"routing-photo.jfif": { buffer: JPEG_BYTES, mimeType: "image/jpeg" },
		// A generic type: the inline route serves it by its extension.
		"routing-generic.jpg": { buffer: JPEG_BYTES, mimeType: "application/octet-stream" },
		"routing-icon.ico": { buffer: icoBytes(), mimeType: "image/x-icon" },
		"routing-animation.apng": { buffer: apngBytes(), mimeType: "image/apng" },
		"routing-extension.crx": { buffer: crxBytes(), mimeType: "application/x-chrome-extension" },
		"routing-app.apk": {
			generate: () =>
				buildZip([
					{ name: "AndroidManifest.xml", data: "<manifest/>\n" },
					{ name: ROUTING_PACKAGE_ENTRY, data: prng(17)(ROUTING_PACKAGE_ENTRY_BYTES), method: "stored" }
				])
		}
	})
)
