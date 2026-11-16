import type { AnyFile } from "@filen/sdk-rs"
import type { ByteOrigin, OriginAccess } from "@/lib/sdk/byteOrigin"

// The byte layer's worker calls routed to a test's spies on the per-client calls they replace (a drive file to the
// session's, a linked file to the anonymous one), so a test asserting on those still sees every read.
interface PerClientCalls {
	downloadFileBytes?: (file: AnyFile, token: string) => Promise<Uint8Array>
	downloadLinkedFileBytesAnon?: (file: AnyFile, token: string) => Promise<Uint8Array>
	openRangePort?: (port: MessagePort, file: AnyFile, token: string) => Promise<void> | void
	openLinkedRangePortAnon?: (port: MessagePort, file: AnyFile, token: string) => Promise<void> | void
}

function fileOf(origin: ByteOrigin): { anon: boolean; file: AnyFile } {
	if (origin.kind === "file" || origin.kind === "linkedFile") {
		return { anon: origin.kind === "linkedFile", file: origin.file }
	}

	throw new Error(`no per-client call reads a ${origin.kind} origin`)
}

function missing(name: string): never {
	throw new Error(`the test's sdkApi mock has no ${name}`)
}

export function originShims(calls: PerClientCalls) {
	return {
		downloadOriginBytes: (origin: ByteOrigin, _access: OriginAccess, _cap: number, token: string): Promise<Uint8Array> => {
			const { anon, file } = fileOf(origin)
			const call = anon ? calls.downloadLinkedFileBytesAnon : calls.downloadFileBytes

			return call === undefined ? missing(anon ? "downloadLinkedFileBytesAnon" : "downloadFileBytes") : call(file, token)
		},
		openOriginRangePort: async (port: MessagePort, origin: ByteOrigin, _access: OriginAccess, token: string): Promise<void> => {
			const { anon, file } = fileOf(origin)
			const call = anon ? calls.openLinkedRangePortAnon : calls.openRangePort

			await (call === undefined ? missing(anon ? "openLinkedRangePortAnon" : "openRangePort") : call(port, file, token))
		}
	}
}
