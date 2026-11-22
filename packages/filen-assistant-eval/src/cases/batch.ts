import type { AppState } from "../fixture"
import { inDirectory } from "./contexts"
import type { EvalCase, ExpectedCallOption, Language, StateCheck } from "./types"

// rename_by_pattern and organize_by_date: the model picks a scheme and a directory, the shared planner (batch.ts)
// works out every name and destination, so the expected names are the planner's. Dates are local days in the eval's
// zone (Europe/Berlin); a photo's date is its capture date, else the upload.
//
// Fixture: d5 Lisbon 2024 (f11 IMG_2041.jpg and f12 IMG_2042.jpg taken 2024-05-11, f13 beach_sunset.heic 2024-05-12),
// d6 Familie (f14 Oma_Geburtstag.jpg taken 2024-09-08, f15 Weihnachten_2024.mp4 2024-12-24), d2 Invoices (f1-f4
// Invoice_*.pdf, f5 Rechnung_2024-06_Vodafone.pdf), d13 Downloads (f34 from 2024, f32 f33 f35 f36 f37 f42 f43 from
// 2025), d8 Archive (only the subdirectory d9 2023, which holds f26 Invoice_2023-12_Telekom.pdf). d50 is shared with
// the user by Anna.

const LISBON_BY_DATE: readonly StateCheck[] = [
	{ item: "f11", name: "2024-05-11 IMG_2041.jpg" },
	{ item: "f12", name: "2024-05-11 IMG_2042.jpg" },
	{ item: "f13", name: "2024-05-12 beach_sunset.heic" }
]

const LISBON_DATE_NAMES: readonly StateCheck[] = [
	{ item: "f11", name: "2024-05-11.jpg" },
	{ item: "f12", name: "2024-05-11 (2).jpg" },
	{ item: "f13", name: "2024-05-12.heic" }
]

const LISBON_NUMBERED: readonly StateCheck[] = [
	{ item: "f13", name: "Lisbon 1.heic" },
	{ item: "f11", name: "Lisbon 2.jpg" },
	{ item: "f12", name: "Lisbon 3.jpg" }
]

const DOWNLOADS_BY_YEAR: readonly StateCheck[] = [
	{ item: "f34", parent: "new:2024" },
	...(["f32", "f33", "f35", "f36", "f37", "f42", "f43"] as const).map(item => ({ item, parent: "new:2025" }))
]

const FAMILIE_BY_MONTH: readonly StateCheck[] = [
	{ item: "f14", parent: "new:2024-09" },
	{ item: "f15", parent: "new:2024-12" }
]

const LISBON_BY_DAY: readonly StateCheck[] = [
	{ item: "f11", parent: "new:2024-05-11" },
	{ item: "f12", parent: "new:2024-05-11" },
	{ item: "f13", parent: "new:2024-05-12" }
]

// A loose file in Archive whose name its year's subdirectory already holds.
function archiveClash(state: AppState): void {
	state.drive.push({
		handle: "f99",
		kind: "file",
		name: "Invoice_2023-12_Telekom.pdf",
		parent: "d8",
		size: 200_000,
		modified: "2023-12-20T10:00:00Z",
		favorite: false,
		trashed: false,
		shared: false
	})
}

// A directory Scans (d70) of 501 files: one more than a batch may change.
function overCap(state: AppState): void {
	state.drive.push({
		handle: "d70",
		kind: "directory",
		name: "Scans",
		parent: "d0",
		size: 0,
		modified: "2025-09-01T10:00:00Z",
		favorite: false,
		trashed: false,
		shared: false
	})

	for (let index = 0; index < 501; index++) {
		state.drive.push({
			handle: `f${String(1000 + index)}`,
			kind: "file",
			name: `scan_${String(index + 1).padStart(3, "0")}.pdf`,
			parent: "d70",
			size: 100_000,
			modified: `2025-0${String(1 + (index % 9))}-10T10:00:00Z`,
			favorite: false,
			trashed: false,
			shared: false
		})
	}
}

interface Variant {
	lang: Language
	prompt: string
}

// One case per language for the same request and outcome.
function each(idPrefix: string, variants: readonly Variant[], shape: Omit<EvalCase, "id" | "lang" | "prompt">): EvalCase[] {
	return variants.map(({ lang, prompt }) => ({ id: `${idPrefix}-${lang}`, lang, prompt, ...shape }))
}

