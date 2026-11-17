// The parts of the libopenmpt module (built by scripts/codecs/build-libopenmpt.sh) the module worker calls; pointers
// are byte offsets into HEAPU8.
export interface LibopenmptModule {
	HEAPU8: Uint8Array
	HEAPF32: Float32Array
	UTF8ToString(pointer: number): string
	_malloc(size: number): number
	_free(pointer: number): void
	_openmpt_module_create_from_memory2(
		data: number,
		size: number,
		logFunc: number,
		logUser: number,
		errorFunc: number,
		errorUser: number,
		error: number,
		errorMessage: number,
		ctls: number
	): number
	_openmpt_module_destroy(module: number): void
	_openmpt_module_set_repeat_count(module: number, count: number): number
	_openmpt_module_get_duration_seconds(module: number): number
	_openmpt_module_set_position_seconds(module: number, seconds: number): number
	_openmpt_module_read_interleaved_float_stereo(module: number, sampleRate: number, count: number, buffer: number): number
	_openmpt_get_supported_extensions(): number
	_openmpt_free_string(pointer: number): void
}

export default function createLibopenmpt(): Promise<LibopenmptModule>
