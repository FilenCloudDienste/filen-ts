import { createHash } from "node:crypto"
import { scenarioModule } from "./scenarios"

// The text family's read-only files (preview-text-read.spec.ts): a legacy-encoded text the detector has to name,
// markdown with math and images a preview must never fetch, a torrent whose tracker must never be contacted,
// subtitles, a calendar and contacts naming addresses never fetched, a genomics `.vcf`, and executables and a disc
// image shown by their headers.

// Russian prose, long enough for the detector to settle on its codepage.
export const LEGACY_CYRILLIC_TEXT =
	"Съешь же ещё этих мягких французских булок, да выпей чаю.\n" +
	"Широкая электрификация южных губерний даст мощный толчок подъёму сельского хозяйства.\n" +
	"В чащах юга жил бы цитрус? Да, но фальшивый экземпляр!\n"

// The same bytes as KOI8-R reads them (Reopen with encoding), first line.
export const LEGACY_CYRILLIC_AS_KOI8_PREFIX = "яЗЕЬЭ ФЕ"

// Images by URL that the preview names instead of loading: one on a Filen host, one elsewhere.
export const MATH_REMOTE_IMAGES = ["https://cdn.filen.io/e2e-never-fetched.png", "https://example.com/e2e-never-fetched.png"] as const

export const MATH_MARKDOWN_TEXT =
	"# Formulas\n\n" +
	"Euler's identity $e^{i\\pi} + 1 = 0$ inline.\n\n" +
	"$$\n\\frac{a}{b} = \\sqrt{c}\n$$\n\n" +
	"It costs $5 and $10 today.\n\n" +
	`![chart](${MATH_REMOTE_IMAGES[0]}) ![photo](${MATH_REMOTE_IMAGES[1]})\n`

// A single-byte codepage's encoder, from the platform's own decoder (Node reads every WHATWG label).
export function encodeSingleByte(text: string, label: string): Buffer {
	const decoded = new TextDecoder(label).decode(Uint8Array.from({ length: 256 }, (_, byte) => byte))
	const table = new Map<string, number>()

	for (let byte = 255; byte >= 0; byte--) {
		table.set(decoded[byte] ?? "", byte)
	}

	// A single-byte codepage holds BMP characters only: one UTF-16 unit each.
	return Buffer.from(
		Array.from({ length: text.length }, (_, index) => {
			const char = text.charAt(index)
			const byte = table.get(char)

			if (byte === undefined) {
				throw new Error(`${label} has no byte for ${char}`)
			}

			return byte
		})
	)
}

// A v1 torrent of two files with one tracker, bencoded by hand (keys sorted, strings length-prefixed).
function bstring(value: string | Buffer): Buffer {
	const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value

	return Buffer.concat([Buffer.from(`${String(bytes.length)}:`), bytes])
}

const TORRENT_INFO = Buffer.concat([
	Buffer.from("d"),
	bstring("files"),
	Buffer.from("l"),
	Buffer.from("d"),
	bstring("length"),
	Buffer.from("i1000e"),
	bstring("path"),
	Buffer.from("l"),
	bstring("01 Intro.flac"),
	Buffer.from("e"),
	Buffer.from("e"),
	Buffer.from("d"),
	bstring("length"),
	Buffer.from("i2000e"),
	bstring("path"),
	Buffer.from("l"),
	bstring("cover.jpg"),
	Buffer.from("e"),
	Buffer.from("e"),
	Buffer.from("e"),
	bstring("name"),
	bstring("E2E Album"),
	bstring("piece length"),
	Buffer.from("i262144e"),
	bstring("pieces"),
	bstring(Buffer.alloc(20, 7)),
	Buffer.from("e")
])

// Addresses a browser could reach: the preview must still never contact them.
export const TORRENT_TRACKER = "https://tracker.e2e-never-contacted.example/announce"
export const TORRENT_WEB_SEED = "https://seed.e2e-never-contacted.example/album/"
export const TORRENT_INFOHASH = createHash("sha1").update(TORRENT_INFO).digest("hex")

const TORRENT_BYTES = Buffer.concat([
	Buffer.from("d"),
	bstring("announce"),
	bstring(TORRENT_TRACKER),
	bstring("info"),
	TORRENT_INFO,
	bstring("url-list"),
	bstring(TORRENT_WEB_SEED),
	Buffer.from("e")
])

// Subtitles: SubRip cues, a MicroDVD `.sub`, and a VobSub `.sub` (an MPEG program stream, which nothing previews).
export const SUBTITLE_SRT_TEXT =
	"1\r\n00:00:01,200 --> 00:00:03,900\r\nHello there.\r\n\r\n2\r\n00:00:04,000 --> 00:00:05,000\r\nGeneral Kenobi.\r\n"
