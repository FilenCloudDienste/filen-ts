import { inflateSync } from "node:zlib"

// A PDF's syntax as text, its FlateDecode streams (object streams included) inflated in place: the writer keeps
// most dictionaries in compressed object streams, so a structure key is only found after decoding. An encrypted
// stream does not inflate and stays as written.
export function pdfSyntax(bytes: Buffer): string {
	const raw = bytes.toString("latin1")
	const parts: string[] = [raw]
	const pattern = /stream\r?\n/g
	let match: RegExpExecArray | null

	while ((match = pattern.exec(raw)) !== null) {
		const start = match.index + match[0].length
		const end = raw.indexOf("endstream", start)

		if (end < 0) break

		try {
			parts.push(inflateSync(bytes.subarray(start, end)).toString("latin1"))
		} catch {
			// Not deflated, or encrypted.
		}
	}

	return parts.join("\n")
}
