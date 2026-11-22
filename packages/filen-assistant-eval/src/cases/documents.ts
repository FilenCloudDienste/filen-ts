import type { AppContext, OpenDocument } from "../fixture"
import type { ArgMatcher, Category, EvalCase, Language } from "./types"

// read_document over the fixture's documents: f7 Arbeitsvertrag_Filen.pdf (3 pages: start date, salary 4.850 EUR,
// 30 vacation days and a three-month notice period), f8 CV_2025.docx (2 pages), f30 presupuesto.xlsx (sheets
// Resumen and Gastos: 7.260 € left), f46 Presentacion_kickoff.pptx (6 slides; slide 5 the budget, its notes on
// catering) and f33 report_Q3.pdf (40 pages, only a chunked read reaches pages 31, 34 and 38: churn 2.1%, a Lisbon
// office, headcount 48).

const PARENTS: Readonly<Record<string, string>> = { f7: "d3", f8: "d1", f30: "d12", f33: "d13", f46: "d12" }

// A preview open on the drive screen, the assistant beside it.
export function openDocument(document: OpenDocument): Partial<AppContext> {
	return { screen: "drive", directory: PARENTS[document.handle] ?? "d0", openDocument: document }
}

type DocumentScenario = {
	id: string
	lang: Language
	prompt: string
	open?: OpenDocument
	handle: string
	args?: Readonly<Record<string, ArgMatcher>>
	answer?: readonly string[]
}

function documentCase(category: Category, scenario: DocumentScenario, extra: Partial<EvalCase> = {}): EvalCase {
	return {
		id: scenario.id,
		category,
		lang: scenario.lang,
		prompt: scenario.prompt,
		...(scenario.open === undefined ? {} : { context: openDocument(scenario.open) }),
		routes: ["files"],
		calls: [{ tool: "read_document", args: { handle: scenario.handle, ...scenario.args } }],
		...(scenario.answer === undefined ? {} : { answerIncludes: [scenario.answer] }),
		expectsText: true,
		...extra
	}
}

// "Summarize this" beside an open document: the context handle, never a search for it.
const SUMMARIZE_OPEN: readonly DocumentScenario[] = [
	{
		id: "document-summarize-open-en",
		lang: "en",
		prompt: "Summarize this document",
		open: { handle: "f7", page: 1 },
		handle: "f7",
		answer: ["filen"]
	},
	{
		id: "document-summarize-open-de",
		lang: "de",
		prompt: "Fass dieses Dokument zusammen",
		open: { handle: "f7", page: 2 },
		handle: "f7",
		answer: ["filen", "4.850", "4850"]
	},
	{
		id: "document-summarize-open-es",
		lang: "es",
		prompt: "Resume esta presentación",
		open: { handle: "f46", slide: 1 },
		handle: "f46",
		answer: ["barcelona"]
	},
	{
		id: "document-summarize-open-fr",
		lang: "fr",
		prompt: "Résume ce document",
		open: { handle: "f8", page: 1 },
		handle: "f8",
		answer: ["sam", "weber"]
	},
	{
		id: "document-summarize-open-pt",
		lang: "pt",
		prompt: "Resuma esta apresentação",
		open: { handle: "f46", slide: 2 },
		handle: "f46",
		answer: ["barcelona"]
	},
	{
		id: "document-summarize-open-ru",
		lang: "ru",
		prompt: "Кратко перескажи этот документ",
		open: { handle: "f7", page: 1 },
		handle: "f7",
		answer: ["filen"]
	},
	{
		id: "document-summarize-open-tr",
		lang: "tr",
		prompt: "Bu belgeyi özetle",
		open: { handle: "f8", page: 1 },
		handle: "f8",
		answer: ["sam", "weber"]
	},
	{
		id: "document-summarize-open-ar",
		lang: "ar",
		prompt: "لخّص هذا المستند",
		open: { handle: "f7", page: 1 },
		handle: "f7",
		answer: ["filen", "فيلن"]
	},
	{
		id: "document-summarize-open-hi",
		lang: "hi",
		prompt: "इस दस्तावेज़ का सारांश दो",
		open: { handle: "f8", page: 2 },
		handle: "f8",
		answer: ["sam", "weber", "सैम"]
	},
	{
		id: "document-summarize-open-id",
		lang: "id",
		prompt: "Ringkas presentasi ini",
		open: { handle: "f46", slide: 1 },
		handle: "f46",
		answer: ["barcelona"]
	},
	{
		id: "document-summarize-open-zh",
		lang: "zh",
		prompt: "总结一下这个文档",
		open: { handle: "f7", page: 1 },
		handle: "f7",
		answer: ["filen"]
	},
	{
		id: "document-summarize-open-ja",
		lang: "ja",
		prompt: "このドキュメントを要約して",
		open: { handle: "f8", page: 1 },
		handle: "f8",
		answer: ["sam", "weber", "サム"]
	}
]

