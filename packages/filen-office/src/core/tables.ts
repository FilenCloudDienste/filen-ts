// Lookup tables written as object literals and indexed by names read from a file: own entries only, so a name such
// as "constructor" or "__proto__" finds nothing rather than an Object.prototype member.
export function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
	return Object.hasOwn(table, key) ? table[key] : undefined
}
