// The DICOM worker's codecs ship no types: the cornerstone codecs are Emscripten modules with Embind classes (their
// decoder methods read from the wasm builds' registered names), and jpeg-lossless-decoder-js 2.1.2 names a
// release/lossless.d.ts its package does not contain. Each declares exactly what lib/dicom/codecs.ts uses.

interface DicomCodecFrameInfo {
	readonly width: number
	readonly height: number
	readonly bitsPerSample: number
	readonly componentCount: number
	readonly isSigned?: boolean
}

interface DicomEmbindDecoder {
	// A view of the decoder's input buffer in the wasm heap, `length` bytes.
	getEncodedBuffer(length: number): Uint8Array
	// A view of the decoded samples in the wasm heap: read before the next call.
	getDecodedBuffer(): Uint8Array
	getFrameInfo(): DicomCodecFrameInfo
	decode(): void
	delete(): void
}

// The module's heap: replaced by a larger view whenever the heap grows (it never shrinks).
interface DicomEmscriptenModule {
	readonly HEAPU8: Uint8Array
}

interface DicomEmscriptenOptions {
	locateFile: (path: string) => string
	print: (text: string) => void
	printErr: (text: string) => void
}

declare module "@cornerstonejs/codec-charls/decodewasmjs" {
	interface JpegLSDecoder extends DicomEmbindDecoder {
		// 0: planes one after another; 1 and 2: pixel-interleaved.
		getInterleaveMode(): number
	}

	const factory: (options: DicomEmscriptenOptions) => Promise<DicomEmscriptenModule & { JpegLSDecoder: new () => JpegLSDecoder }>

	export default factory
}

declare module "@cornerstonejs/codec-openjpeg/decodewasmjs" {
	interface J2KDecoder extends DicomEmbindDecoder {
		decodeSubResolution(decodeLevel: number, decodeLayer: number): void
	}

	const factory: (options: DicomEmscriptenOptions) => Promise<DicomEmscriptenModule & { J2KDecoder: new () => J2KDecoder }>

	export default factory
}

declare module "@cornerstonejs/codec-openjph/wasmjs" {
	interface HTJ2KDecoder extends DicomEmbindDecoder {
		// HTJ2KDecoder::decodeSubResolution(size_t decompositionLevel) at 2.4.11: one argument, unlike OpenJPEG's.
		decodeSubResolution(decompositionLevel: number): void
	}

	const factory: (options: DicomEmscriptenOptions) => Promise<DicomEmscriptenModule & { HTJ2KDecoder: new () => HTJ2KDecoder }>

	export default factory
}

declare module "jpeg-lossless-decoder-js" {
	export class Decoder {
		decode(buffer: ArrayBuffer, offset: number, length: number, numBytes: number): Uint8Array | Uint16Array
	}
}