export const SUBTITLE_MICRODVD_TEXT = "{25}{75}First line|second line\n{100}{150}Bye.\n"
const VOBSUB_BYTES = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0xba, 0x44, 0x00, 0x04, 0x00, 0x04, 0x01]), Buffer.alloc(2038)])

// A calendar with a weekly event and a to-do; a vCard file with two cards; a genomics Variant Call Format file under
// the same extension, which opens as text.
export const CALENDAR_TEXT = [
	"BEGIN:VCALENDAR",
	"VERSION:2.0",
	"X-WR-CALNAME:E2E Team",
	"BEGIN:VEVENT",
	"UID:planning@e2e",
	"SUMMARY:Planning",
	"LOCATION:Room 4",
	"DTSTART:20240304T100000Z",
	"DTEND:20240304T110000Z",
	"RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10",
	"URL:https://calendar.e2e-never-contacted.example/planning",
	"ATTACH:https://calendar.e2e-never-contacted.example/agenda.pdf",
	"END:VEVENT",
	"BEGIN:VTODO",
	"UID:taxes@e2e",
	"SUMMARY:File taxes",
	"DUE;VALUE=DATE:20240415",
	"END:VTODO",
	"END:VCALENDAR",
	""
].join("\r\n")
export const CONTACTS_TEXT = [
	"BEGIN:VCARD",
	"VERSION:4.0",
	"FN:Ada Lovelace",
	"ORG:Analytical Engines",
	"TEL;TYPE=cell:+44 7700 900123",
	"EMAIL:ada@example.com",
	"PHOTO;MEDIATYPE=image/png:https://contacts.e2e-never-contacted.example/ada.png",
	"END:VCARD",
	"BEGIN:VCARD",
	"VERSION:3.0",
	"N:Babbage;Charles;;;",
	"NOTE:Difference engine",
	"END:VCARD",
	""
].join("\r\n")
export const VARIANT_CALL_TEXT =
	"##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n20\t14370\trs6054257\tG\tA\t29\tPASS\tNS=3\n"

// An executable and a disc image, as small as their headers allow: a 64-bit ELF program, a PE32+ console program and an
// ISO 9660 image with a volume label.
function elfBytes(): Buffer {
	const bytes = Buffer.alloc(0x100)

	bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 3], 0)
	bytes.writeUInt16LE(2, 16)
	bytes.writeUInt16LE(62, 18)

	return bytes
}

function peBytes(): Buffer {
	const bytes = Buffer.alloc(0x200)
	const pe = 0x80
	const optional = pe + 24

	bytes.write("MZ", 0, "latin1")
	bytes.writeUInt32LE(pe, 0x3c)
	bytes.write("PE\0\0", pe, "latin1")
	bytes.writeUInt16LE(0x8664, pe + 4)
	bytes.writeUInt16LE(240, pe + 20)
	bytes.writeUInt16LE(0x22, pe + 22)
	bytes.writeUInt16LE(0x20b, optional)
	bytes.writeUInt16LE(3, optional + 68)
	bytes.writeUInt32LE(16, optional + 108)

	return bytes
}

export const ISO_VOLUME = "E2E_DISC"

function isoBytes(): Buffer {
	const bytes = Buffer.alloc(32768 + 2 * 2048)
	const primary = 32768

	bytes[primary] = 1
	bytes.write("CD001", primary + 1, "latin1")
	bytes.write(ISO_VOLUME.padEnd(32, " "), primary + 40, "latin1")
	bytes.writeUInt32LE(18, primary + 80)
	bytes.writeUInt16LE(2048, primary + 128)
	bytes[primary + 2048] = 255
	bytes.write("CD001", primary + 2048 + 1, "latin1")

	return bytes
}

// A message whose HTML asks for a remote picture, a remote stylesheet background and a link, shows its own inline
// picture (cid:), and carries a text attachment: nothing remote may load.
export const EMAIL_REMOTE = "https://mail.e2e-never-contacted.example"
export const EMAIL_SUBJECT = "E2E quarterly numbers"
export const EMAIL_ATTACHMENT_TEXT = "notes from an attachment"
const EMAIL_TEXT = [
	'From: "Anna Berg" <anna@example.com>',
	"To: me@example.com",
	`Subject: ${EMAIL_SUBJECT}`,
	"Date: Mon, 16 Nov 2026 09:14:00 +0000",
	"MIME-Version: 1.0",
	'Content-Type: multipart/mixed; boundary="outer"',
	"",
	"--outer",
	'Content-Type: multipart/related; boundary="rel"',
	"",
	"--rel",
	"Content-Type: text/html; charset=utf-8",
	"",
	`<html><head><style>body{background:url(${EMAIL_REMOTE}/bg.png)}</style></head><body><p>Hello <a href="${EMAIL_REMOTE}/q">the report</a></p><img src="cid:chart@e2e" alt="chart"><img src="${EMAIL_REMOTE}/pixel.gif" alt="pixel"></body></html>`,
	"--rel",
	"Content-Type: image/png",
	"Content-ID: <chart@e2e>",
	"Content-Disposition: inline",
	"Content-Transfer-Encoding: base64",
	"",
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"--rel--",
	"--outer",
	'Content-Type: text/plain; name="notes.txt"',
	'Content-Disposition: attachment; filename="notes.txt"',
	"",
	EMAIL_ATTACHMENT_TEXT,
	"--outer--",
	""
].join("\r\n")

