import { buildZip, prng } from "../helpers/archiveFixtures"
import { JPEG_BYTES } from "../helpers/fixtureBytes"
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

// A compiled gettext catalog's header: little-endian magic, then NULs.
const MO_BYTES = Buffer.concat([Buffer.from([0xde, 0x12, 0x04, 0x95]), Buffer.alloc(28)])

export const ROUTING_SCENARIOS = scenarioModule(
	{
		"routing-code": ["routing-config.yml", "routing-blob.mo"],
		"routing-text": ["routing-subs.srt", "routing-latin1.srt", "routing-mail.eml"],
		"routing-images": ["routing-photo.jfif", "routing-generic.jpg"],
		// Synthesized on disk (over 8 MiB), so it is a scenario of its own; the browser types it by its extension.
		"routing-package": ["routing-app.apk"]
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
		"routing-app.apk": {
			generate: () =>
				buildZip([
					{ name: "AndroidManifest.xml", data: "<manifest/>\n" },
					{ name: ROUTING_PACKAGE_ENTRY, data: prng(17)(ROUTING_PACKAGE_ENTRY_BYTES), method: "stored" }
				])
		}
	})
)
