import {
	URL_REGEX,
	TRAILING_PUNCT,
	PRIVATE_HOST
} from "@/constants"

export function trimUnbalanced(s: string, open: string, close: string): string {
	while (s.endsWith(close)) {
		const opens = (s.match(new RegExp(`\\${open}`, "g")) ?? []).length
		const closes = (s.match(new RegExp(`\\${close}`, "g")) ?? []).length

		if (closes > opens) {
			s = s.slice(0, -1)
		} else {
			break
		}
	}

	return s
}

export type ParsedLink = {
	url: string
	start: number
	end: number
}

export function extractLinks(text: string): ParsedLink[] {
	const links: ParsedLink[] = []

	for (const match of text.matchAll(URL_REGEX)) {
		let raw = match[0]
		const start = match.index

		raw = raw.replace(TRAILING_PUNCT, "")
		raw = trimUnbalanced(raw, "(", ")")
		raw = trimUnbalanced(raw, "[", "]")
		raw = trimUnbalanced(raw, "{", "}")

		if (raw.length < 4) {
			continue
		}

		const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`

		links.push({
			url,
			start,
			end: start + raw.length
		})
	}

	return links
}

export function safeParseUrl(raw: string): URL | null {
	try {
		const u = new URL(raw.trim())

		if (u.protocol !== "https:") {
			return null
		}

		if (u.username || u.password) {
			return null
		}

		const hostname = u.hostname.replace(/^\[|\]$/g, "")

		if (PRIVATE_HOST.some(p => p.test(hostname))) {
			return null
		}

		return u
	} catch {
		return null
	}
}
