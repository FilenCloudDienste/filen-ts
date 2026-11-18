// "iso1 iso2B iso2T name"; "-" in the 639-1 column = none, in the 639-2/T column = same as /B.
const LANGUAGE_TABLE = `aa aar - Afar
ab abk - Abkhazian
af afr - Afrikaans
ak aka - Akan
am amh - Amharic
an arg - Aragonese
ar ara - Arabic
as asm - Assamese
av ava - Avaric
ay aym - Aymara
az aze - Azerbaijani
ba bak - Bashkir
be bel - Belarusian
bg bul - Bulgarian
bi bis - Bislama
bm bam - Bambara
bn ben - Bengali
bo tib bod Tibetan
br bre - Breton
bs bos - Bosnian
ca cat - Catalan
ce che - Chechen
ch cha - Chamorro
co cos - Corsican
cr cre - Cree
cs cze ces Czech
cu chu - Church Slavic
cv chv - Chuvash
cy wel cym Welsh
da dan - Danish
de ger deu German
dv div - Divehi
dz dzo - Dzongkha
ee ewe - Ewe
el gre ell Greek
en eng - English
eo epo - Esperanto
es spa - Spanish
et est - Estonian
eu baq eus Basque
fa per fas Persian
ff ful - Fulah
fi fin - Finnish
fj fij - Fijian
fo fao - Faroese
fr fre fra French
fy fry - Western Frisian
ga gle - Irish
gd gla - Scottish Gaelic
gl glg - Galician
gn grn - Guarani
gu guj - Gujarati
gv glv - Manx
ha hau - Hausa
he heb - Hebrew
hi hin - Hindi
ho hmo - Hiri Motu
hr hrv - Croatian
ht hat - Haitian Creole
hu hun - Hungarian
hy arm hye Armenian
hz her - Herero
ia ina - Interlingua
id ind - Indonesian
ie ile - Interlingue
ig ibo - Igbo
ii iii - Sichuan Yi
ik ipk - Inupiaq
io ido - Ido
is ice isl Icelandic
it ita - Italian
iu iku - Inuktitut
ja jpn - Japanese
jv jav - Javanese
ka geo kat Georgian
kg kon - Kongo
ki kik - Kikuyu
kj kua - Kuanyama
kk kaz - Kazakh
kl kal - Kalaallisut
km khm - Khmer
kn kan - Kannada
ko kor - Korean
kr kau - Kanuri
ks kas - Kashmiri
ku kur - Kurdish
kv kom - Komi
kw cor - Cornish
ky kir - Kyrgyz
la lat - Latin
lb ltz - Luxembourgish
lg lug - Ganda
li lim - Limburgish
ln lin - Lingala
lo lao - Lao
lt lit - Lithuanian
lu lub - Luba-Katanga
lv lav - Latvian
mg mlg - Malagasy
mh mah - Marshallese
mi mao mri Maori
mk mac mkd Macedonian
ml mal - Malayalam
mn mon - Mongolian
mr mar - Marathi
ms may msa Malay
mt mlt - Maltese
my bur mya Burmese
na nau - Nauru
nb nob - Norwegian Bokmal
nd nde - North Ndebele
ne nep - Nepali
ng ndo - Ndonga
nl dut nld Dutch
nn nno - Norwegian Nynorsk
no nor - Norwegian
nr nbl - South Ndebele
nv nav - Navajo
ny nya - Chichewa
oc oci - Occitan
oj oji - Ojibwa
om orm - Oromo
or ori - Oriya
os oss - Ossetian
pa pan - Punjabi
pi pli - Pali
pl pol - Polish
ps pus - Pashto
pt por - Portuguese
qu que - Quechua
rm roh - Romansh
rn run - Rundi
ro rum ron Romanian
ru rus - Russian
rw kin - Kinyarwanda
sa san - Sanskrit
sc srd - Sardinian
sd snd - Sindhi
se sme - Northern Sami
sg sag - Sango
si sin - Sinhala
sk slo slk Slovak
sl slv - Slovenian
sm smo - Samoan
sn sna - Shona
so som - Somali
sq alb sqi Albanian
sr srp - Serbian
ss ssw - Swati
st sot - Southern Sotho
su sun - Sundanese
sv swe - Swedish
sw swa - Swahili
ta tam - Tamil
te tel - Telugu
tg tgk - Tajik
th tha - Thai
ti tir - Tigrinya
tk tuk - Turkmen
tl tgl - Tagalog
tn tsn - Tswana
to ton - Tonga
tr tur - Turkish
ts tso - Tsonga
tt tat - Tatar
tw twi - Twi
ty tah - Tahitian
ug uig - Uyghur
uk ukr - Ukrainian
ur urd - Urdu
uz uzb - Uzbek
ve ven - Venda
vi vie - Vietnamese
vo vol - Volapuk
wa wln - Walloon
wo wol - Wolof
xh xho - Xhosa
yi yid - Yiddish
yo yor - Yoruba
za zha - Zhuang
zh chi zho Chinese
zu zul - Zulu
- fil - Filipino
- yue - Cantonese
- haw - Hawaiian
- ceb - Cebuano
- hmn - Hmong
- sah - Yakut
- cmn - Mandarin Chinese
- tlh - Klingon`