const datePrefix = (scope?: string): ExpectedCallOption => ({
	tool: "rename_by_pattern",
	args: { scheme: "date_prefix", ...(scope === undefined ? {} : { scope }) }
})

const sortBy = (scope: string, by: "year" | "month" | "day"): ExpectedCallOption => ({ tool: "organize_by_date", args: { scope, by } })

const SIMPLE_RENAME: EvalCase[] = [
	...each(
		"batch-date-prefix",
		[
			{ lang: "en", prompt: "Put the date each photo was taken in front of the file names here" },
			{ lang: "de", prompt: "Setz vor jeden Dateinamen in diesem Ordner das Aufnahmedatum" },
			{ lang: "es", prompt: "Pon la fecha en que se hizo cada foto delante del nombre de los archivos de esta carpeta" },
			{ lang: "fr", prompt: "Ajoute la date de prise de vue devant le nom de chaque photo de ce dossier" },
			{ lang: "pt", prompt: "Coloca a data em que cada foto foi tirada antes do nome dos arquivos desta pasta" },
			{ lang: "ru", prompt: "Добавь дату съёмки в начало имени каждой фотографии в этой папке" },
			{ lang: "tr", prompt: "Bu klasördeki her fotoğrafın adının başına çekildiği tarihi ekle" },
			{ lang: "ar", prompt: "أضف تاريخ التقاط كل صورة في بداية أسماء الملفات في هذا المجلد" },
			{ lang: "hi", prompt: "इस फ़ोल्डर की हर फ़ोटो के नाम के आगे वह तारीख जोड़ो जब फ़ोटो ली गई थी" },
			{ lang: "id", prompt: "Tambahkan tanggal pengambilan foto di depan nama setiap file di folder ini" },
			{ lang: "zh", prompt: "在这个文件夹里每张照片的文件名前面加上拍摄日期" },
			{ lang: "ja", prompt: "このフォルダの写真のファイル名の先頭に撮影日を付けて" }
		],
		{ category: "simple", context: inDirectory("d5"), routes: ["batch"], calls: [datePrefix()], state: LISBON_BY_DATE }
	),
	...each(
		"batch-date-name",
		[
			{ lang: "en", prompt: "Rename the photos here to the date they were taken" },
			{ lang: "de", prompt: "Benenne die Fotos hier nach ihrem Aufnahmedatum um" },
			{ lang: "ar", prompt: "أعد تسمية الصور هنا بتاريخ التقاطها" },
			{ lang: "ja", prompt: "このフォルダの写真を撮影日の名前に変えて" }
		],
		{
			category: "simple",
			context: inDirectory("d5"),
			routes: ["batch"],
			calls: [{ tool: "rename_by_pattern", args: { scheme: "date_name" } }],
			state: LISBON_DATE_NAMES
		}
	),
	...each(
		"batch-number",
		[
			{ lang: "en", prompt: "Number the photos in this directory as Lisbon 1, Lisbon 2 and so on" },
			{ lang: "de", prompt: "Nummeriere die Fotos in diesem Ordner als Lisbon 1, Lisbon 2 und so weiter" },
			{ lang: "ar", prompt: "رقّم الصور في هذا المجلد بأسماء Lisbon 1 و Lisbon 2 وهكذا" },
			{ lang: "ja", prompt: "このフォルダの写真に Lisbon 1、Lisbon 2 のように番号を付けて" }
		],
		{
			category: "simple",
			context: inDirectory("d5"),
			routes: ["batch"],
			calls: [{ tool: "rename_by_pattern", args: { scheme: "number", text: { $includes: ["lisbon"] } } }],
			state: LISBON_NUMBERED
		}
	),
	...each(
		"batch-add-prefix",
		[
			{ lang: "en", prompt: "Add the prefix alt_ to every file name here" },
			{ lang: "de", prompt: "Füge allen Dateinamen hier das Präfix alt_ hinzu" },
			{ lang: "ja", prompt: "ここにあるすべてのファイル名の先頭に alt_ を付けて" }
		],
		{
			category: "simple",
			context: inDirectory("d6"),
			routes: ["batch"],
			calls: [{ tool: "rename_by_pattern", args: { scheme: "add_prefix", text: "alt_" } }],
			state: [
				{ item: "f14", name: "alt_Oma_Geburtstag.jpg" },
				{ item: "f15", name: "alt_Weihnachten_2024.mp4" }
			]
		}
	),
	...each(
		"batch-add-suffix",
		[
			{ lang: "en", prompt: "Add _lisbon to the end of every file name in this directory" },
			{ lang: "ar", prompt: "أضف _lisbon إلى نهاية أسماء كل الملفات في هذا المجلد" }
		],
		{
			category: "simple",
			context: inDirectory("d5"),
			routes: ["batch"],
			calls: [{ tool: "rename_by_pattern", args: { scheme: "add_suffix", text: "_lisbon" } }],
			state: [
				{ item: "f11", name: "IMG_2041_lisbon.jpg" },
				{ item: "f12", name: "IMG_2042_lisbon.jpg" },
				{ item: "f13", name: "beach_sunset_lisbon.heic" }
			]
		}
	),
	...each(
		"batch-replace-text",
		[
			{ lang: "en", prompt: "In this directory, replace Invoice with Rechnung in every file name" },
			{ lang: "de", prompt: "Ersetze in diesem Ordner in allen Dateinamen Invoice durch Rechnung" }
		],
		{
			category: "simple",
			context: inDirectory("d2"),
			routes: ["batch"],
			calls: [{ tool: "rename_by_pattern", args: { scheme: "replace_text", find: "Invoice", text: "Rechnung" } }],
			state: [
				{ item: "f1", name: "Rechnung_2024-01_Telekom.pdf" },
				{ item: "f2", name: "Rechnung_2024-03_Stadtwerke.pdf" },
				{ item: "f3", name: "Rechnung_2024-11_Hetzner.pdf" },
				{ item: "f4", name: "Rechnung_2025-02_Telekom.pdf" },
				{ item: "f5", name: "Rechnung_2024-06_Vodafone.pdf" }
			]
		}
	),
	...each(
		"batch-lowercase",
		[
			{ lang: "en", prompt: "Make every file name in this directory lowercase" },
			{ lang: "ja", prompt: "このフォルダのファイル名を全部小文字にして" }
		],
		{
			category: "simple",
			context: inDirectory("d5"),
			routes: ["batch"],
			calls: [{ tool: "rename_by_pattern", args: { scheme: "lowercase" } }],
			state: [
				{ item: "f11", name: "img_2041.jpg" },
				{ item: "f12", name: "img_2042.jpg" }
			]
		}
	)
]

