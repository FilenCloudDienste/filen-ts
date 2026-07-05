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
export function parseEnvelope(raw: string): unknown {
	return JSON.parse(raw, (_k, v: unknown) => {
		if (typeof v !== "string") return v
		if (v.startsWith(ESC)) return v.slice(ESC.length)
		if (v.startsWith(BIG)) {
			if (!v.endsWith("n")) throw new Error("invalid $bigint envelope")
			const digits = v.slice(BIG.length, -1)
			if (!/^-?\d+$/.test(digits)) throw new Error("invalid $bigint envelope")
			return BigInt(digits)
		}
		return v
	})
}
