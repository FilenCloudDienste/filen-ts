import { Language, LanguageSupport, StreamLanguage, type StreamParser } from "@codemirror/language"
import type { Extension } from "@codemirror/state"
import { Cassandra, PLSQL, StandardSQL, sql } from "@codemirror/lang-sql"
import { cpp } from "@codemirror/lang-cpp"
import { css } from "@codemirror/lang-css"
import { go } from "@codemirror/lang-go"
import { html } from "@codemirror/lang-html"
import { java } from "@codemirror/lang-java"
import { javascript } from "@codemirror/lang-javascript"
import { jinja } from "@codemirror/lang-jinja"
import { json } from "@codemirror/lang-json"
import { less } from "@codemirror/lang-less"
import { liquid } from "@codemirror/lang-liquid"
import { markdown, markdownLanguage } from "@codemirror/lang-markdown"
import { php } from "@codemirror/lang-php"
import { python } from "@codemirror/lang-python"
import { rust } from "@codemirror/lang-rust"
import { sass } from "@codemirror/lang-sass"
import { vue } from "@codemirror/lang-vue"
import { wast } from "@codemirror/lang-wast"
import { xml } from "@codemirror/lang-xml"
import { yaml } from "@codemirror/lang-yaml"
import { apl } from "@codemirror/legacy-modes/mode/apl"
import { asciiArmor } from "@codemirror/legacy-modes/mode/asciiarmor"
import { asn1 } from "@codemirror/legacy-modes/mode/asn1"
import { brainfuck } from "@codemirror/legacy-modes/mode/brainfuck"
import { csharp, dart, kotlin, objectiveCpp, scala, squirrel } from "@codemirror/legacy-modes/mode/clike"
import { clojure } from "@codemirror/legacy-modes/mode/clojure"
import { cmake } from "@codemirror/legacy-modes/mode/cmake"
import { cobol } from "@codemirror/legacy-modes/mode/cobol"
import { coffeeScript } from "@codemirror/legacy-modes/mode/coffeescript"
import { commonLisp } from "@codemirror/legacy-modes/mode/commonlisp"
import { crystal } from "@codemirror/legacy-modes/mode/crystal"
import { gss } from "@codemirror/legacy-modes/mode/css"
import { cypher } from "@codemirror/legacy-modes/mode/cypher"
import { d } from "@codemirror/legacy-modes/mode/d"
import { diff } from "@codemirror/legacy-modes/mode/diff"
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile"
import { dtd } from "@codemirror/legacy-modes/mode/dtd"
import { dylan } from "@codemirror/legacy-modes/mode/dylan"
import { ecl } from "@codemirror/legacy-modes/mode/ecl"
import { eiffel } from "@codemirror/legacy-modes/mode/eiffel"
import { elm } from "@codemirror/legacy-modes/mode/elm"
import { erlang } from "@codemirror/legacy-modes/mode/erlang"
import { factor } from "@codemirror/legacy-modes/mode/factor"
import { forth } from "@codemirror/legacy-modes/mode/forth"
import { fortran } from "@codemirror/legacy-modes/mode/fortran"
import { gas } from "@codemirror/legacy-modes/mode/gas"
import { gherkin } from "@codemirror/legacy-modes/mode/gherkin"
import { groovy } from "@codemirror/legacy-modes/mode/groovy"
import { haskell } from "@codemirror/legacy-modes/mode/haskell"
import { haxe, hxml } from "@codemirror/legacy-modes/mode/haxe"
import { idl } from "@codemirror/legacy-modes/mode/idl"
import { jsonld } from "@codemirror/legacy-modes/mode/javascript"
import { julia } from "@codemirror/legacy-modes/mode/julia"
import { liveScript } from "@codemirror/legacy-modes/mode/livescript"
import { lua } from "@codemirror/legacy-modes/mode/lua"
import { mathematica } from "@codemirror/legacy-modes/mode/mathematica"
import { mbox } from "@codemirror/legacy-modes/mode/mbox"
import { mirc } from "@codemirror/legacy-modes/mode/mirc"
import { fSharp, oCaml, sml } from "@codemirror/legacy-modes/mode/mllike"
import { modelica } from "@codemirror/legacy-modes/mode/modelica"
import { mscgen, msgenny, xu } from "@codemirror/legacy-modes/mode/mscgen"
import { mumps } from "@codemirror/legacy-modes/mode/mumps"
import { nsis } from "@codemirror/legacy-modes/mode/nsis"
import { ntriples } from "@codemirror/legacy-modes/mode/ntriples"
import { octave } from "@codemirror/legacy-modes/mode/octave"
import { oz } from "@codemirror/legacy-modes/mode/oz"
import { pascal } from "@codemirror/legacy-modes/mode/pascal"
import { perl } from "@codemirror/legacy-modes/mode/perl"
import { pig } from "@codemirror/legacy-modes/mode/pig"
import { powerShell } from "@codemirror/legacy-modes/mode/powershell"
import { properties } from "@codemirror/legacy-modes/mode/properties"
import { protobuf } from "@codemirror/legacy-modes/mode/protobuf"
import { pug } from "@codemirror/legacy-modes/mode/pug"
import { puppet } from "@codemirror/legacy-modes/mode/puppet"
import { cython } from "@codemirror/legacy-modes/mode/python"
import { q } from "@codemirror/legacy-modes/mode/q"
import { r } from "@codemirror/legacy-modes/mode/r"
import { rpmSpec } from "@codemirror/legacy-modes/mode/rpm"
import { ruby } from "@codemirror/legacy-modes/mode/ruby"
import { sas } from "@codemirror/legacy-modes/mode/sas"
import { scheme } from "@codemirror/legacy-modes/mode/scheme"
import { shell } from "@codemirror/legacy-modes/mode/shell"
import { sieve } from "@codemirror/legacy-modes/mode/sieve"
import { smalltalk } from "@codemirror/legacy-modes/mode/smalltalk"
import { sparql } from "@codemirror/legacy-modes/mode/sparql"
import { stex } from "@codemirror/legacy-modes/mode/stex"
import { stylus } from "@codemirror/legacy-modes/mode/stylus"
import { swift } from "@codemirror/legacy-modes/mode/swift"
import { tcl } from "@codemirror/legacy-modes/mode/tcl"
import { textile } from "@codemirror/legacy-modes/mode/textile"
import { toml } from "@codemirror/legacy-modes/mode/toml"
import { troff } from "@codemirror/legacy-modes/mode/troff"
import { ttcn } from "@codemirror/legacy-modes/mode/ttcn"
import { ttcnCfg } from "@codemirror/legacy-modes/mode/ttcn-cfg"
import { turtle } from "@codemirror/legacy-modes/mode/turtle"
import { vb } from "@codemirror/legacy-modes/mode/vb"
import { vbScript } from "@codemirror/legacy-modes/mode/vbscript"
import { velocity } from "@codemirror/legacy-modes/mode/velocity"
import { verilog } from "@codemirror/legacy-modes/mode/verilog"
import { vhdl } from "@codemirror/legacy-modes/mode/vhdl"
import { webIDL } from "@codemirror/legacy-modes/mode/webidl"
import { xQuery } from "@codemirror/legacy-modes/mode/xquery"
import { yacas } from "@codemirror/legacy-modes/mode/yacas"
import { z80 } from "@codemirror/legacy-modes/mode/z80"
import { nix } from "@replit/codemirror-lang-nix"
import { solidity } from "@replit/codemirror-lang-solidity"
import { svelte } from "@replit/codemirror-lang-svelte"
import { type CodeLanguageId, codeLanguageForExtension, isCodeLanguageId } from "../../core/code/languages"

