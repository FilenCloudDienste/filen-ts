import { type } from "arktype"

// What a call does to the user's data. "navigate" only changes what the app shows; "additive" and
// "modifying" change stored data and are executed only after the user confirms.
export type AssistantToolEffect = "read" | "navigate" | "additive" | "modifying"

export type AssistantToolGroup = "files" | "insights" | "shared" | "organize" | "trash" | "notes" | "chats" | "audio" | "navigation"

// "answer" routes a request to a plain text reply without any tools.
export type AssistantRoute = AssistantToolGroup | "answer"

// Who can author the text a tool returns. Item, chat and playlist names are attacker-controlled
// whenever another user shares the item or writes in the chat; "content" (note bodies, file text,
// chat messages) carries long free text and is the main prompt-injection carrier.
export type AssistantUntrustedOutput = "none" | "names" | "content"

export type AssistantGroundedArgs = {
	// Arguments holding handles (string or string[]) that must trace back to the user's request.
	readonly handles?: readonly string[]
	// Free-text arguments that must appear in the user's own message.
	readonly text?: readonly string[]
	// Free-text arguments that may say anything, but carry no link or address the user did not type.
	readonly links?: readonly string[]
}

// One argument of a tool. Its description reaches the model only through the JSON Schema: on the arktype type,
// arktype would print it in place of the expected type in the validation errors the model corrects a call from.
export type AssistantToolArg = {
	readonly type: type.Any
	readonly description?: string
	readonly optional?: boolean
	// A string enum's values in the order the model reads them; arktype sorts a union's values.
	readonly values?: readonly string[]
}

export function oneOf<const Values extends readonly [string, ...string[]]>(values: Values) {
	return {
		type: type.enumerated(...values),
		values
	}
}

// In the order the model reads the arguments and the grammar emits them; arktype sorts an object's keys.
export type AssistantToolInput = Readonly<Record<string, AssistantToolArg>>

export type AssistantTool<Name extends string = string, Input extends AssistantToolInput = AssistantToolInput> = {
	readonly name: Name
	readonly title: string
	readonly description: string
	readonly group: AssistantToolGroup
	readonly effect: AssistantToolEffect
	readonly input: Input
	readonly untrustedOutput: AssistantUntrustedOutput
	// Moves the user's data, or words about it, to other people.
	readonly exfiltrates: boolean
	readonly grounded: AssistantGroundedArgs
}

export function defineTool<const Name extends string, const Input extends AssistantToolInput>(
	tool: AssistantTool<Name, Input>
): AssistantTool<Name, Input> {
	return tool
}

// Consequential calls change stored data or reach other people. The dispatcher runs them only
// after the guard (guard.ts) has grounded them and the user has confirmed a card that names
// exactly what happens.
export function isConsequentialTool(tool: AssistantTool): boolean {
	return tool.effect === "additive" || tool.effect === "modifying" || tool.exfiltrates
}

export type PortableScalarSchema =
	| {
			type: "string" | "integer" | "boolean"
			description?: string
	  }
	| {
			type: "string"
			enum: string[]
			description?: string
	  }

export type PortableArraySchema = {
	type: "array"
	items: PortableScalarSchema
	minItems?: number
	description?: string
}

// The subset every target grammar engine handles identically: llama.cpp's json-schema-to-grammar
// (wllama, llama.rn) and node-llama-cpp's GBNF builder diverge on $ref, combinators, number
// bounds and formats.
export type PortableObjectSchema = {
	type: "object"
	properties: Record<string, PortableScalarSchema | PortableArraySchema>
	required?: string[]
	additionalProperties: false
	description?: string
}

const SCALAR_KEYS = new Set(["type", "description", "enum"])
const ARRAY_KEYS = new Set(["type", "description", "items", "minItems"])
const OBJECT_KEYS = new Set(["type", "description", "properties", "required", "additionalProperties"])
const SCALAR_TYPES = new Set(["string", "integer", "boolean"])

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function scalarViolations({ schema, path }: { schema: unknown; path: string }): string[] {
	if (!isRecord(schema)) {
		return [`${path}: not an object`]
	}

	const violations = Object.keys(schema)
		.filter(key => !SCALAR_KEYS.has(key))
		.map(key => `${path}: unsupported keyword "${key}"`)

	if (typeof schema["type"] !== "string" || !SCALAR_TYPES.has(schema["type"])) {
		violations.push(`${path}: type must be string, integer or boolean`)
	}

	if ("enum" in schema) {
		const values = schema["enum"]

		if (
			schema["type"] !== "string" ||
			!Array.isArray(values) ||
			values.length === 0 ||
			values.some(value => typeof value !== "string")
		) {
			violations.push(`${path}: enum must be a non-empty list of strings on a string type`)
		}
	}

	return violations
}

