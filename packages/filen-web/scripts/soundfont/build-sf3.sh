#!/usr/bin/env bash
#
# Builds the SoundFont the MIDI synthesizer plays with: GeneralUser GS 2.0.3 by S. Christian Collins, converted from
# its SF2 release to SF3 (Ogg Vorbis samples, a quarter of the size), and writes it with its licence and a manifest
# to src/assets/soundfonts/. All of it is committed; the app bundles the file and never fetches one from elsewhere.
# Re-run this only to change the bank, the converter or the quality.
#
#   scripts/soundfont/build-sf3.sh      (from packages/filen-web, after pnpm install)
#
# The same input, converter and quality give the same bytes; the manifest records all of them with the output's
# SHA-256.

set -euo pipefail

BANK_VERSION="2.0.3"
# The upstream repository's commit that published 2.0.3, and what it holds.
BANK_COMMIT="97049183643d5fc5a9322a69c5b09efb667c6c3a"
BANK_URL="https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/${BANK_COMMIT}/GeneralUser-GS.sf2"
BANK_SHA256="9575028c7a1f589f5770fccc8cff2734566af40cd26ed836944e9a5152688cfe"
LICENSE_URL="https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/${BANK_COMMIT}/documentation/LICENSE.txt"
LICENSE_SHA256="7b32efefdf95ce38a043799f0659853ddc00fbaa14d8c50f0aca16b9b8b405be"
# The Vorbis encoder: libvorbis built to WebAssembly, the bundle that inlines it pinned by hash.
ENCODER="wasm-media-encoders@0.7.0"
ENCODER_BUNDLE_SHA256="e0a17b76b146afd59961f42b1d41abfd00c5730d0fb9b605c803e62534c0c906"
VORBIS_QUALITY="4"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE="$(cd "${HERE}/../.." && pwd)"
OUT_DIR="${PACKAGE}/src/assets/soundfonts"
OUT_NAME="GeneralUser-GS-${BANK_VERSION}.sf3"

for tool in curl shasum node npm; do
	command -v "${tool}" > /dev/null || {
		echo "missing ${tool}" >&2
		exit 1
	}
done

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

curl -fL --proto '=https' -o "${work}/bank.sf2" "${BANK_URL}"
echo "${BANK_SHA256}  ${work}/bank.sf2" | shasum -a 256 -c -
curl -fL --proto '=https' -o "${work}/LICENSE.txt" "${LICENSE_URL}"
echo "${LICENSE_SHA256}  ${work}/LICENSE.txt" | shasum -a 256 -c -

# The encoder in a directory of its own, without its install scripts.
npm install --no-save --no-audit --no-fund --ignore-scripts --prefix "${work}/encoder" "${ENCODER}" > /dev/null
encoder="${work}/encoder/node_modules/wasm-media-encoders"
echo "${ENCODER_BUNDLE_SHA256}  ${encoder}/dist/es/index.mjs" | shasum -a 256 -c -

# spessasynth_core resolves from this package, the version the app plays the bank with.
(cd "${PACKAGE}" && node "${HERE}/build-sf3.mjs" "${encoder}" "${work}/bank.sf2" "${OUT_DIR}/${OUT_NAME}" "${VORBIS_QUALITY}")
cp "${work}/LICENSE.txt" "${OUT_DIR}/GeneralUser-GS-LICENSE.txt"

hash_of() {
	shasum -a 256 "$1" | cut -d ' ' -f 1
}

converter="$(node -p 'require(process.argv[1]).version' "${PACKAGE}/node_modules/spessasynth_core/package.json")"

cat > "${OUT_DIR}/manifest.json" << JSON
{
	"description": "GeneralUser GS ${BANK_VERSION} by S. Christian Collins, converted to SF3 by scripts/soundfont/build-sf3.sh.",
	"input": {
		"url": "${BANK_URL}",
		"sha256": "${BANK_SHA256}"
	},
	"converter": {
		"spessasynth_core": "${converter}",
		"encoder": "${ENCODER}",
		"encoderBundleSha256": "${ENCODER_BUNDLE_SHA256}",
		"vorbisQuality": ${VORBIS_QUALITY}
	},
	"sources": {
		"build-sf3.sh": "$(hash_of "${HERE}/build-sf3.sh")",
		"build-sf3.mjs": "$(hash_of "${HERE}/build-sf3.mjs")"
	},
	"license": {
		"GeneralUser-GS-LICENSE.txt": "$(hash_of "${OUT_DIR}/GeneralUser-GS-LICENSE.txt")"
	},
	"output": {
		"${OUT_NAME}": {
			"bytes": $(wc -c < "${OUT_DIR}/${OUT_NAME}" | tr -d ' '),
			"sha256": "$(hash_of "${OUT_DIR}/${OUT_NAME}")"
		}
	}
}
JSON

echo "wrote ${OUT_DIR}/${OUT_NAME}, its licence and manifest.json"