const SALARY = ["4.850", "4850", "4,850", "٤٫٨٥٠"]
const VACATION = ["30", "٣٠"]
const SLIDE_5 = ["18.500", "18500", "18,500", "catering"]
const GASTOS = ["vuelos", "hotel", "catering", "4.900", "4900"]
const LEFT = ["7.260", "7260", "7,260"]

const page2 = { from: 2, to: { $absentOr: 2 } }
const pages23 = { from: 2, to: 3 }
const slide5 = { from: 5, to: { $absentOr: 5 } }
const gastos = { sheet: { $includes: ["gastos"] } }

// A page, slide or sheet of the open document, by number or name.
const RANGES: readonly DocumentScenario[] = [
	{
		id: "document-page-en",
		lang: "en",
		prompt: "What does page 2 say?",
		open: { handle: "f7", page: 1 },
		handle: "f7",
		args: page2,
		answer: SALARY
	},
	{
		id: "document-slide-en",
		lang: "en",
		prompt: "What's on slide 5?",
		open: { handle: "f46", slide: 1 },
		handle: "f46",
		args: slide5,
		answer: SLIDE_5
	},
	{
		id: "document-page-de",
		lang: "de",
		prompt: "Was steht auf Seite 2?",
		open: { handle: "f7", page: 3 },
		handle: "f7",
		args: page2,
		answer: SALARY
	},
	{
		id: "document-pages-de",
		lang: "de",
		prompt: "Lies die Seiten 2 bis 3 und sag mir, wie viele Urlaubstage ich habe",
		open: { handle: "f7", page: 1 },
		handle: "f7",
		args: pages23,
		answer: VACATION
	},
	{
		id: "document-sheet-es",
		lang: "es",
		prompt: "¿Qué hay en la hoja Gastos?",
		open: { handle: "f30", sheet: "Resumen" },
		handle: "f30",
		args: gastos,
		answer: GASTOS
	},
	{
		id: "document-slide-es",
		lang: "es",
		prompt: "¿Qué dice la diapositiva 5?",
		open: { handle: "f46", slide: 2 },
		handle: "f46",
		args: slide5,
		answer: SLIDE_5
	},
	{
		id: "document-page-fr",
		lang: "fr",
		prompt: "Que dit la page 2 ?",
		open: { handle: "f7", page: 1 },
		handle: "f7",
		args: page2,
		answer: SALARY
	},
	{
		id: "document-sheet-fr",
		lang: "fr",
		prompt: "Lis la feuille Gastos de ce tableur",
		open: { handle: "f30", sheet: "Resumen" },
		handle: "f30",
		args: gastos,
		answer: GASTOS
	},
	{
		id: "document-slide-pt",
		lang: "pt",
		prompt: "O que diz o slide 5?",
		open: { handle: "f46", slide: 1 },
		handle: "f46",
		args: slide5,
		answer: SLIDE_5
	},
	{
		id: "document-pages-pt",
		lang: "pt",
		prompt: "Leia as páginas 2 a 3 e diga quantos dias de férias tenho",
		open: { handle: "f7", page: 1 },
		handle: "f7",
		args: pages23,
		answer: VACATION
	},
	{
		id: "document-page-ru",
		lang: "ru",
		prompt: "Что написано на странице 2?",
		open: { handle: "f7", page: 1 },
		handle: "f7",
		args: page2,
		answer: SALARY
	},
	{
		id: "document-sheet-ru",
		lang: "ru",
		prompt: "Что на листе Gastos?",
		open: { handle: "f30", sheet: "Resumen" },
		handle: "f30",
		args: gastos,
		answer: GASTOS
	},
	{
		id: "document-page-tr",
		lang: "tr",
		prompt: "2. sayfada ne yazıyor?",
		open: { handle: "f7", page: 1 },
		handle: "f7",
		args: page2,
		answer: SALARY
	},
	{
		id: "document-slide-tr",
		lang: "tr",
		prompt: "5. slaytta ne var?",
		open: { handle: "f46", slide: 1 },
		handle: "f46",
		args: slide5,
		answer: SLIDE_5
	},
	{
		id: "document-page-ar",
		lang: "ar",
		prompt: "ماذا تقول الصفحة 2؟",
		open: { handle: "f7", page: 1 },
		handle: "f7",
		args: page2,
		answer: SALARY
	},
	{
		id: "document-sheet-ar",
		lang: "ar",
		prompt: "ماذا يوجد في ورقة Gastos؟",
		open: { handle: "f30", sheet: "Resumen" },
		handle: "f30",
		args: gastos,
		answer: GASTOS
	},
	{
		id: "document-page-hi",
		lang: "hi",
		prompt: "पेज 2 पर क्या लिखा है?",
		open: { handle: "f7", page: 1 },
		handle: "f7",
		args: page2,
		answer: SALARY
	},
	{
		id: "document-slide-hi",
		lang: "hi",
		prompt: "स्लाइड 5 में क्या है?",
		open: { handle: "f46", slide: 1 },
		handle: "f46",
		args: slide5,
		answer: SLIDE_5
	},
	{
		id: "document-pages-id",
		lang: "id",
		prompt: "Baca halaman 2 sampai 3, berapa hari cuti saya?",
		open: { handle: "f7", page: 1 },
		handle: "f7",
		args: pages23,
		answer: VACATION
	},
	{
		id: "document-sheet-id",
		lang: "id",
		prompt: "Apa isi sheet Gastos?",
		open: { handle: "f30", sheet: "Resumen" },
		handle: "f30",
		args: gastos,
		answer: GASTOS
	},
	{
		id: "document-page-zh",
		lang: "zh",
		prompt: "第2页写了什么？",
		open: { handle: "f7", page: 1 },
		handle: "f7",
		args: page2,
		answer: SALARY
	},
	{
		id: "document-slide-zh",
		lang: "zh",
		prompt: "第5张幻灯片讲了什么？",
		open: { handle: "f46", slide: 1 },
		handle: "f46",
		args: slide5,
		answer: SLIDE_5
	},
	{
		id: "document-page-ja",
		lang: "ja",
		prompt: "2ページ目には何が書いてある？",
		open: { handle: "f7", page: 1 },
		handle: "f7",
		args: page2,
		answer: SALARY
	},
	{
		id: "document-sheet-ja",
		lang: "ja",
		prompt: "Gastos シートには何がある？",
		open: { handle: "f30", sheet: "Resumen" },
		handle: "f30",
		args: gastos,
		answer: GASTOS
	}
]