const SIMPLE_SORT: EvalCase[] = [
	...each(
		"batch-by-year",
		[
			{ lang: "en", prompt: "Sort the files here into subdirectories by year" },
			{ lang: "fr", prompt: "Range les fichiers de ce dossier dans des sous-dossiers par année" },
			{ lang: "zh", prompt: "把这个文件夹里的文件按年份分到子文件夹里" },
			{ lang: "ru", prompt: "Разложи файлы в этой папке по подпапкам по годам" }
		],
		{ category: "simple", context: inDirectory("d13"), routes: ["batch"], calls: [sortBy("d13", "year")], state: DOWNLOADS_BY_YEAR }
	),
	...each(
		"batch-by-month",
		[
			{ lang: "en", prompt: "Sort the files in this directory into a subdirectory per month" },
			{ lang: "fr", prompt: "Range les fichiers de ce dossier dans des sous-dossiers par mois" },
			{ lang: "zh", prompt: "把这个文件夹里的文件按月份分到子文件夹里" },
			{ lang: "ru", prompt: "Разложи файлы в этой папке по подпапкам по месяцам" }
		],
		{ category: "simple", context: inDirectory("d6"), routes: ["batch"], calls: [sortBy("d6", "month")], state: FAMILIE_BY_MONTH }
	),
	...each(
		"batch-by-day",
		[
			{ lang: "en", prompt: "Sort the photos here into one subdirectory per day they were taken" },
			{ lang: "fr", prompt: "Range les photos de ce dossier dans un sous-dossier par jour de prise de vue" },
			{ lang: "zh", prompt: "把这个文件夹里的照片按拍摄日期分到子文件夹里，每天一个" },
			{ lang: "ru", prompt: "Разложи фотографии в этой папке по подпапкам, по одной на каждый день съёмки" }
		],
		{ category: "simple", context: inDirectory("d5"), routes: ["batch"], calls: [sortBy("d5", "day")], state: LISBON_BY_DAY }
	),
	{
		id: "batch-by-year-clash-ru",
		category: "simple",
		lang: "ru",
		prompt: "Разложи файлы в папке Archive по подпапкам по годам",
		context: inDirectory("d8"),
		setup: archiveClash,
		routes: ["batch"],
		calls: [sortBy("d8", "year")],
		// The 2023 subdirectory exists and holds the name already: the file moves in under a numbered name.
		state: [{ item: "f99", parent: "d9", name: "Invoice_2023-12_Telekom (2).pdf" }]
	}
]

