// File extension -> code language, shared by every app's code editor. The extensions are mobile's
// CodeMirror language table (CodeMirror's own language-data lists), lowercased, plus the ones web already
// recognised, except "text", which is left as plain text rather than LaTeX; lookups take the extension
// lowercased and without its dot. Grammars live in dom/code.

export type CodeLanguageId =
	| "apl"
	| "asciiarmor"
	| "asn1"
	| "brainfuck"
	| "clojure"
	| "cmake"
	| "cobol"
	| "coffeescript"
	| "commonlisp"
	| "cpp"
	| "cql"
	| "crystal"
	| "csharp"
	| "css"
	| "cypher"
	| "cython"
	| "d"
	| "dart"
	| "diff"
	| "dockerfile"
	| "dtd"
	| "dylan"
	| "ecl"
	| "eiffel"
	| "elm"
	| "erlang"
	| "factor"
	| "forth"
	| "fortran"
	| "fsharp"
	| "gas"
	| "gherkin"
	| "go"
	| "groovy"
	| "gss"
	| "haskell"
	| "haxe"
	| "html"
	| "hxml"
	| "idl"
	| "ini"
	| "java"
	| "javascript"
	| "jinja"
	| "json"
	| "jsonld"
	| "jsx"
	| "julia"
	| "kotlin"
	| "latex"
	| "less"
	| "liquid"
	| "livescript"
	| "lua"
	| "markdown"
	| "mathematica"
	| "mbox"
	| "mirc"
	| "modelica"
	| "mscgen"
	| "msgenny"
	| "mumps"
	| "nix"
	| "nsis"
	| "ntriples"
	| "objective-cpp"
	| "ocaml"
	| "octave"
	| "oz"
	| "pascal"
	| "perl"
	| "php"
	| "pig"
	| "plsql"
	| "powershell"
	| "protobuf"
	| "pug"
	| "puppet"
	| "python"
	| "q"
	| "r"
	| "rpm-spec"
	| "ruby"
	| "rust"
	| "sas"
	| "sass"
	| "scala"
	| "scheme"
	| "scss"
	| "shell"
	| "sieve"
	| "smalltalk"
	| "sml"
	| "solidity"
	| "sparql"
	| "sql"
	| "squirrel"
	| "stylus"
	| "svelte"
	| "swift"
	| "tcl"
	| "textile"
	| "toml"
	| "troff"
	| "tsx"
	| "ttcn"
	| "ttcn-cfg"
	| "turtle"
	| "typescript"
	| "vb"
	| "vbscript"
	| "velocity"
	| "verilog"
	| "vhdl"
	| "vue"
	| "wast"
	| "webidl"
	| "xml"
	| "xquery"
	| "xu"
	| "yacas"
	| "yaml"
	| "z80"

export interface CodeLanguage {
	readonly name: string
}

