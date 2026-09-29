// Package part paths and XML text, shared by the save gate and the save proof.

const ENTITY = /&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi

export function decodeXml(text: string): string {
	return text.includes("&")
		? text.replace(ENTITY, (_match, entity: string) => {
				switch (entity.toLowerCase()) {
					case "amp":
						return "&"
					case "lt":
						return "<"
					case "gt":
						return ">"
					case "quot":
						return '"'
					case "apos":
						return "'"
					default:
						return String.fromCodePoint(
							entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10)
						)
				}
			})
		: text
}

// A relationship target as a part path, as hucre resolves it, lower-cased: part names compare
// case-insensitively.
export function resolvePart(base: string, target: string): string {
	if (target.startsWith("/")) return target.slice(1).toLowerCase()

	const parts = base.split("/").filter(Boolean)

	for (const part of target.split("/").filter(Boolean)) {
		if (part === "..") parts.pop()
		else if (part !== ".") parts.push(part)
	}

	return parts.join("/").toLowerCase()
}

export function relsPath(part: string): string {
	const slash = part.lastIndexOf("/")

	return `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`
}

export function dirname(part: string): string {
	return part.slice(0, part.lastIndexOf("/"))
}

// The last segment of a relationship type URI ("worksheet", "officeDocument").
export function relationshipTypeName(type: string): string {
	return type.slice(type.lastIndexOf("/") + 1)
}
