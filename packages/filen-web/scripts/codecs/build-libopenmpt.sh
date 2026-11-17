#!/usr/bin/env bash
#
# Builds libopenmpt, which renders tracker modules (MOD, XM, IT, S3M and every other format it reads), from a pinned
# release as one WebAssembly module with its JavaScript glue in a single ES module, and writes it to
# src/vendor/libopenmpt/ with the list of extensions it reads, a manifest and the licenses of what is linked in.
# All of it is committed; re-run this only to change the release or the flags.
#
# libopenmpt is BSD-3-Clause. Its bundled minimp3 (CC0-1.0), stb_vorbis (public domain or MIT) and miniz (MIT) decode
# the MP3, Vorbis and zlib-packed samples some formats hold, so no other library is linked.
#
#   brew install emscripten          (the version emscripten.sh pins)
#   scripts/codecs/build-libopenmpt.sh
#
# Same tarball, flags and emcc build give the same output bytes; the manifest records all of them with the output's
# SHA-256. Set LIBOPENMPT_WORKDIR to keep the build tree between runs.

set -euo pipefail

LIBOPENMPT_VERSION="0.8.10"
LIBOPENMPT_TARBALL="libopenmpt-${LIBOPENMPT_VERSION}+release.makefile.tar.gz"
LIBOPENMPT_URL="https://lib.openmpt.org/files/libopenmpt/src/${LIBOPENMPT_TARBALL}"
# Of the tarball as downloaded from lib.openmpt.org (the project publishes no digest of its own).
LIBOPENMPT_SHA256="95073a10d33d0ed4352f41b68edccb9636002d2626f9fd2e00b191fcaabdd876"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE="$(cd "${HERE}/../.." && pwd)"
OUT_DIR="${PACKAGE}/src/vendor/libopenmpt"
OUT_NAME="libopenmpt.js"

# libopenmpt's own makefile, for its static library alone and with nothing but its bundled decoders.
MAKE_FLAGS=(
	CONFIG=emscripten
	EMSCRIPTEN_TARGET=wasm
	SHARED_LIB=0
	STATIC_LIB=1
	EXAMPLES=0
	OPENMPT123=0
	TEST=0
	NO_ZLIB=1
	NO_MPG123=1
	NO_OGG=1
	NO_VORBIS=1
	NO_VORBISFILE=1
	NO_PORTAUDIO=1
	NO_PORTAUDIOCPP=1
	NO_PULSEAUDIO=1
	NO_SDL2=1
	NO_FLAC=1
	NO_SNDFILE=1
)
EXPORTS="_malloc,_free,_openmpt_module_create_from_memory2,_openmpt_module_destroy,_openmpt_module_set_repeat_count,_openmpt_module_get_duration_seconds,_openmpt_module_set_position_seconds,_openmpt_module_read_interleaved_float_stereo,_openmpt_get_supported_extensions,_openmpt_free_string"
# -fwasm-exceptions in place of the makefile's JavaScript exceptions: an allocation libopenmpt cannot make throws
# bad_alloc, which its C API catches and reports, rather than aborting the instance. The heap is capped so a hostile
# module cannot grow it past what a preview may hold. DYNAMIC_EXECUTION=0: the app's CSP allows no eval.
LINK_FLAGS=(
	-Oz
	-flto
	-fwasm-exceptions
	-sMODULARIZE=1
	-sEXPORT_ES6=1
	-sEXPORT_NAME=createLibopenmpt
	-sENVIRONMENT=worker
	-sSINGLE_FILE=1
	-sSINGLE_FILE_BINARY_ENCODE=0
	-sDYNAMIC_EXECUTION=0
	-sALLOW_MEMORY_GROWTH=1
	-sMAXIMUM_MEMORY=256MB
	-sFILESYSTEM=0
	-sINCOMING_MODULE_JS_API=[]
	-sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPF32,UTF8ToString
	"-sEXPORTED_FUNCTIONS=${EXPORTS}"
)
# Build paths would otherwise reach the binary through __FILE__ in libopenmpt's assertions.
SOURCE_PREFIX_MAP="-ffile-prefix-map=<libopenmpt source>=libopenmpt"

# shellcheck source=emscripten.sh
source "${HERE}/emscripten.sh"

need make
need node

if [[ -n "${LIBOPENMPT_WORKDIR:-}" ]]; then
	work="${LIBOPENMPT_WORKDIR}"
	mkdir -p "${work}"
else
	work="$(mktemp -d)"
	trap 'rm -rf "${work}"' EXIT
fi

work="$(cd "${work}" && pwd)"

if [[ "${work}" =~ [[:space:]] ]]; then
	echo "the work directory must not contain whitespace" >&2
	exit 1
fi

tarball="${work}/${LIBOPENMPT_TARBALL}"
src="${work}/libopenmpt-${LIBOPENMPT_VERSION}+release"

if [[ ! -f "${tarball}" ]]; then
	curl -fL --proto '=https' -o "${tarball}.part" "${LIBOPENMPT_URL}"
	mv "${tarball}.part" "${tarball}"
fi

echo "${LIBOPENMPT_SHA256}  ${tarball}" | shasum -a 256 -c -

