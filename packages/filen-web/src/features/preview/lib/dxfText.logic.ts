import { DxfCodePoints } from "@/features/preview/lib/dxfFonts.logic"

// One read of a DXF before it is parsed: which characters its drawn text holds (the values of group codes 1 and 3, the
// text of TEXT, MTEXT, ATTRIB and dimension overrides, with the lines paired as the parser pairs them), and, when the
// header declared no encoding, whether the whole file is valid UTF-8 (else it is Windows-1252).

const TEXT_GROUP_CODES: ReadonlySet<number> = new Set([1, 3])

export interface DxfTextRead {
	readonly encoding: string
	readonly codePoints: ReadonlySet<number>
}

export class DxfTextScan {
	private readonly declared: string | null
	private readonly decoder: TextDecoder
	private readonly validator: TextDecoder | null
	private readonly collected = new DxfCodePoints()
	private valid = true
	// The unfinished last line, and whether the next line is a group code (lines alternate code, value).
	private partial = ""
	private codeLine = true
	private code = Number.NaN

	// `declared`: the encoding the header gave, or null to decide between UTF-8 and Windows-1252 here.
	public constructor(declared: string | null) {
		this.declared = declared
		this.decoder = new TextDecoder(declared ?? "utf-8")
		this.validator = declared === null ? new TextDecoder("utf-8", { fatal: true }) : null
	}

	public add(bytes: Uint8Array): void {
		if (this.validator !== null && this.valid) {
			try {
				this.validator.decode(bytes, { stream: true })
			} catch {
				this.valid = false
			}
		}

		this.lines(this.decoder.decode(bytes, { stream: true }), false)
	}

	public finish(): DxfTextRead {
		if (this.validator !== null && this.valid) {
			try {
				this.validator.decode()
			} catch {
				this.valid = false
			}
		}

		this.lines(this.decoder.decode(), true)

		const encoding = this.declared ?? (this.valid ? "utf-8" : "windows-1252")

		// Characters decoded as UTF-8 from a file that is not: only the escapes stand (Windows-1252 is the sans face's).
		return { encoding, codePoints: this.collected.codePoints(this.declared !== null || this.valid) }
	}

	private lines(chunk: string, last: boolean): void {
		let text = this.partial + chunk
		// A CR at the end may be the first half of a CRLF: kept for the next chunk.
		const keep = !last && text.endsWith("\r") ? 1 : 0
		const end = text.length - keep
		let start = 0

		for (const match of text.slice(0, end).matchAll(/\r\n|\r|\n/g)) {
			this.line(text.slice(start, match.index))
			start = match.index + match[0].length
		}

		text = text.slice(start)

		if (last) {
			this.line(text)
			this.partial = ""
		} else {
			this.partial = text
		}
	}

	private line(line: string): void {
		if (this.codeLine) {
			this.code = Number.parseInt(line, 10)
		} else if (TEXT_GROUP_CODES.has(this.code)) {
			this.collected.add(line)
		}

		this.codeLine = !this.codeLine
	}
}
