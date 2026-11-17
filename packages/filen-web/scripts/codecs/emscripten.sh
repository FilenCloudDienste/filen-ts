# Sourced by the WebAssembly build scripts beside it: the pinned Emscripten, the checks that the one found is it,
# what it links into a module (its runtime, musl) and the manifest helpers. Sets emcc_version, emcc_clang,
# emcc_homebrew (JSON), emscripten_license, musl_license and musl_version.

# Exactly as `emcc --version` prints it: a release and a -git build of it are different compilers.
EMCC_VERSION="7.0.0-git"
# `emcc --version` alone does not tell one 7.0.0-git build from another: the manifest also records the LLVM it
# drives and, for Homebrew's emscripten, the formula's version, revision and SHA-256 (the committed module: formula
# 7.0.0, revision 0, from the 7.0.0 tag tarball). A different build of the same version gives different bytes.
EMSCRIPTEN_FORMULA_VERSION="7.0.0"
EMSCRIPTEN_FORMULA_REVISION="0"

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

emcc_clang="$(emcc -v 2>&1 | sed -n 's/^clang version //p' | head -n 1)"
emcc_homebrew="null"

if command -v brew > /dev/null 2>&1 && brew list --versions emscripten > /dev/null 2>&1; then
	emcc_homebrew="$(brew info --json=v2 emscripten | node -e '
		const formula = JSON.parse(require("fs").readFileSync(0, "utf8")).formulae[0]
		const installed = formula.installed[0] ?? {}

		process.stdout.write(JSON.stringify({
			version: installed.version ?? null,
			revision: formula.revision,
			formulaSha256: formula.ruby_source_checksum?.sha256 ?? null,
			tarballSha256: formula.urls?.stable?.checksum ?? null,
			bottle: installed.poured_from_bottle === true
		}))
	')"

	if [[ "${emcc_homebrew}" != *"\"version\":\"${EMSCRIPTEN_FORMULA_VERSION}\",\"revision\":${EMSCRIPTEN_FORMULA_REVISION},"* && "${ALLOW_EMCC_MISMATCH:-}" != "1" ]]; then
		echo "Homebrew emscripten ${emcc_homebrew} found, ${EMSCRIPTEN_FORMULA_VERSION} revision ${EMSCRIPTEN_FORMULA_REVISION} expected" >&2
		exit 1
	fi
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