// A notebook with highlighted code, a stream, an inline picture and an HTML output that names a remote picture: nothing
// remote may load.
export const NOTEBOOK_STREAM_TEXT = "e2e stream output"
const NOTEBOOK_TEXT = JSON.stringify({
	nbformat: 4,
	nbformat_minor: 5,
	metadata: { language_info: { name: "python", file_extension: ".py" } },
	cells: [
		{ cell_type: "markdown", metadata: {}, source: "# E2E notebook" },
		{
			cell_type: "code",
			execution_count: 4,
			metadata: {},
			source: "def total(values):\n    return sum(values)",
			outputs: [
				{ output_type: "stream", name: "stdout", text: `${NOTEBOOK_STREAM_TEXT}\n` },
				{
					output_type: "display_data",
					metadata: {},
					data: {
						"image/png": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
						"text/plain": "<Figure>"
					}
				},
				{
					output_type: "execute_result",
					execution_count: 4,
					metadata: {},
					data: { "text/html": `<table><tr><td>cell</td></tr></table><img src="${EMAIL_REMOTE}/nb.png" alt="remote">` }
				}
			]
		}
	]
})

export const TEXT_SCENARIOS = scenarioModule(
	{
		"preview-text-legacy": ["cyrillic-notes.txt"],
		"preview-markdown-math": ["formulas.md"],
		"preview-torrent": ["album.torrent"],
		"preview-subtitles": ["e2e-cues.srt", "e2e-microdvd.sub", "e2e-vobsub.sub"],
		"preview-pim": ["e2e-team.ics", "e2e-people.vcf", "e2e-variants.vcf"],
		"preview-binary-info": ["e2e-tool", "e2e-setup.exe", "e2e-disc.iso"],
		"preview-email": ["e2e-message.eml"],
		"preview-notebook": ["e2e-analysis.ipynb"]
	},
	() => ({
		"cyrillic-notes.txt": { buffer: encodeSingleByte(LEGACY_CYRILLIC_TEXT, "windows-1251"), mimeType: "text/plain" },
		"formulas.md": { buffer: Buffer.from(MATH_MARKDOWN_TEXT, "utf8"), mimeType: "text/markdown" },
		"album.torrent": { buffer: TORRENT_BYTES, mimeType: "application/x-bittorrent" },
		"e2e-cues.srt": { buffer: Buffer.from(SUBTITLE_SRT_TEXT, "utf8"), mimeType: "application/x-subrip" },
		"e2e-microdvd.sub": { buffer: Buffer.from(SUBTITLE_MICRODVD_TEXT, "utf8"), mimeType: "text/plain" },
		// Browsers type a .sub by its extension alone; only its first bytes say it is VobSub.
		"e2e-vobsub.sub": { buffer: VOBSUB_BYTES, mimeType: "application/octet-stream" },
		"e2e-team.ics": { buffer: Buffer.from(CALENDAR_TEXT, "utf8"), mimeType: "text/calendar" },
		"e2e-people.vcf": { buffer: Buffer.from(CONTACTS_TEXT, "utf8"), mimeType: "text/vcard" },
		// Typed as a vCard by its extension, as browsers do; its first line says otherwise.
		"e2e-variants.vcf": { buffer: Buffer.from(VARIANT_CALL_TEXT, "utf8"), mimeType: "text/vcard" },
		// No extension: opened as text, its head is an executable.
		"e2e-tool": { buffer: elfBytes(), mimeType: "application/octet-stream" },
		"e2e-setup.exe": { buffer: peBytes(), mimeType: "application/x-msdownload" },
		"e2e-disc.iso": { buffer: isoBytes(), mimeType: "application/x-iso9660-image" },
		"e2e-message.eml": { buffer: Buffer.from(EMAIL_TEXT, "utf8"), mimeType: "message/rfc822" },
		"e2e-analysis.ipynb": { buffer: Buffer.from(NOTEBOOK_TEXT, "utf8"), mimeType: "application/x-ipynb+json" }
	})
)