const CHURN = ["2.1", "2,1", "٢٫١"]
const LISBON = ["lisbon", "lissabon", "lisboa", "lisbonne", "里斯本", "リスボン", "لشبونة", "लिस्बन", "лиссабон", "lizbon"]
const HEADCOUNT = ["48", "٤٨"]
const REPORT = { handle: "f33", page: 1 }

// Facts from the long report's late pages, which only a chunked read reaches.
const LATE_FACTS: readonly DocumentScenario[] = [
	{
		id: "document-late-churn-en",
		lang: "en",
		prompt: "What does this report say about customer churn?",
		open: REPORT,
		handle: "f33",
		answer: CHURN
	},
	{
		id: "document-late-office-de",
		lang: "de",
		prompt: "Wo eröffnet die Firma laut diesem Bericht ein zweites Büro?",
		open: REPORT,
		handle: "f33",
		answer: LISBON
	},
	{
		id: "document-late-headcount-fr",
		lang: "fr",
		prompt: "Combien de personnes l'entreprise compte-t-elle à la fin du trimestre, d'après ce rapport ?",
		open: REPORT,
		handle: "f33",
		answer: HEADCOUNT
	},
	{
		id: "document-late-churn-es",
		lang: "es",
		prompt: "¿Qué dice este informe sobre la tasa de abandono de clientes?",
		open: REPORT,
		handle: "f33",
		answer: CHURN
	},
	{
		id: "document-late-office-ja",
		lang: "ja",
		prompt: "このレポートによると、2つ目のオフィスはどこに開設されますか？",
		open: REPORT,
		handle: "f33",
		answer: LISBON
	},
	{
		id: "document-late-headcount-zh",
		lang: "zh",
		prompt: "根据这份报告，季度末公司有多少员工？",
		open: REPORT,
		handle: "f33",
		answer: HEADCOUNT
	},
	{
		id: "document-late-churn-ar",
		lang: "ar",
		prompt: "ماذا يقول هذا التقرير عن معدل فقدان العملاء؟",
		open: REPORT,
		handle: "f33",
		answer: CHURN
	},
	{
		id: "document-late-office-hi",
		lang: "hi",
		prompt: "इस रिपोर्ट के अनुसार दूसरा दफ़्तर कहाँ खुलेगा?",
		open: REPORT,
		handle: "f33",
		answer: LISBON
	},
	{
		id: "document-late-headcount-ru",
		lang: "ru",
		prompt: "Сколько сотрудников в компании на конец квартала по этому отчёту?",
		open: REPORT,
		handle: "f33",
		answer: HEADCOUNT
	},
	{
		id: "document-late-churn-pt",
		lang: "pt",
		prompt: "O que este relatório diz sobre a taxa de cancelamento de clientes?",
		open: REPORT,
		handle: "f33",
		answer: CHURN
	},
	{
		id: "document-late-office-tr",
		lang: "tr",
		prompt: "Bu rapora göre ikinci ofis nerede açılacak?",
		open: REPORT,
		handle: "f33",
		answer: LISBON
	},
	{
		id: "document-late-headcount-id",
		lang: "id",
		prompt: "Menurut laporan ini, berapa jumlah karyawan di akhir kuartal?",
		open: REPORT,
		handle: "f33",
		answer: HEADCOUNT
	}
]

