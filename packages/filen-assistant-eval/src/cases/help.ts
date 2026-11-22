import { APP_HELP, type AppHelpId } from "@filen/shared/assistant"
import type { EvalCase, Language } from "./types"

// app_help: how to do something in the app or what a setting does, answered from the settings registry (the fake
// app's English sample, fixture.ts HELP_ROWS), never from the model's own idea of the app.

type HelpAsk = readonly [lang: Language, prompt: string]

// Three asks per language; the reply names what the setting is called or where it is.
const ASKS: readonly HelpAsk[] = [
	["en", "How do I turn on two-factor authentication?"],
	["en", "Where can I change my password?"],
	["en", "What does the Keep conversations setting do?"],
	["de", "Wie aktiviere ich die Zwei-Faktor-Authentifizierung?"],
	["de", "Wo kann ich die Sprache der App ändern?"],
	["de", "Was macht die Einstellung für Dateiversionierung?"],
	["es", "¿Cómo cambio el tema de la aplicación a oscuro?"],
	["es", "¿Dónde puedo exportar mis datos?"],
	["es", "¿Qué hace la opción de alertas de inicio de sesión?"],
	["fr", "Comment changer mon mot de passe ?"],
	["fr", "Où est le réglage de l'écran de démarrage ?"],
	["fr", "À quoi sert l'option « Appear offline » ?"],
	["pt", "Como ativo a autenticação de dois fatores?"],
	["pt", "Onde vejo as minhas faturas?"],
	["pt", "Como faço backup das minhas master keys?"],
	["ru", "Как включить двухфакторную аутентификацию?"],
	["ru", "Где поменять язык приложения?"],
	["ru", "Как сменить пароль?"],
	["tr", "İki faktörlü kimlik doğrulamayı nasıl açarım?"],
	["tr", "Uygulamanın temasını nerede değiştirebilirim?"],
	["tr", "Fotoğraflar HEIC yerine JPG olarak nasıl yüklenir?"],
	["ar", "كيف أفعّل المصادقة الثنائية؟"],
	["ar", "أين أغيّر كلمة المرور؟"],
	["ar", "أين أجد اختصارات لوحة المفاتيح؟"],
	["hi", "मैं two-factor authentication कैसे चालू करूँ?"],
	["hi", "ऐप की भाषा कहाँ बदलूँ?"],
	["hi", "मेरे invoices कहाँ दिखते हैं?"],
	["id", "Bagaimana cara mengaktifkan autentikasi dua faktor?"],
	["id", "Di mana saya bisa mengganti kata sandi?"],
	["id", "Apa fungsi pengaturan spell check di dokumen?"],
	["zh", "怎么开启双重身份验证？"],
	["zh", "在哪里修改密码？"],
	["zh", "怎么更改应用的语言？"],
	["ja", "二要素認証を有効にするにはどうすればいいですか？"],
	["ja", "パスワードはどこで変更できますか？"],
	["ja", "キーボードショートカットはどこで変えられますか？"]
]

// English replies name the setting by the words the result showed.
const EN_ANSWERS: Readonly<Record<string, readonly string[]>> = {
	"How do I turn on two-factor authentication?": ["two-factor", "security"],
	"Where can I change my password?": ["password", "security"],
	"What does the Keep conversations setting do?": ["conversation", "saved"]
}

const SIMPLE: EvalCase[] = ASKS.map(([lang, prompt], index) => ({
	id: `help-ask-${String(index + 1)}-${lang}`,
	category: "simple",
	lang,
	prompt,
	routes: ["help"],
	calls: [{ tool: "app_help" }],
	...(EN_ANSWERS[prompt] === undefined ? {} : { answerIncludes: [EN_ANSWERS[prompt]] }),
	expectsText: true
}))

function routeOf(id: AppHelpId): string {
	const entry = APP_HELP.find(candidate => candidate.id === id)

	if (entry === undefined) {
		throw new Error(`no app_help row ${id}`)
	}

	return entry.route
}

