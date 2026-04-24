/**
 * Spec-compliant DOMException polyfill for runtimes that don't ship one
 * (Hermes/React Native in particular). Implements the WebIDL definition
 * closely enough for consumers like AbortController and fetch.
 *
 * https://webidl.spec.whatwg.org/#idl-DOMException
 */
if (typeof global.DOMException === "undefined") {
	// Legacy error name → code, per the WebIDL error names table.
	const LEGACY_CODES: Readonly<Record<string, number>> = Object.freeze({
		IndexSizeError: 1,
		DOMStringSizeError: 2,
		HierarchyRequestError: 3,
		WrongDocumentError: 4,
		InvalidCharacterError: 5,
		NoDataAllowedError: 6,
		NoModificationAllowedError: 7,
		NotFoundError: 8,
		NotSupportedError: 9,
		InUseAttributeError: 10,
		InvalidStateError: 11,
		SyntaxError: 12,
		InvalidModificationError: 13,
		NamespaceError: 14,
		InvalidAccessError: 15,
		ValidationError: 16,
		TypeMismatchError: 17,
		SecurityError: 18,
		NetworkError: 19,
		AbortError: 20,
		URLMismatchError: 21,
		QuotaExceededError: 22,
		TimeoutError: 23,
		InvalidNodeTypeError: 24,
		DataCloneError: 25
	})

	// Legacy numeric constants, exposed on both the constructor and the prototype.
	const LEGACY_CONSTANTS: readonly (readonly [string, number])[] = [
		["INDEX_SIZE_ERR", 1],
		["DOMSTRING_SIZE_ERR", 2],
		["HIERARCHY_REQUEST_ERR", 3],
		["WRONG_DOCUMENT_ERR", 4],
		["INVALID_CHARACTER_ERR", 5],
		["NO_DATA_ALLOWED_ERR", 6],
		["NO_MODIFICATION_ALLOWED_ERR", 7],
		["NOT_FOUND_ERR", 8],
		["NOT_SUPPORTED_ERR", 9],
		["INUSE_ATTRIBUTE_ERR", 10],
		["INVALID_STATE_ERR", 11],
		["SYNTAX_ERR", 12],
		["INVALID_MODIFICATION_ERR", 13],
		["NAMESPACE_ERR", 14],
		["INVALID_ACCESS_ERR", 15],
		["VALIDATION_ERR", 16],
		["TYPE_MISMATCH_ERR", 17],
		["SECURITY_ERR", 18],
		["NETWORK_ERR", 19],
		["ABORT_ERR", 20],
		["URL_MISMATCH_ERR", 21],
		["QUOTA_EXCEEDED_ERR", 22],
		["TIMEOUT_ERR", 23],
		["INVALID_NODE_TYPE_ERR", 24],
		["DATA_CLONE_ERR", 25]
	]

	class PolyfillDOMException extends Error {
		// Per-spec default for `name` is "Error" (not the class name).
		public constructor(message: string = "", name: string = "Error") {
			const coercedMessage = String(message)
			super(coercedMessage)

			// Match native Error: non-enumerable, writable, configurable.
			Object.defineProperty(this, "name", {
				value: String(name),
				writable: true,
				enumerable: false,
				configurable: true
			})
			Object.defineProperty(this, "message", {
				value: coercedMessage,
				writable: true,
				enumerable: false,
				configurable: true
			})

			// Restore the prototype chain — needed when `extends Error` is
			// transpiled down and for older runtimes that lose it.
			Object.setPrototypeOf(this, PolyfillDOMException.prototype)
		}

		// `code` is a live getter, not a frozen value: reassigning `name`
		// must change the returned code.
		public get code(): number {
			return LEGACY_CODES[this.name] ?? 0
		}

		public get [Symbol.toStringTag](): string {
			return "DOMException"
		}
	}

	for (const [constantName, value] of LEGACY_CONSTANTS) {
		const descriptor: PropertyDescriptor = {
			value,
			writable: false,
			enumerable: true,
			configurable: false
		}

		Object.defineProperty(PolyfillDOMException, constantName, descriptor)
		Object.defineProperty(PolyfillDOMException.prototype, constantName, descriptor)
	}

	// @ts-expect-error installing polyfill on the global
	global.DOMException = PolyfillDOMException
}