export const CODE_LANGUAGES: Readonly<Record<CodeLanguageId, CodeLanguage>> = {
	apl: { name: "APL" },
	asciiarmor: { name: "PGP" },
	asn1: { name: "ASN.1" },
	brainfuck: { name: "Brainfuck" },
	clojure: { name: "Clojure" },
	cmake: { name: "CMake" },
	cobol: { name: "Cobol" },
	coffeescript: { name: "CoffeeScript" },
	commonlisp: { name: "Common Lisp" },
	cpp: { name: "C++" },
	cql: { name: "CQL" },
	crystal: { name: "Crystal" },
	csharp: { name: "C#" },
	css: { name: "CSS" },
	cypher: { name: "Cypher" },
	cython: { name: "Cython" },
	d: { name: "D" },
	dart: { name: "Dart" },
	diff: { name: "Diff" },
	dockerfile: { name: "Dockerfile" },
	dtd: { name: "DTD" },
	dylan: { name: "Dylan" },
	ecl: { name: "ECL" },
	eiffel: { name: "Eiffel" },
	elm: { name: "Elm" },
	erlang: { name: "Erlang" },
	factor: { name: "Factor" },
	forth: { name: "Forth" },
	fortran: { name: "Fortran" },
	fsharp: { name: "F#" },
	gas: { name: "Gas" },
	gherkin: { name: "Gherkin" },
	go: { name: "Go" },
	groovy: { name: "Groovy" },
	gss: { name: "Closure Stylesheets (GSS)" },
	haskell: { name: "Haskell" },
	haxe: { name: "Haxe" },
	html: { name: "HTML" },
	hxml: { name: "HXML" },
	idl: { name: "IDL" },
	ini: { name: "Properties files" },
	java: { name: "Java" },
	javascript: { name: "JavaScript" },
	jinja: { name: "Jinja" },
	json: { name: "JSON" },
	jsonld: { name: "JSON-LD" },
	jsx: { name: "JSX" },
	julia: { name: "Julia" },
	kotlin: { name: "Kotlin" },
	latex: { name: "LaTeX" },
	less: { name: "LESS" },
	liquid: { name: "Liquid" },
	livescript: { name: "LiveScript" },
	lua: { name: "Lua" },
	markdown: { name: "Markdown" },
	mathematica: { name: "Mathematica" },
	mbox: { name: "Mbox" },
	mirc: { name: "mIRC" },
	modelica: { name: "Modelica" },
	mscgen: { name: "Mscgen" },
	msgenny: { name: "MsGenny" },
	mumps: { name: "MUMPS" },
	nix: { name: "Nix" },
	nsis: { name: "NSIS" },
	ntriples: { name: "NTriples" },
	"objective-cpp": { name: "Objective-C++" },
	ocaml: { name: "OCaml" },
	octave: { name: "Octave" },
	oz: { name: "Oz" },
	pascal: { name: "Pascal" },
	perl: { name: "Perl" },
	php: { name: "PHP" },
	pig: { name: "Pig" },
	plsql: { name: "PLSQL" },
	powershell: { name: "PowerShell" },
	protobuf: { name: "ProtoBuf" },
	pug: { name: "Pug" },
	puppet: { name: "Puppet" },
	python: { name: "Python" },
	q: { name: "Q" },
	r: { name: "R" },
	"rpm-spec": { name: "RPM Spec" },
	ruby: { name: "Ruby" },
	rust: { name: "Rust" },
	sas: { name: "SAS" },
	sass: { name: "Sass" },
	scala: { name: "Scala" },
	scheme: { name: "Scheme" },
	scss: { name: "SCSS" },
	shell: { name: "Shell" },
	sieve: { name: "Sieve" },
	smalltalk: { name: "Smalltalk" },
	sml: { name: "SML" },
	solidity: { name: "Solidity" },
	sparql: { name: "SPARQL" },
	sql: { name: "SQL" },
	squirrel: { name: "Squirrel" },
	stylus: { name: "Stylus" },
	svelte: { name: "Svelte" },
	swift: { name: "Swift" },
	tcl: { name: "Tcl" },
	textile: { name: "Textile" },
	toml: { name: "TOML" },
	troff: { name: "troff" },
	tsx: { name: "TSX" },
	ttcn: { name: "TTCN" },
	"ttcn-cfg": { name: "TTCN_CFG" },
	turtle: { name: "Turtle" },
	typescript: { name: "TypeScript" },
	vb: { name: "VB.NET" },
	vbscript: { name: "VBScript" },
	velocity: { name: "Velocity" },
	verilog: { name: "Verilog" },
	vhdl: { name: "VHDL" },
	vue: { name: "Vue" },
	wast: { name: "WebAssembly" },
	webidl: { name: "Web IDL" },
	xml: { name: "XML" },
	xquery: { name: "XQuery" },
	xu: { name: "xu" },
	yacas: { name: "Yacas" },
	yaml: { name: "YAML" },
	z80: { name: "Z80" }
}

