import mimeTypes from "mime-types"

export function normalizeModificationTimestampForComparison(timestamp: number): number {
	return Math.floor(timestamp / 1000)
}

export function resolveMimeType({ mime, name }: { mime: string | null | undefined; name: string }): string {
	return mime || mimeTypes.lookup(name) || "application/octet-stream"
}

export type BigIntToNumber<T> = T extends bigint
	? number
	: T extends Date
		? Date
		: T extends (infer U)[]
			? BigIntToNumber<U>[]
			: T extends object
				? {
						[K in keyof T]: BigIntToNumber<T[K]>
					}
				: T

/**
 * Generic deep converter that walks a value and replaces every `bigint` with its
 * `Number` equivalent, preserving `Date` instances and array/object structure.
 * Used to make SDK responses JSON-serializable.
 */
export function convertBigInts<T>(value: T): BigIntToNumber<T> {
	if (typeof value === "bigint") {
		return Number(value) as BigIntToNumber<T>
	}

	if (value === null || value === undefined) {
		return value as BigIntToNumber<T>
	}

	if (Array.isArray(value)) {
		return value.map(convertBigInts) as BigIntToNumber<T>
	}

	// Preserve Date (and other built-ins you don't want to walk into)
	if (value instanceof Date) {
		return value as BigIntToNumber<T>
	}

	if (typeof value === "object") {
		const out: Record<string, unknown> = {}

		for (const key of Object.keys(value as object)) {
			out[key] = convertBigInts((value as Record<string, unknown>)[key])
		}

		return out as BigIntToNumber<T>
	}

	return value as BigIntToNumber<T>
}
