// Errors crossing the db BroadcastChannel keep name, message and stack; everything else is dropped.
export interface SerializedError {
	name: string
	message: string
	stack?: string | undefined
}

export function serializeError(error: Error): SerializedError {
	return {
		name: error.name,
		message: error.message,
		stack: error.stack
	}
}

export function deserializeError(serializedError: SerializedError): Error {
	const error = new Error(serializedError.message)
	// exactOptionalPropertyTypes rejects writing `string | undefined` through lib's `Error.stack?: string`
	const writableStack: { stack?: string | undefined } = error

	error.name = serializedError.name
	writableStack.stack = serializedError.stack

	return error
}
