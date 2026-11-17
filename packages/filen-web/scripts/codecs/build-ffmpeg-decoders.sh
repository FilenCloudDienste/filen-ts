#!/usr/bin/env bash
#
# Builds the AC-3, E-AC-3, DTS, TrueHD/MLP, ALAC and FLAC audio decoders the remux worker uses (no browser
# decodes the first four, only Safari ALAC, and WebKit's own FLAC decoder fails on Matroska's) from a pinned
# FFmpeg release, as one WebAssembly module with its JavaScript glue and worker loop in a single file, and
# writes it with a manifest and the licenses of what Emscripten links in to src/vendor/ffmpeg-decoders/. All
# of it is committed; re-run this only to change the FFmpeg release, the flags or the sources beside this
# script.
#
# The FFmpeg part is LGPL-2.1-or-later: configure enables no GPL or nonfree component, only these
# decoders and what they depend on. This script and bridge.c and decoder-worker.js beside it, whose hashes
# the manifest records, are the complete corresponding source of the module.
#
#   brew install emscripten          (the version pinned below)
#   scripts/codecs/build-ffmpeg-decoders.sh
#
# Same FFmpeg tarball, flags and emcc build give the same output bytes; the manifest records all of them
# with the output's SHA-256. Set FFMPEG_DECODERS_WORKDIR to keep the build tree between runs.

set -euo pipefail

FFMPEG_VERSION="9.0.2"
FFMPEG_TAG="n${FFMPEG_VERSION}"
FFMPEG_TARBALL="ffmpeg-${FFMPEG_VERSION}.tar.xz"
FFMPEG_URL="https://ffmpeg.org/releases/${FFMPEG_TARBALL}"
# Of the tarball as signed by the FFmpeg release key FCF986EA15E6E293A5644F10B4322F04D67658D8.
FFMPEG_SHA256="8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e"
# Exactly as `emcc --version` prints it: a release and a -git build of it are different compilers.
EMCC_VERSION="7.0.0-git"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE="$(cd "${HERE}/../.." && pwd)"
OUT_DIR="${PACKAGE}/src/vendor/ffmpeg-decoders"
OUT_NAME="decoders.worker.js"

CONFIGURE_FLAGS=(
	--target-os=none
	--arch=x86_32
	--enable-cross-compile
	--disable-asm
	--disable-inline-asm
	--disable-x86asm
	--disable-programs
	--disable-doc
	--disable-debug
	--disable-network
	--disable-autodetect
	--disable-pthreads
	--disable-runtime-cpudetect
	--disable-all
	--disable-everything
	# Without it configure appends -O3 after -Oz: a third larger, for decoding that runs at 200x real time
	# either way.
	--enable-small
	--enable-avcodec
	--enable-decoder=ac3,eac3,dca,truehd,mlp,alac,flac
)
OPT_FLAGS=(-Oz -flto -msimd128 -DNDEBUG)
EXPORTS="_decoder_log_level,_decoder_extradata,_decoder_open,_decoder_packet,_decoder_send,_decoder_drain,_decoder_receive,_decoder_reset,_decoder_format,_decoder_channels,_decoder_channel_mask,_decoder_sample_rate,_decoder_frames,_decoder_plane,_decoder_timestamp,_decoder_close"
# DYNAMIC_EXECUTION=0: the app's CSP allows no eval. The worker is started from a Blob, so the wasm is
# inlined (base64, plain ASCII) rather than fetched.
LINK_FLAGS=(
	-sMODULARIZE=1
	-sEXPORT_NAME=createFfmpegDecoders
	-sENVIRONMENT=worker
	-sSINGLE_FILE=1
	-sSINGLE_FILE_BINARY_ENCODE=0
	-sDYNAMIC_EXECUTION=0
	-sALLOW_MEMORY_GROWTH=1
	-sFILESYSTEM=0
	-sMALLOC=emmalloc
	-sSUPPORT_LONGJMP=0
	-sINCOMING_MODULE_JS_API=[]
	-sEXPORTED_RUNTIME_METHODS=HEAPU8
	"-sEXPORTED_FUNCTIONS=${EXPORTS}"
)
# Build paths would otherwise reach the binary through __FILE__ in FFmpeg's assertions.
FFMPEG_PREFIX_MAP="-ffile-prefix-map=<ffmpeg source>=ffmpeg"
BRIDGE_PREFIX_MAP="-ffile-prefix-map=<scripts/codecs>=codecs"

need() {
	command -v "$1" > /dev/null || {
		echo "missing $1" >&2
		exit 1
	}
}

need emcc
need curl
need shasum

emcc_version="$(emcc --version | sed -n '1s/^.*) //p')"

if [[ "${emcc_version}" != "${EMCC_VERSION}" && "${ALLOW_EMCC_MISMATCH:-}" != "1" ]]; then
	echo "emcc ${emcc_version} found, ${EMCC_VERSION} expected (ALLOW_EMCC_MISMATCH=1 builds anyway, with different bytes)" >&2
	exit 1
fi

# The Emscripten checkout: its runtime, emmalloc and musl are linked into the module.
emscripten_root="$(em-config EMSCRIPTEN_ROOT)"
emscripten_license=""

for candidate in "${emscripten_root}/LICENSE" "${emscripten_root}/../LICENSE"; do
	if [[ -f "${candidate}" ]]; then
		emscripten_license="${candidate}"
		break
	fi
done