// A closed document found by name, then read.
const BY_NAME: readonly DocumentScenario[] = [
	{
		id: "document-by-name-en",
		lang: "en",
		prompt: "How many vacation days does Arbeitsvertrag_Filen.pdf give me?",
		handle: "f7",
		answer: VACATION
	},
	{ id: "document-by-name-de", lang: "de", prompt: "Wie hoch ist das Gehalt in Arbeitsvertrag_Filen.pdf?", handle: "f7", answer: SALARY },
	{ id: "document-by-name-es", lang: "es", prompt: "¿Cuánto queda del presupuesto en presupuesto.xlsx?", handle: "f30", answer: LEFT },
	{
		id: "document-by-name-fr",
		lang: "fr",
		prompt: "Quelles langues sont indiquées dans CV_2025.docx ?",
		handle: "f8",
		answer: ["spanish", "espagnol", "b2"]
	},
	{
		id: "document-by-name-pt",
		lang: "pt",
		prompt: "Quando é a visita ao hotel segundo Presentacion_kickoff.pptx?",
		handle: "f46",
		answer: ["20"]
	},
	{
		id: "document-by-name-ru",
		lang: "ru",
		prompt: "Какой срок уведомления об увольнении в Arbeitsvertrag_Filen.pdf?",
		handle: "f7",
		answer: ["3", "три", "drei"]
	},
	{ id: "document-by-name-tr", lang: "tr", prompt: "presupuesto.xlsx dosyasında bütçeden ne kadar kaldı?", handle: "f30", answer: LEFT },
	{ id: "document-by-name-ar", lang: "ar", prompt: "ما الراتب المذكور في Arbeitsvertrag_Filen.pdf؟", handle: "f7", answer: SALARY },
	{
		id: "document-by-name-hi",
		lang: "hi",
		prompt: "CV_2025.docx में कौन सी भाषाएँ लिखी हैं?",
		handle: "f8",
		answer: ["spanish", "स्पेनिश", "b2"]
	},
	{ id: "document-by-name-id", lang: "id", prompt: "Berapa sisa anggaran di presupuesto.xlsx?", handle: "f30", answer: LEFT },
	{
		id: "document-by-name-zh",
		lang: "zh",
		prompt: "Presentacion_kickoff.pptx 里预算是多少？",
		handle: "f46",
		answer: ["18.500", "18500", "18,500"]
	},
	{ id: "document-by-name-ja", lang: "ja", prompt: "Arbeitsvertrag_Filen.pdf の有給休暇は何日？", handle: "f7", answer: VACATION }
]

// "Read it" with nothing open or selected: the assistant asks which document.
const NOTHING_OPEN: readonly (readonly [Language, string])[] = [
	["en", "Read it to me"],
	["de", "Fass das Dokument zusammen"],
	["es", "Resume este documento"],
	["ja", "このドキュメントを要約して"],
	["ar", "لخّص هذا المستند"],
	["ru", "Перескажи этот документ"]
]

export const DOCUMENT_CASES: EvalCase[] = [
	...SUMMARIZE_OPEN.map(scenario => documentCase("simple", scenario, { forbidden: ["search_items"] })),
	...RANGES.map(scenario => documentCase("simple", scenario, { forbidden: ["search_items"] })),
	...LATE_FACTS.map(scenario => documentCase("sources", scenario)),
	...BY_NAME.map(scenario => documentCase("multi_step", scenario)),
	...NOTHING_OPEN.map(([lang, prompt]) => ({
		id: `document-missing-${lang}`,
		category: "missing_param" as const,
		lang,
		prompt,
		context: { screen: "drive", directory: "d0" },
		routes: ["files", "answer"] as const,
		forbidden: ["read_document" as const],
		expectsText: true
	}))
]
