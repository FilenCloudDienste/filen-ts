import type { EvalCase, ExpectedCall, Language } from "./types"

type ReadCase = {
	lang: Language
	prompt: string
	routes: EvalCase["routes"]
	call: ExpectedCall
	answer: string[][]
}

function read(tool: ExpectedCall["tool"], handle: string): ExpectedCall {
	return {
		tool,
		args: {
			handle
		}
	}
}

// Read something, then answer from it in the user's language; the source text is often in another one.
const READS: ReadCase[] = [
	{
		lang: "en",
		prompt: "When is the website launch according to roadmap.md?",
		routes: ["files"],
		call: read("read_text_file", "f27"),
		answer: [["15"]]
	},
	{
		lang: "de",
		prompt: "Was steht auf meiner Einkaufsliste?",
		routes: ["notes"],
		call: read("read_note", "n2"),
		answer: [["milch"], ["kase"]]
	},
	{
		lang: "es",
		prompt: "¿Qué tengo que hacer el primer día según itinerario.txt?",
		routes: ["files"],
		call: read("read_text_file", "f31"),
		answer: [["sagrada"]]
	},
	{
		lang: "fr",
		prompt: "Quelles sont mes idées de cadeaux pour Noël ?",
		routes: ["notes"],
		call: read("read_note", "n5"),
		answer: [["echarpe"], ["livre"]]
	},
	{
		lang: "pt",
		prompt: "Resume pra mim o arquivo redação_enem.txt",
		routes: ["files"],
		call: read("read_text_file", "f39"),
		answer: [["mobilidade", "transporte"]]
	},
	{
		lang: "ru",
		prompt: "Что у меня записано в заметке «Важное»?",
		routes: ["notes"],
		call: read("read_note", "n6"),
		answer: [["паспорт"]]
	},
	{
		lang: "tr",
		prompt: "Mercimek çorbası tarifime göre çorba kaç dakika pişiyor?",
		routes: ["files"],
		call: read("read_text_file", "f40"),
		answer: [["25"]]
	},
	{
		lang: "ar",
		prompt: "متى موعد السفر حسب ملاحظة خطة السفر؟",
		routes: ["notes"],
		call: read("read_note", "n13"),
		answer: [["20", "٢٠"]]
	},
	{
		lang: "hi",
		prompt: "मेरे यात्रा योजना वाले नोट में क्या लिखा है?",
		routes: ["notes"],
		call: read("read_note", "n14"),
		answer: [["जयपुर"]]
	},
	{
		lang: "id",
		prompt: "Apa isi catatan rapat saya?",
		routes: ["notes"],
		call: read("read_note", "n11"),
		answer: [["desember"]]
	},
	{
		lang: "zh",
		prompt: "我的读书笔记里写了什么？",
		routes: ["notes"],
		call: read("read_note", "n8"),
		answer: [["三体"]]
	},
	{
		lang: "ja",
		prompt: "会議メモの内容を教えて",
		routes: ["notes"],
		call: read("read_note", "n9"),
		answer: [["金曜"]]
	},
	{
		lang: "en",
		prompt: "What did Anna write to me last?",
		routes: ["chats"],
		call: read("read_chat", "c1"),
		answer: [["friday", "freitag", "10"]]
	},
	{
		lang: "de",
		prompt: "Wie viele Dateien liegen im Ordner Invoices?",
		routes: ["files"],
		call: {
			tool: "list_directory"
		},
		answer: [["5", "funf"]]
	},
	{
		lang: "es",
		prompt: "¿Qué me escribió Carlos?",
		routes: ["chats"],
		call: read("read_chat", "c3"),
		answer: [["presupuesto", "barcelona"]]
	},
	{
		lang: "fr",
		prompt: "De quoi parle le fichier meeting_notes_2025-09-30.txt ?",
		routes: ["files"],
		call: read("read_text_file", "f28"),
		answer: [["cookie", "15"]]
	},
	{
		lang: "pt",
		prompt: "Qual foi a última mensagem do João?",
		routes: ["chats"],
		call: read("read_chat", "c13"),
		answer: [["historia"]]
	},
	{
		lang: "ru",
		prompt: "Какие треки в плейлисте Workout?",
		routes: ["audio"],
		call: read("open_playlist", "p1"),
		answer: [["despacito"]]
	},
	{
		lang: "tr",
		prompt: "Ahmet bana ne yazdı?",
		routes: ["chats"],
		call: read("read_chat", "c7"),
		answer: [["14"]]
	},
	{
		lang: "ar",
		prompt: "ما آخر رسالة من فاطمة؟",
		routes: ["chats"],
		call: read("read_chat", "c10"),
		answer: [["فاتورة", "الكهرباء"]]
	},
	{
		lang: "hi",
		prompt: "Priya ने मुझे क्या लिखा?",
		routes: ["chats"],
		call: read("read_chat", "c8"),
		answer: [["रसीद", "किराए", "किराया"]]
	},
	{
		lang: "id",
		prompt: "Berapa lama waktu memasak menurut catatan resep tortilla?",
		routes: ["notes"],
		call: read("read_note", "n4"),
		answer: [["35"]]
	},
	{
		lang: "zh",
		prompt: "李伟给我发了什么消息？",
		routes: ["chats"],
		call: read("read_chat", "c11"),
		answer: [["三点", "3"]]
	},
	{
		lang: "ja",
		prompt: "tax_notes_2024.txt によると、申告の締め切りはいつ？",
		routes: ["files"],
		call: read("read_text_file", "f9"),
		answer: [["31"]]
	},
	{
		lang: "en",
		prompt: "How big is the video Weihnachten_2024.mp4?",
		routes: ["files"],
		call: read("get_item_info", "f15"),
		answer: [["184", "192", "193"]]
	}
]

export const LANGUAGE_CASES: EvalCase[] = READS.map(({ lang, prompt, routes, call, answer }, index) => ({
	id: `language-${index + 1}-${lang}`,
	category: "language",
	lang,
	prompt,
	routes,
	calls: [call],
	answerIncludes: answer,
	expectsText: true
}))