// Legacy and macro codes folded into one canonical primary subtag.
const LEGACY: ReadonlyMap<string, string> = new Map([
	["iw", "he"],
	["in", "id"],
	["ji", "yi"],
	["jw", "jv"],
	["nb", "no"],
	["nn", "no"],
	["fil", "tl"],
	["tgl", "tl"],
	["nob", "no"],
	["nno", "no"],
	["cmn", "zh"],
	["sh", "sr"],
	["scc", "sr"],
	["scr", "hr"]
])

// Name lookups ignore combining marks, so "Español" and a decomposed "bokmål" meet their ASCII keys. Letters with no
// decomposition (ø, æ, ß) need their own aliases.
function foldName(name: string): string {
	return name.normalize("NFD").replace(/\p{M}+/gu, "")
}

// Keys are folded (foldName).
const NAME_ALIASES: ReadonlyMap<string, string> = new Map([
	["castilian", "es"],
	["flemish", "nl"],
	["mandarin", "zh"],
	["simplified chinese", "zh"],
	["traditional chinese", "zh"],
	["brazilian", "pt"],
	["deutsch", "de"],
	["espanol", "es"],
	["francais", "fr"],
	["italiano", "it"],
	["portugues", "pt"],
	["bokmal", "no"],
	["norwegian bokmal", "no"],
	["farsi", "fa"],
	["brazilian portuguese", "pt"],
	["portuguese brazilian", "pt"],
	["modern greek", "el"],
	["chinese simplified", "zh"],
	["chinese traditional", "zh"]
])

// Codes that mean "no usable language".
const UNDETERMINED: ReadonlySet<string> = new Set([
	"und",
	"mis",
	"zxx",
	"mul",
	"unk",
	"qaa",
	"qad",
	"xx",
	"nolang",
	"no-lang",
	"no linguistic content"
])

interface LanguageIndex {
	byCode: Map<string, string>
	names: Map<string, string>
	byName: Map<string, string>
}

let index: LanguageIndex | null = null

function languageIndex(): LanguageIndex {
	if (index !== null) {
		return index
	}

	const byCode = new Map<string, string>()
	const names = new Map<string, string>()
	const byName = new Map<string, string>()

	for (const line of LANGUAGE_TABLE.split("\n")) {
		const parts = line.split(" ")
		const iso1 = parts[0] ?? "-"
		const b = parts[1] ?? ""
		const t = parts[2] ?? "-"
		const name = parts.slice(3).join(" ")
		const primary = iso1 === "-" ? b : iso1

		byCode.set(primary, primary)
		byCode.set(b, primary)

		if (t !== "-") {
			byCode.set(t, primary)
		}

		names.set(primary, name)
		byName.set(foldName(name.toLowerCase()), primary)
	}

	index = {
		byCode,
		names,
		byName
	}

	return index
}

function foldToCanonical(primary: string): string {
	return LEGACY.get(primary) ?? primary
}

// Primary BCP 47 subtag (639-1 where one exists, else 639-2), from 639-1/-2B/-2T codes, BCP 47 tags or English names. null when unknown or undetermined.
export function normalizeLanguage(input: string | null | undefined): string | null {
	if (input === null || input === undefined || input.length > 64) {
		return null
	}

	const value = input.trim().toLowerCase().replace(/_/g, "-")

	if (value.length === 0 || UNDETERMINED.has(value)) {
		return null
	}

	const idx = languageIndex()
	let end = value.indexOf("-")

	if (end === -1) {
		end = value.length
	}

	const head = value.slice(0, end)

	if (head.length === 2 || head.length === 3) {
		if (UNDETERMINED.has(head)) {
			return null
		}

		const known = idx.byCode.get(head)

		if (known !== undefined) {
			return foldToCanonical(known)
		}

		const legacy = LEGACY.get(head)

		if (legacy !== undefined) {
			return foldToCanonical(legacy)
		}

		if (head.length === 2) {
			return null
		}
	}

	// English name, optionally followed by a qualifier like "(US)".
	const name = foldName(
		value
			.replace(/\s*[(,].*$/, "")
			.replace(/-/g, " ")
			.trim()
	)
	const byName = idx.byName.get(name) ?? NAME_ALIASES.get(name)

	return byName === undefined ? null : foldToCanonical(byName)
}

// English name for a code, or null.
export function languageName(code: string | null | undefined): string | null {
	const normalized = normalizeLanguage(code)

	if (normalized === null) {
		return null
	}

	const idx = languageIndex()

	return idx.names.get(normalized) ?? idx.names.get(idx.byCode.get(normalized) ?? "") ?? null
}

export function languagesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
	const left = normalizeLanguage(a)

	return left !== null && left === normalizeLanguage(b)
}

// Position of `lang` in an already-normalised preference list, -1 when absent or unknown.
export function languagePreferenceRank(lang: string | null | undefined, preferred: readonly string[]): number {
	const normalized = normalizeLanguage(lang)

	return normalized === null ? -1 : preferred.indexOf(normalized)
}