// Asked to be taken to a setting: looked up, then opened by its handle, which rings it on its page.
const OPENS: readonly (readonly [Language, string, AppHelpId])[] = [
	["en", "Take me to the setting for two-factor authentication.", "twoFactor"],
	["de", "Bring mich zur Einstellung für die Sprache der App.", "language"],
	["es", "Llévame a la opción para cambiar mi contraseña.", "password"],
	["fr", "Ouvre le réglage du thème.", "theme"],
	["pt", "Abre a configuração de alertas de login.", "loginAlerts"],
	["ru", "Открой настройку двухфакторной аутентификации.", "twoFactor"],
	["tr", "Beni dosya sürümleme ayarına götür.", "versioning"],
	["ar", "افتح إعداد المصادقة الثنائية.", "twoFactor"],
	["hi", "मुझे theme वाली setting पर ले चलो।", "theme"],
	["id", "Buka pengaturan untuk mengekspor data saya.", "dataExport"],
	["zh", "打开修改密码的设置。", "password"],
	["ja", "アプリの言語の設定を開いて。", "language"]
]

const MULTI_STEP: EvalCase[] = OPENS.map(([lang, prompt, id], index) => ({
	id: `help-open-${String(index + 1)}-${lang}`,
	category: "multi_step",
	lang,
	prompt,
	routes: ["help"],
	calls: [{ tool: "app_help" }, { tool: "open_route", args: { help: { $any: true } } }],
	state: [{ screen: routeOf(id), opened: `help:${id}` }]
}))

// How-to questions about other software or the world: answered from general knowledge, never through app_help.
const GENERAL: readonly HelpAsk[] = [
	["en", "How do I make a pivot table in Excel?"],
	["de", "Wie setze ich meinen WLAN-Router zurück?"],
	["es", "¿Cómo activo la autenticación de dos factores en mi cuenta de Google?"],
	["fr", "Comment changer la langue de Windows ?"],
	["pt", "Como faço um backup do meu iPhone no computador?"],
	["ru", "Как поменять тему в Telegram?"],
	["tr", "Excel'de bir sütunu nasıl dondururum?"],
	["ar", "كيف أغير كلمة مرور شبكة الواي فاي؟"],
	["hi", "Gmail में filter कैसे बनाते हैं?"],
	["id", "Bagaimana cara mengganti bahasa keyboard di Android?"],
	["zh", "怎么在 Word 里插入目录？"],
	["ja", "macOSでダークモードにする方法は？"]
]

const IRRELEVANCE: EvalCase[] = GENERAL.map(([lang, prompt], index) => ({
	id: `help-general-${String(index + 1)}-${lang}`,
	category: "irrelevance",
	lang,
	prompt,
	routes: ["answer"],
	forbidden: ["app_help"],
	expectsText: true
}))

// Help or navigation: a section asked for by name opens it (either group offers open_route); a question about how
// to do something looks it up.
const SECTIONS: readonly (readonly [Language, string, string])[] = [
	["en", "Open settings.", "settings"],
	["de", "Öffne die Sicherheitseinstellungen.", "settings_security"],
	["fr", "Ouvre les réglages d'apparence.", "settings_appearance"],
	["ru", "Открой настройки аккаунта.", "settings_account"],
	["zh", "打开设置。", "settings"],
	["ar", "افتح إعدادات الأمان.", "settings_security"]
]

const ROUTER_OPEN: EvalCase[] = SECTIONS.map(([lang, prompt, route], index) => ({
	id: `help-router-open-${String(index + 1)}-${lang}`,
	category: "simple",
	lang,
	prompt,
	routes: ["navigation", "help"],
	calls: [{ tool: "open_route", args: { route } }],
	state: [{ screen: route }]
}))

const HOW_TO: readonly HelpAsk[] = [
	["es", "¿Cómo hago para que mis fotos HEIC se suban como JPG?"],
	["pt", "Como mudo o ecrã que o Filen abre ao iniciar?"],
	["tr", "Kişilerim beni çevrimdışı görsün istiyorum, nasıl yaparım?"],
	["hi", "मैं नए note का default type कैसे बदलूँ?"],
	["id", "Bagaimana cara menampilkan direktori .filen?"],
	["ja", "新しいデバイスがログインしたときにメールで知らせてほしい。どう設定する？"]
]

const ROUTER_HOW_TO: EvalCase[] = HOW_TO.map(([lang, prompt], index) => ({
	id: `help-router-howto-${String(index + 1)}-${lang}`,
	category: "simple",
	lang,
	prompt,
	routes: ["help"],
	calls: [{ tool: "app_help" }],
	expectsText: true
}))

export const HELP_CASES: EvalCase[] = [...SIMPLE, ...MULTI_STEP, ...IRRELEVANCE, ...ROUTER_OPEN, ...ROUTER_HOW_TO]