musl_license="${emscripten_root}/system/lib/libc/musl/COPYRIGHT"
musl_version="$(cat "${emscripten_root}/system/lib/libc/musl/VERSION")"

if [[ -z "${emscripten_license}" || ! -f "${musl_license}" ]]; then
	echo "cannot find Emscripten's LICENSE or musl's COPYRIGHT under ${emscripten_root}" >&2
	exit 1
fi

if [[ -n "${FFMPEG_DECODERS_WORKDIR:-}" ]]; then
	work="${FFMPEG_DECODERS_WORKDIR}"
	mkdir -p "${work}"
else
	work="$(mktemp -d)"
	trap 'rm -rf "${work}"' EXIT
fi

work="$(cd "${work}" && pwd)"

# FFmpeg's configure splits --extra-cflags on whitespace, so the prefix maps cannot carry such a path.
if [[ "${work}" =~ [[:space:]] || "${HERE}" =~ [[:space:]] ]]; then
	echo "the work directory and this script's directory must not contain whitespace" >&2
	exit 1
fi

tarball="${work}/${FFMPEG_TARBALL}"
src="${work}/ffmpeg-${FFMPEG_VERSION}"

if [[ ! -f "${tarball}" ]]; then
	curl -fL --proto '=https' -o "${tarball}.part" "${FFMPEG_URL}"
	mv "${tarball}.part" "${tarball}"
fi

echo "${FFMPEG_SHA256}  ${tarball}" | shasum -a 256 -c -

rm -rf "${src}"
tar -xJf "${tarball}" -C "${work}"

ffmpeg_cflags=("${OPT_FLAGS[@]}" "-ffile-prefix-map=${src}=ffmpeg")

(
	cd "${src}"
	emconfigure ./configure "${CONFIGURE_FLAGS[@]}" \
		--cc=emcc --cxx=em++ --ar=emar --ranlib=emranlib --nm=emnm \
		--extra-cflags="${ffmpeg_cflags[*]}" --extra-ldflags="${OPT_FLAGS[*]}"
	emmake make -j "$(getconf _NPROCESSORS_ONLN)" libavcodec/libavcodec.a libavutil/libavutil.a
)

build="${work}/out"
mkdir -p "${build}"

emcc "${HERE}/bridge.c" "${src}/libavcodec/libavcodec.a" "${src}/libavutil/libavutil.a" \
	-I"${src}" "${ffmpeg_cflags[@]}" "-ffile-prefix-map=${HERE}=codecs" \
	"${LINK_FLAGS[@]}" \
	--extern-post-js "${HERE}/decoder-worker.js" \
	-o "${build}/${OUT_NAME}"

mkdir -p "${OUT_DIR}/licenses"
cp "${build}/${OUT_NAME}" "${OUT_DIR}/${OUT_NAME}"
cp "${emscripten_license}" "${OUT_DIR}/licenses/emscripten-LICENSE"
cp "${musl_license}" "${OUT_DIR}/licenses/musl-COPYRIGHT"

hash_of() {
	shasum -a 256 "$1" | cut -d ' ' -f 1
}

json_string() {
	local value="${1//\\/\\\\}"

	printf '"%s"' "${value//\"/\\\"}"
}

json_array() {
	local first=1

	printf '['
	for item in "$@"; do
		[[ ${first} -eq 1 ]] || printf ', '
		first=0
		json_string "${item}"
	done
	printf ']'
}

cat > "${OUT_DIR}/manifest.json" << EOF
{
	"description": "FFmpeg AC-3, E-AC-3, DTS, TrueHD/MLP, ALAC and FLAC decoders built to WebAssembly by scripts/codecs/build-ffmpeg-decoders.sh; the module is LGPL-2.1-or-later.",
	"ffmpeg": {
		"tag": "${FFMPEG_TAG}",
		"tarball": "${FFMPEG_URL}",
		"sha256": "${FFMPEG_SHA256}",
		"configure": $(json_array "${CONFIGURE_FLAGS[@]}"),
		"cflags": $(json_array "${OPT_FLAGS[@]}" "${FFMPEG_PREFIX_MAP}")
	},
	"emcc": $(json_string "${emcc_version}"),
	"emscripten": {
		"musl": $(json_string "${musl_version}"),
		"licenses": {
			"emscripten-LICENSE": "$(hash_of "${OUT_DIR}/licenses/emscripten-LICENSE")",
			"musl-COPYRIGHT": "$(hash_of "${OUT_DIR}/licenses/musl-COPYRIGHT")"
		}
	},
	"link": $(json_array "${OPT_FLAGS[@]}" "${FFMPEG_PREFIX_MAP}" "${BRIDGE_PREFIX_MAP}" "${LINK_FLAGS[@]}"),
	"sources": {
		"build-ffmpeg-decoders.sh": "$(hash_of "${HERE}/build-ffmpeg-decoders.sh")",
		"bridge.c": "$(hash_of "${HERE}/bridge.c")",
		"decoder-worker.js": "$(hash_of "${HERE}/decoder-worker.js")"
	},
	"output": {
		"${OUT_NAME}": {
			"bytes": $(wc -c < "${OUT_DIR}/${OUT_NAME}" | tr -d ' '),
			"sha256": "$(hash_of "${OUT_DIR}/${OUT_NAME}")"
		}
	}
}
EOF

echo "wrote ${OUT_DIR}/${OUT_NAME}, licenses/ and manifest.json"
