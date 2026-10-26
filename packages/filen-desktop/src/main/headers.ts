// Reads the web build's generated Cloudflare `_headers` file, so the shell serves exactly the headers the
// hosted app gets (COOP/COEP for the SDK's threads, the CSP) without restating them. Cloudflare semantics:
// every rule whose path matches applies in file order, a repeated header joins with a comma, and `! Name`
// removes what an earlier rule set.

type Operation = { kind: "set"; name: string; value: string } | { kind: "remove"; name: string }

export interface HeaderRule {
	pattern: RegExp
	operations: Operation[]
}

function patternFor(path: string): RegExp {
	const escaped = path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")

	return new RegExp(`^${escaped}$`)
}

export function parseHeaders(text: string): HeaderRule[] {
	const rules: HeaderRule[] = []

	for (const line of text.split("\n")) {
		if (line.trim() === "" || line.trimStart().startsWith("#")) {
			continue
		}

		if (!/^\s/.test(line)) {
			rules.push({ pattern: patternFor(line.trim()), operations: [] })

			continue
		}

		const rule = rules.at(-1)
		const entry = line.trim()

		if (rule === undefined) {
			continue
		}

		if (entry.startsWith("!")) {
			rule.operations.push({ kind: "remove", name: entry.slice(1).trim().toLowerCase() })

			continue
		}

		const colon = entry.indexOf(":")

		if (colon > 0) {
			rule.operations.push({ kind: "set", name: entry.slice(0, colon).trim().toLowerCase(), value: entry.slice(colon + 1).trim() })
		}
	}

	return rules
}

export function headersFor(rules: readonly HeaderRule[], pathname: string): Record<string, string> {
	const headers: Record<string, string> = {}

	for (const rule of rules) {
		if (!rule.pattern.test(pathname)) {
			continue
		}

		for (const operation of rule.operations) {
			if (operation.kind === "remove") {
				delete headers[operation.name]
			} else {
				const existing = headers[operation.name]

				headers[operation.name] = existing === undefined ? operation.value : `${existing}, ${operation.value}`
			}
		}
	}

	return headers
}