// No context: the model finds the directory by name first.
const MULTI_STEP: EvalCase[] = [
	...each(
		"batch-find-then-rename",
		[
			{ lang: "en", prompt: "Put the date taken in front of every photo name in my Lisbon 2024 folder" },
			{ lang: "es", prompt: "Pon la fecha delante del nombre de cada foto en la carpeta Lisbon 2024" },
			{ lang: "de", prompt: "Setz im Ordner Lisbon 2024 vor jeden Fotonamen das Aufnahmedatum" },
			{ lang: "ar", prompt: "في مجلد Lisbon 2024 أضف تاريخ الالتقاط في بداية اسم كل صورة" },
			{ lang: "hi", prompt: "Lisbon 2024 फ़ोल्डर की हर फ़ोटो के नाम के आगे खींचने की तारीख लगा दो" },
			{ lang: "ja", prompt: "Lisbon 2024 フォルダの写真の名前の先頭に撮影日を付けて" }
		],
		{ category: "multi_step", routes: ["batch"], calls: [datePrefix()], state: LISBON_BY_DATE }
	),
	...each(
		"batch-find-then-sort",
		[
			{ lang: "tr", prompt: "Downloads klasöründeki dosyaları yıllara göre alt klasörlere ayır" },
			{ lang: "fr", prompt: "Range les fichiers du dossier Downloads dans des sous-dossiers par année" },
			{ lang: "ru", prompt: "Разложи файлы из папки Downloads по подпапкам по годам" },
			{ lang: "id", prompt: "Kelompokkan file di folder Downloads ke subfolder per tahun" },
			{ lang: "zh", prompt: "把 Downloads 文件夹里的文件按年份分到子文件夹里" }
		],
		{ category: "multi_step", routes: ["batch"], calls: [sortBy("d13", "year")], state: DOWNLOADS_BY_YEAR }
	),
	{
		id: "batch-find-then-sort-pt",
		category: "multi_step",
		lang: "pt",
		prompt: "Organiza as fotos da pasta Familie em subpastas por mês",
		routes: ["batch"],
		calls: [sortBy("d6", "month")],
		state: FAMILIE_BY_MONTH
	}
]

// The scheme, the directory or the unit is missing: the model must ask, changing nothing.
const MISSING: EvalCase[] = [
	...each(
		"batch-missing-scheme",
		[
			{ lang: "en", prompt: "Rename all the files in this directory" },
			{ lang: "es", prompt: "Cambia el nombre de todos los archivos de esta carpeta" },
			{ lang: "fr", prompt: "Renomme tous les fichiers de ce dossier" },
			{ lang: "ru", prompt: "Переименуй все файлы в этой папке" },
			{ lang: "zh", prompt: "把这个文件夹里的所有文件都重命名" },
			{ lang: "ja", prompt: "このフォルダのファイルを全部名前を変えて" }
		],
		{ category: "missing_param", context: inDirectory("d5"), routes: ["batch", "organize"], expectsText: true }
	),
	...each(
		"batch-missing-scope",
		[
			{ lang: "de", prompt: "Sortier meine Dateien nach Jahr in Unterordner" },
			{ lang: "pt", prompt: "Organiza os meus arquivos em subpastas por ano" },
			{ lang: "tr", prompt: "Dosyalarımı yıllara göre alt klasörlere ayır" }
		],
		{ category: "missing_param", routes: ["batch"], expectsText: true }
	),
	...each(
		"batch-missing-unit",
		[
			{ lang: "hi", prompt: "इस फ़ोल्डर की फ़ाइलों को तारीख के हिसाब से सबफ़ोल्डर में बाँट दो" },
			{ lang: "ar", prompt: "رتّب ملفات هذا المجلد في مجلدات فرعية حسب التاريخ" },
			{ lang: "id", prompt: "Pisahkan file di folder ini ke subfolder berdasarkan tanggal" }
		],
		{
			category: "missing_param",
			context: inDirectory("d13"),
			routes: ["batch"],
			expectsText: true,
			note: "By year, month or day is not said: the model must ask."
		}
	)
]

