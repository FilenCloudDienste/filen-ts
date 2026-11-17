// The C side of the libopenmpt module, built by build-libopenmpt.sh: what the module worker calls, with libopenmpt's
// log silenced (it would otherwise go to the console) and every allocation's failure reported rather than written
// through a null pointer.

#include <emscripten.h>
#include <emscripten/heap.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "libopenmpt/libopenmpt.h"

// Bytes of a file's head the probe wants.
EMSCRIPTEN_KEEPALIVE
int filen_probe_size(void) {
	return (int)openmpt_probe_file_header_get_recommended_size();
}

// Whether the `size` bytes at `head`, of a file of `file_size` bytes, start a format libopenmpt reads: 1 yes, 0 no,
// -1 when it cannot tell from these bytes.
EMSCRIPTEN_KEEPALIVE
int filen_probe(const void *head, int size, double file_size) {
	int result = openmpt_probe_file_header(OPENMPT_PROBE_FILE_HEADER_FLAGS_DEFAULT, head, (size_t)size, (uint64_t)file_size,
		openmpt_log_func_silent, NULL, NULL, NULL, NULL, NULL);

	return result == OPENMPT_PROBE_FILE_HEADER_RESULT_SUCCESS ? 1 : result == OPENMPT_PROBE_FILE_HEADER_RESULT_WANTMOREDATA ? -1 : 0;
}

// A module over the `size` bytes at `data`, played once; with `skip_samples` its samples are not decoded (enough for
// its duration). NULL when libopenmpt does not read it, with its error code in `*error`.
EMSCRIPTEN_KEEPALIVE
openmpt_module *filen_open(const void *data, int size, int skip_samples, int *error) {
	const openmpt_module_initial_ctl ctls[] = {
		{"load.skip_samples", skip_samples ? "1" : "0"},
		{NULL, NULL}
	};
	const char *message = NULL;
	openmpt_module *module =
		openmpt_module_create_from_memory2(data, (size_t)size, openmpt_log_func_silent, NULL, NULL, NULL, error, &message, ctls);

	openmpt_free_string(message);

	if (module != NULL) {
		openmpt_module_set_repeat_count(module, 0);
	}

	return module;
}

EMSCRIPTEN_KEEPALIVE
double filen_duration(openmpt_module *module) {
	return openmpt_module_get_duration_seconds(module);
}

EMSCRIPTEN_KEEPALIVE
double filen_seek(openmpt_module *module, double seconds) {
	return openmpt_module_set_position_seconds(module, seconds);
}

EMSCRIPTEN_KEEPALIVE
int filen_render(openmpt_module *module, int sample_rate, int frames, float *interleaved) {
	return (int)openmpt_module_read_interleaved_float_stereo(module, sample_rate, (size_t)frames, interleaved);
}

EMSCRIPTEN_KEEPALIVE
void filen_close(openmpt_module *module) {
	openmpt_module_destroy(module);
}

// The wasm heap's size in bytes: it never shrinks, so a worker that grew it far is replaced once idle.
EMSCRIPTEN_KEEPALIVE
double filen_heap_bytes(void) {
	return (double)emscripten_get_heap_size();
}

EMSCRIPTEN_KEEPALIVE
char *filen_extensions(void) {
	const char *list = openmpt_get_supported_extensions();
	char *copy = strdup(list == NULL ? "" : list);

	openmpt_free_string(list);

	return copy;
}