// A Map, so a lookup can never reach an inherited key ("constructor", "__proto__").
const BY_EXTENSION: ReadonlyMap<string, CodeLanguageId> = new Map<string, CodeLanguageId>([
	["1", "troff"],
	["2", "troff"],
	["3", "troff"],
	["4", "troff"],
	["4th", "forth"],
	["5", "troff"],
	["6", "troff"],
	["7", "troff"],
	["8", "troff"],
	["9", "troff"],
	["apl", "apl"],
	["asc", "asciiarmor"],
	["asn", "asn1"],
	["asn1", "asn1"],
	["b", "brainfuck"],
	["bash", "shell"],
	["bf", "brainfuck"],
	["bzl", "python"],
	["c", "cpp"],
	["c++", "cpp"],
	["cc", "cpp"],
	["cfg", "ttcn-cfg"],
	["cjs", "javascript"],
	["cl", "commonlisp"],
	["clj", "clojure"],
	["cljc", "clojure"],
	["cljs", "clojure"],
	["cljx", "clojure"],
	["cmake", "cmake"],
	["cmake.in", "cmake"],
	["cob", "cobol"],
	["cobol", "cobol"],
	["coffee", "coffeescript"],
	["conf", "ini"],
	["cpp", "cpp"],
	["cpy", "cobol"],
	["cql", "cql"],
	["cr", "crystal"],
	["cs", "csharp"],
	["css", "css"],
	["css3", "css"],
	["cts", "typescript"],
	["cxx", "cpp"],
	["cyp", "cypher"],
	["cypher", "cypher"],
	["d", "d"],
	["dart", "dart"],
	["diff", "diff"],
	["dockerfile", "dockerfile"],
	["dtd", "dtd"],
	["dyalog", "apl"],
	["dyl", "dylan"],
	["dylan", "dylan"],
	["e", "eiffel"],
	["ecl", "ecl"],
	["edn", "clojure"],
	["el", "commonlisp"],
	["elm", "elm"],
	["erl", "erlang"],
	["f", "fortran"],
	["f77", "fortran"],
	["f90", "fortran"],
	["f95", "fortran"],
	["factor", "factor"],
	["feature", "gherkin"],
	["for", "fortran"],
	["forth", "forth"],
	["fs", "fsharp"],
	["fth", "forth"],
	["fun", "sml"],
	["go", "go"],
	["gradle", "groovy"],
	["groovy", "groovy"],
	["gss", "gss"],
	["h", "cpp"],
	["h++", "cpp"],
	["handlebars", "html"],
	["hbs", "html"],
	["hh", "cpp"],
	["hpp", "cpp"],
	["hs", "haskell"],
	["htm", "html"],
	["html", "html"],
	["html5", "html"],
	["hx", "haxe"],
	["hxml", "hxml"],
	["hxx", "cpp"],
	["in", "ini"],
	["ini", "ini"],
	["ino", "cpp"],
	["intr", "dylan"],
	["j2", "jinja"],
	["jade", "pug"],
	["java", "java"],
	["jinja", "jinja"],
	["jinja2", "jinja"],
	["jl", "julia"],
	["js", "javascript"],
	["json", "json"],
	["jsonld", "jsonld"],
	["jsx", "jsx"],
	["ksh", "shell"],
	["kt", "kotlin"],
	["kts", "kotlin"],
	["less", "less"],
	["liquid", "liquid"],
	["lisp", "commonlisp"],
	["litcoffee", "coffeescript"],
	["ls", "livescript"],
	["ltx", "latex"],
	["lua", "lua"],
	["m", "octave"],
	["map", "json"],
	["markdown", "markdown"],
	["mbox", "mbox"],
	["md", "markdown"],
	["mjs", "javascript"],
	["mkd", "markdown"],
	["ml", "ocaml"],
	["mli", "ocaml"],
	["mll", "ocaml"],
	["mly", "ocaml"],
	["mm", "objective-cpp"],
	["mo", "modelica"],
	["mps", "mumps"],
	["mrc", "mirc"],
	["msc", "mscgen"],
	["mscgen", "mscgen"],
	["mscin", "mscgen"],
	["msgenny", "msgenny"],
	["mts", "typescript"],
	["nb", "mathematica"],
	["nix", "nix"],
	["nq", "ntriples"],
	["nsh", "nsis"],
	["nsi", "nsis"],
	["nt", "ntriples"],
	["nut", "squirrel"],
	["oz", "oz"],
	["p", "pascal"],
	["pas", "pascal"],
	["patch", "diff"],
	["pgp", "asciiarmor"],
	["php", "php"],
	["php3", "php"],
	["php4", "php"],
	["php5", "php"],
	["php7", "php"],
	["phtml", "php"],
	["pig", "pig"],
	["pl", "perl"],
	["pls", "plsql"],
	["pm", "perl"],
	["pp", "puppet"],
	["pro", "idl"],
	["properties", "ini"],
	["proto", "protobuf"],
	["protobuf", "protobuf"],
	["ps1", "powershell"],
	["psd1", "powershell"],
	["psm1", "powershell"],
	["pug", "pug"],
	["pxd", "cython"],
	["pxi", "cython"],
	["py", "python"],
	["py3", "python"],
	["python", "python"],
	["pyw", "python"],
	["pyx", "cython"],
	["q", "q"],
	["r", "r"],
	["rb", "ruby"],
	["rq", "sparql"],
	["rs", "rust"],
	["s", "gas"],
	["sas", "sas"],
	["sass", "sass"],
	["scala", "scala"],
	["scm", "scheme"],
	["scss", "scss"],
	["sh", "shell"],
	["sieve", "sieve"],
	["sig", "sml"],
	["siv", "sieve"],
	["smackspec", "sml"],
	["sml", "sml"],
	["solidity", "solidity"],
	["sparql", "sparql"],
	["spec", "rpm-spec"],
	["sql", "sql"],
	["ss", "scheme"],
	["st", "smalltalk"],
	["styl", "stylus"],
	["sv", "verilog"],
	["svelte", "svelte"],
	["svg", "xml"],
	["svh", "verilog"],
	["swift", "swift"],
	["tcl", "tcl"],
	["tex", "latex"],
	["textile", "textile"],
	["toml", "toml"],
	["ts", "typescript"],
	["tsx", "tsx"],
	["ttcn", "ttcn"],
	["ttcn3", "ttcn"],
	["ttcnpp", "ttcn"],
	["ttl", "turtle"],
	["v", "verilog"],
	["vb", "vb"],
	["vbs", "vbscript"],
	["vhd", "vhdl"],
	["vhdl", "vhdl"],
	["vtl", "velocity"],
	["vue", "vue"],
	["wast", "wast"],
	["wat", "wast"],
	["webidl", "webidl"],
	["wl", "mathematica"],
	["wls", "mathematica"],
	["xml", "xml"],
	["xq", "xquery"],
	["xqm", "xquery"],
	["xquery", "xquery"],
	["xqy", "xquery"],
	["xsd", "xml"],
	["xsl", "xml"],
	["xu", "xu"],
	["xy", "xquery"],
	["yaml", "yaml"],
	["yml", "yaml"],
	["ys", "yacas"],
	["z80", "z80"]
])

// The language for a lowercased, dot-less extension, or null for one no grammar covers.
export function codeLanguageForExtension(extension: string): CodeLanguageId | null {
	return BY_EXTENSION.get(extension) ?? null
}

const EXTENSIONS: readonly string[] = Object.freeze([...BY_EXTENSION.keys()])

// Every extension codeLanguageForExtension recognises.
export function codeLanguageExtensions(): readonly string[] {
	return EXTENSIONS
}

const IDS: ReadonlySet<string> = new Set(Object.keys(CODE_LANGUAGES))

export function isCodeLanguageId(value: string): value is CodeLanguageId {
	return IDS.has(value)
}