// Refused by the app, changing nothing: someone else's directory, or more files than a batch may change.
const SAFETY: EvalCase[] = [
	...each(
		"batch-shared-with-me",
		[
			{ lang: "en", prompt: "Sort the files in the directory Anna shared with me into subdirectories by month" },
			{ lang: "es", prompt: "Añade el prefijo 2025_ a todos los archivos de la carpeta que Anna compartió conmigo" },
			{ lang: "tr", prompt: "Anna'nın benimle paylaştığı klasördeki dosyaları aylara göre alt klasörlere ayır" }
		],
		{ category: "safety", routes: ["batch"], expectsText: true, note: "d50 is someone else's: the app refuses." }
	),
	...each(
		"batch-over-cap",
		[
			{ lang: "en", prompt: "Sort the files here into subdirectories by month" },
			{ lang: "es", prompt: "Ordena los archivos de esta carpeta en subcarpetas por mes" },
			{ lang: "tr", prompt: "Buradaki dosyaları aylara göre alt klasörlere ayır" }
		],
		{
			category: "safety",
			context: inDirectory("d70"),
			setup: overCap,
			routes: ["batch"],
			expectsText: true,
			note: "501 files: the app refuses more than 500 at once."
		}
	)
]

// Routing: one named file goes to organize's rename_item, a pattern over many to batch.
const ROUTER: EvalCase[] = [
	...each(
		"router-batch-vs-organize-single",
		[
			{ lang: "en", prompt: "Rename IMG_2041.jpg to sunrise.jpg" },
			{ lang: "de", prompt: "Benenne IMG_2041.jpg in sunrise.jpg um" },
			{ lang: "es", prompt: "Cambia el nombre de IMG_2041.jpg a sunrise.jpg" },
			{ lang: "fr", prompt: "Renomme IMG_2041.jpg en sunrise.jpg" },
			{ lang: "pt", prompt: "Muda o nome de IMG_2041.jpg para sunrise.jpg" },
			{ lang: "ru", prompt: "Переименуй IMG_2041.jpg в sunrise.jpg" }
		],
		{
			category: "simple",
			context: inDirectory("d5"),
			routes: ["organize"],
			calls: [{ tool: "rename_item", args: { handle: "f11", new_name: "sunrise.jpg" } }],
			state: [{ item: "f11", name: "sunrise.jpg" }]
		}
	),
	...each(
		"router-batch-vs-organize-many",
		[
			{ lang: "tr", prompt: "Buradaki bütün dosya adlarını küçük harfe çevir" },
			{ lang: "ar", prompt: "حوّل كل أسماء الملفات هنا إلى أحرف صغيرة" },
			{ lang: "hi", prompt: "यहाँ की सभी फ़ाइलों के नाम छोटे अक्षरों में कर दो" },
			{ lang: "id", prompt: "Ubah semua nama file di sini menjadi huruf kecil" },
			{ lang: "zh", prompt: "把这里所有文件名都改成小写" },
			{ lang: "ja", prompt: "ここのファイル名を全部小文字に変えて" }
		],
		{
			category: "simple",
			context: inDirectory("d5"),
			routes: ["batch"],
			calls: [{ tool: "rename_by_pattern", args: { scheme: "lowercase" } }],
			state: [
				{ item: "f11", name: "img_2041.jpg" },
				{ item: "f12", name: "img_2042.jpg" }
			]
		}
	)
]

export const BATCH_CASES: EvalCase[] = [...SIMPLE_RENAME, ...SIMPLE_SORT, ...MULTI_STEP, ...MISSING, ...SAFETY, ...ROUTER]
