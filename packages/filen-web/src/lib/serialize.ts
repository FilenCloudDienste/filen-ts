const BIG = "$bigint:"
const ESC = "$str:"

export function stringifyEnvelope(value: unknown): string {
	if (value === undefined) throw new Error("cannot serialize undefined root")
	return JSON.stringify(value, (_k, v: unknown) => {
		if (typeof v === "bigint") return `${BIG}${v.toString()}n`
		if (typeof v === "string" && (v.startsWith(BIG) || v.startsWith(ESC))) return `${ESC}${v}`
		return v
	})
}

function reviveString(v: string): string | bigint {
	// 36 is "$", the first character of both markers.
	if (v.charCodeAt(0) !== 36) return v
	if (v.startsWith(ESC)) return v.slice(ESC.length)
	if (v.startsWith(BIG)) {
		if (!v.endsWith("n")) throw new Error("invalid $bigint envelope")
		const digits = v.slice(BIG.length, -1)
		if (!/^-?\d+$/.test(digits)) throw new Error("invalid $bigint envelope")
		return BigInt(digits)
	}
	return v
}

// Revives in place. JSON.parse only creates plain objects, dense arrays and own enumerable data properties,
// so this touches exactly what a reviver would. defineProperty keeps an own "__proto__" key an own property,
// as the reviver's CreateDataProperty does, and redefining an existing key keeps its position.
function reviveTree(node: object): void {
	if (Array.isArray(node)) {
		const arr = node as unknown[]
		for (let i = 0; i < arr.length; i++) {
			const v = arr[i]
			if (typeof v === "string") {
				const revived = reviveString(v)
				if (revived !== v) arr[i] = revived
			} else if (typeof v === "object" && v !== null) {
				reviveTree(v)
			}
		}
		return
	}
	const obj = node as Record<string, unknown>
	for (const key of Object.keys(obj)) {
		const v = obj[key]
		if (typeof v === "string") {
			const revived = reviveString(v)
			if (revived !== v) Object.defineProperty(obj, key, { value: revived, writable: true, enumerable: true, configurable: true })
		} else if (typeof v === "object" && v !== null) {
			reviveTree(v)
		}
	}
}

// A plain parse plus a walk instead of a reviver: the reviver calls back into JS for every value and runs
// several times slower on large payloads.
export function parseEnvelope(raw: string): unknown {
	const parsed: unknown = JSON.parse(raw)
	if (typeof parsed === "string") return reviveString(parsed)
	if (typeof parsed !== "object" || parsed === null) return parsed
	// A marker can only appear as "$" or its JSON escape.
	if (!raw.includes("$") && !raw.includes("\\u0024")) return parsed
	reviveTree(parsed)
	return parsed
}