function stream<State>(parser: StreamParser<State>): () => Extension {
	return () => StreamLanguage.define(parser)
}

// The grammar nested inside a markdown fence: its info string's first word as a language id or extension.
// Resolved lazily per fence through the shared cache; markdown itself is not nested.
function fenceLanguage(info: string): Language | null {
	const word = (/^\S+/.exec(info)?.[0] ?? "").toLowerCase()
	const id = isCodeLanguageId(word) ? word : codeLanguageForExtension(word)

	if (id === null || id === "markdown") {
		return null
	}

	const extension = codeLanguageSupport(id)

	return extension instanceof LanguageSupport ? extension.language : extension instanceof Language ? extension : null
}

// One grammar per language id. Every grammar is in the bundle (the apps load no code on demand); each is
// built on first use only.
const BUILDERS: Readonly<Record<CodeLanguageId, () => Extension>> = {
	apl: stream(apl),
	asciiarmor: stream(asciiArmor),
	asn1: stream(asn1({})),
	brainfuck: stream(brainfuck),
	clojure: stream(clojure),
	cmake: stream(cmake),
	cobol: stream(cobol),
	coffeescript: stream(coffeeScript),
	commonlisp: stream(commonLisp),
	cpp: () => cpp(),
	cql: () => sql({ dialect: Cassandra }),
	crystal: stream(crystal),
	csharp: stream(csharp),
	css: () => css(),
	cypher: stream(cypher),
	cython: stream(cython),
	d: stream(d),
	dart: stream(dart),
	diff: stream(diff),
	dockerfile: stream(dockerFile),
	dtd: stream(dtd),
	dylan: stream(dylan),
	ecl: stream(ecl),
	eiffel: stream(eiffel),
	elm: stream(elm),
	erlang: stream(erlang),
	factor: stream(factor),
	forth: stream(forth),
	fortran: stream(fortran),
	fsharp: stream(fSharp),
	gas: stream(gas),
	gherkin: stream(gherkin),
	go: () => go(),
	groovy: stream(groovy),
	gss: stream(gss),
	haskell: stream(haskell),
	haxe: stream(haxe),
	html: () => html(),
	hxml: stream(hxml),
	idl: stream(idl),
	ini: stream(properties),
	java: () => java(),
	javascript: () => javascript(),
	jinja: () => jinja(),
	json: () => json(),
	jsonld: stream(jsonld),
	jsx: () => javascript({ jsx: true }),
	julia: stream(julia),
	kotlin: stream(kotlin),
	latex: stream(stex),
	less: () => less(),
	liquid: () => liquid(),
	livescript: stream(liveScript),
	lua: stream(lua),
	markdown: () => markdown({ base: markdownLanguage, codeLanguages: fenceLanguage }),
	mathematica: stream(mathematica),
	mbox: stream(mbox),
	mirc: stream(mirc),
	modelica: stream(modelica),
	mscgen: stream(mscgen),
	msgenny: stream(msgenny),
	mumps: stream(mumps),
	nix: () => nix(),
	nsis: stream(nsis),
	ntriples: stream(ntriples),
	"objective-cpp": stream(objectiveCpp),
	ocaml: stream(oCaml),
	octave: stream(octave),
	oz: stream(oz),
	pascal: stream(pascal),
	perl: stream(perl),
	php: () => php(),
	pig: stream(pig),
	plsql: () => sql({ dialect: PLSQL }),
	powershell: stream(powerShell),
	protobuf: stream(protobuf),
	pug: stream(pug),
	puppet: stream(puppet),
	python: () => python(),
	q: stream(q),
	r: stream(r),
	"rpm-spec": stream(rpmSpec),
	ruby: stream(ruby),
	rust: () => rust(),
	sas: stream(sas),
	sass: () => sass({ indented: true }),
	scala: stream(scala),
	scheme: stream(scheme),
	scss: () => sass(),
	shell: stream(shell),
	sieve: stream(sieve),
	smalltalk: stream(smalltalk),
	sml: stream(sml),
	solidity: () => solidity,
	sparql: stream(sparql),
	sql: () => sql({ dialect: StandardSQL }),
	squirrel: stream(squirrel),
	stylus: stream(stylus),
	svelte: () => svelte(),
	swift: stream(swift),
	tcl: stream(tcl),
	textile: stream(textile),
	toml: stream(toml),
	troff: stream(troff),
	tsx: () => javascript({ jsx: true, typescript: true }),
	ttcn: stream(ttcn),
	"ttcn-cfg": stream(ttcnCfg),
	turtle: stream(turtle),
	typescript: () => javascript({ typescript: true }),
	vb: stream(vb),
	vbscript: stream(vbScript),
	velocity: stream(velocity),
	verilog: stream(verilog),
	vhdl: stream(vhdl),
	vue: () => vue(),
	wast: () => wast(),
	webidl: stream(webIDL),
	xml: () => xml(),
	xquery: stream(xQuery),
	xu: stream(xu),
	yacas: stream(yacas),
	yaml: () => yaml(),
	z80: stream(z80)
}

// One instance per language for the session: a new identity would reconfigure every editor showing it.
const cache = new Map<CodeLanguageId, Extension>()

export function codeLanguageSupport(id: CodeLanguageId): Extension {
	const cached = cache.get(id)

	if (cached !== undefined) {
		return cached
	}

	const extension = BUILDERS[id]()

	cache.set(id, extension)

	return extension
}