rm -rf "${src}"
tar -xzf "${tarball}" -C "${work}"

# The makefile's emscripten config asks for JavaScript exceptions; this build uses WebAssembly's, and maps the
# source paths away.
config="${src}/build/make/config-emscripten.mk"

sed -i.orig 's/-s DISABLE_EXCEPTION_CATCHING=0/-fwasm-exceptions/' "${config}"
grep -q -- "-fwasm-exceptions" "${config}" || {
	echo "the emscripten config no longer reads as this script expects" >&2
	exit 1
}
printf 'CXXFLAGS += -ffile-prefix-map=%s=libopenmpt\nCFLAGS += -ffile-prefix-map=%s=libopenmpt\n' "${src}" "${src}" >> "${config}"

make -C "${src}" -j "$(getconf _NPROCESSORS_ONLN)" "${MAKE_FLAGS[@]}"

build="${work}/out"
mkdir -p "${build}"

em++ "${src}/bin/libopenmpt.a" "-ffile-prefix-map=${src}=libopenmpt" "${LINK_FLAGS[@]}" -o "${build}/${OUT_NAME}"

mkdir -p "${OUT_DIR}/licenses"
cp "${build}/${OUT_NAME}" "${OUT_DIR}/${OUT_NAME}"
cp "${src}/LICENSE" "${OUT_DIR}/licenses/libopenmpt-LICENSE"
cp "${src}/include/minimp3/LICENSE" "${OUT_DIR}/licenses/minimp3-LICENSE"
cp "${src}/include/miniz/LICENSE" "${OUT_DIR}/licenses/miniz-LICENSE"
# stb_vorbis carries its licence at the end of its single source file.
sed -n '/^This software is available under 2 licenses/,$p' "${src}/include/stb_vorbis/stb_vorbis.c" | sed '$d' > "${OUT_DIR}/licenses/stb_vorbis-LICENSE"
cp "${emscripten_license}" "${OUT_DIR}/licenses/emscripten-LICENSE"
cp "${musl_license}" "${OUT_DIR}/licenses/musl-COPYRIGHT"

# The extensions the built module reads, asked of it: the tracker rows derive from this list.
node --input-type=module - "${OUT_DIR}/${OUT_NAME}" > "${OUT_DIR}/extensions.json" << 'NODE'
globalThis.self = globalThis
const { default: create } = await import(process.argv[2])
const module = await create()
const pointer = module._openmpt_get_supported_extensions()
const extensions = module.UTF8ToString(pointer).split(";").filter(extension => extension.length > 0)

module._openmpt_free_string(pointer)
process.stdout.write(`${JSON.stringify(extensions, null, "\t")}\n`)
NODE

cat > "${OUT_DIR}/manifest.json" << EOF
{
	"description": "libopenmpt ${LIBOPENMPT_VERSION} with its bundled minimp3, stb_vorbis and miniz, built to WebAssembly by scripts/codecs/build-libopenmpt.sh; BSD-3-Clause.",
	"libopenmpt": {
		"version": "${LIBOPENMPT_VERSION}",
		"tarball": "${LIBOPENMPT_URL}",
		"sha256": "${LIBOPENMPT_SHA256}",
		"make": $(json_array "${MAKE_FLAGS[@]}")
	},
	"emcc": $(json_string "${emcc_version}"),
	"emccBuild": {
		"clang": $(json_string "${emcc_clang}"),
		"homebrew": ${emcc_homebrew}
	},
	"emscripten": {
		"musl": $(json_string "${musl_version}")
	},
	"link": $(json_array "${SOURCE_PREFIX_MAP}" "${LINK_FLAGS[@]}"),
	"licenses": {
		"libopenmpt-LICENSE": "$(hash_of "${OUT_DIR}/licenses/libopenmpt-LICENSE")",
		"minimp3-LICENSE": "$(hash_of "${OUT_DIR}/licenses/minimp3-LICENSE")",
		"miniz-LICENSE": "$(hash_of "${OUT_DIR}/licenses/miniz-LICENSE")",
		"stb_vorbis-LICENSE": "$(hash_of "${OUT_DIR}/licenses/stb_vorbis-LICENSE")",
		"emscripten-LICENSE": "$(hash_of "${OUT_DIR}/licenses/emscripten-LICENSE")",
		"musl-COPYRIGHT": "$(hash_of "${OUT_DIR}/licenses/musl-COPYRIGHT")"
	},
	"sources": {
		"build-libopenmpt.sh": "$(hash_of "${HERE}/build-libopenmpt.sh")",
		"emscripten.sh": "$(hash_of "${HERE}/emscripten.sh")"
	},
	"output": {
		"${OUT_NAME}": {
			"bytes": $(wc -c < "${OUT_DIR}/${OUT_NAME}" | tr -d ' '),
			"sha256": "$(hash_of "${OUT_DIR}/${OUT_NAME}")"
		},
		"extensions.json": "$(hash_of "${OUT_DIR}/extensions.json")"
	}
}
EOF

echo "wrote ${OUT_DIR}/${OUT_NAME}, extensions.json, licenses/ and manifest.json"