function propertyViolations({ schema, path }: { schema: unknown; path: string }): string[] {
	if (isRecord(schema) && schema["type"] === "array") {
		const violations = Object.keys(schema)
			.filter(key => !ARRAY_KEYS.has(key))
			.map(key => `${path}: unsupported keyword "${key}"`)

		if ("minItems" in schema && (!Number.isInteger(schema["minItems"]) || Number(schema["minItems"]) < 0)) {
			violations.push(`${path}: minItems must be a non-negative integer`)
		}

		return [
			...violations,
			...scalarViolations({
				schema: schema["items"],
				path: `${path}.items`
			})
		]
	}

	return scalarViolations({
		schema,
		path
	})
}

export function portableSchemaViolations(schema: unknown): string[] {
	if (!isRecord(schema) || schema["type"] !== "object") {
		return ["root: must be an object schema"]
	}

	const violations = Object.keys(schema)
		.filter(key => !OBJECT_KEYS.has(key))
		.map(key => `root: unsupported keyword "${key}"`)

	if (schema["additionalProperties"] !== false) {
		violations.push("root: additionalProperties must be false")
	}

	const properties = schema["properties"]

	if (!isRecord(properties)) {
		return [...violations, "root: properties missing"]
	}

	for (const [name, property] of Object.entries(properties)) {
		violations.push(
			...propertyViolations({
				schema: property,
				path: name
			})
		)
	}

	const required = schema["required"] ?? []

	if (!Array.isArray(required) || required.some(name => typeof name !== "string" || !(name in properties))) {
		violations.push("root: required must list declared properties")
	}

	return violations
}

// arktype leaves the type off a string enum.
function portableJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
	const { items, enum: values } = schema

	if (isRecord(items)) {
		return {
			...schema,
			items: portableJsonSchema(items)
		}
	}

	if (schema["type"] === undefined && Array.isArray(values) && values.every(value => typeof value === "string")) {
		return {
			type: "string",
			...schema
		}
	}

	return schema
}

// Built once per input; callers read the result and never change it.
const jsonSchemas = new WeakMap<AssistantToolInput, PortableObjectSchema>()

export function toolInputJsonSchema(tool: AssistantTool): PortableObjectSchema {
	const cached = jsonSchemas.get(tool.input)

	if (cached !== undefined) {
		return cached
	}

	const args = Object.entries(tool.input)
	const required = args.filter(([, arg]) => arg.optional !== true).map(([name]) => name)
	const schema = {
		type: "object",
		properties: Object.fromEntries(
			args.map(([name, arg]) => [
				name,
				{
					...portableJsonSchema(arg.type.toJsonSchema({ dialect: null }) as Record<string, unknown>),
					...(arg.values === undefined ? {} : { enum: [...arg.values] }),
					...(arg.description === undefined ? {} : { description: arg.description })
				}
			])
		),
		...(required.length > 0 ? { required } : {}),
		additionalProperties: false
	}
	const violations = portableSchemaViolations(schema)

	if (violations.length > 0) {
		throw new Error(`Tool "${tool.name}" input is not portable: ${violations.join("; ")}`)
	}

	jsonSchemas.set(tool.input, schema as PortableObjectSchema)

	return schema as PortableObjectSchema
}

export type AssistantToolInputParse =
	| {
			readonly ok: true
			readonly args: Record<string, unknown>
	  }
	| {
			readonly ok: false
			// What the model reads to correct the call.
			readonly error: string
	  }

const validators = new WeakMap<AssistantToolInput, (data: unknown) => unknown>()

function validatorOf(input: AssistantToolInput): (data: unknown) => unknown {
	let validator = validators.get(input)

	if (validator === undefined) {
		validator = type.raw({
			"+": "reject",
			...Object.fromEntries(Object.entries(input).map(([name, arg]) => [arg.optional === true ? `${name}?` : name, arg.type]))
		})

		validators.set(input, validator)
	}

	return validator
}

// Rejects undeclared arguments. arktype counts an array as an object, so anything but a plain object is refused first.
export function parseToolInput(tool: AssistantTool, input: unknown): AssistantToolInputParse {
	if (!isRecord(input)) {
		return {
			ok: false,
			error: "input must be an object"
		}
	}

	const result = validatorOf(tool.input)(input)

	if (result instanceof type.errors) {
		return {
			ok: false,
			error: result.map(error => error.message).join("; ")
		}
	}

	return {
		ok: true,
		args: input
	}
}
