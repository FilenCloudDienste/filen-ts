import { vi, type Mock } from "vitest"
import type { FilenSdkError } from "@filen/sdk-rs"
import { labelFirst, type ErrorDTO } from "@/lib/sdk/errors"

export interface SdkErrorFields {
	innerMessage?: string
	serverMessage?: string
	serverCode?: string
}

// The ErrorDTO the worker lifts an SDK error to.
export function sdkErrorDTO(kind: string, message: string, fields: SdkErrorFields = {}): ErrorDTO {
	const dto: ErrorDTO = { species: "sdk", kind, message, ...fields, label: "" }

	dto.label = labelFirst(dto)

	return dto
}

// A live FilenSdkError as the wasm glue shapes it: `kind`/`message` getters and accessor methods on the
// prototype, so a structured clone of it comes out hollow. Not named FilenSdkError and not an Error, as
// the minified glue class isn't either.
class LiveSdkError {
	readonly #kind: string
	readonly #message: string
	readonly #fields: SdkErrorFields
	readonly #free = vi.fn<() => void>()

	constructor(kind: string, message: string, fields: SdkErrorFields) {
		this.#kind = kind
		this.#message = message
		this.#fields = fields
	}

	get kind(): string {
		return this.#kind
	}

	get message(): string {
		return this.#message
	}

	inner_message(): string | undefined {
		return this.#fields.innerMessage
	}

	server_message(): string | undefined {
		return this.#fields.serverMessage
	}

	server_code(): string | undefined {
		return this.#fields.serverCode
	}

	free(): void {
		this.#free()
	}

	get freed(): Mock<() => void> {
		return this.#free
	}
}

export type LiveSdkErrorMock = FilenSdkError & { readonly freed: Mock<() => void> }

export function liveSdkError(kind: string, message: string, fields: SdkErrorFields = {}): LiveSdkErrorMock {
	return new LiveSdkError(kind, message, fields) as unknown as LiveSdkErrorMock
}
