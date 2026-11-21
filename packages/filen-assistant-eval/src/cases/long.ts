import type { EvalCase } from "./types"

// A pasted text (an email, a note, a log) with the request before or after it, 400 to 1200 characters: the
// router reads a long message by its start and end only (routerRequest), so these measure what it makes of the
// edges. Some ask about the user's data, some only about the pasted text (answer).
export const LONG_CASES: EvalCase[] = [
	{
		id: "long-note-landlord-en",
		category: "long",
		lang: "en",
		prompt: [
			"Can you save this email from my landlord as a note? I need it for the repair appointment.",
			"",
			"Dear tenants of Lindenstraße 12,",
			"",
			"the annual maintenance of the central heating system will take place on Tuesday, 14 October, between 8:00 and 13:00. A technician from Wärme Service GmbH will need access to every flat, including the radiators in the bedrooms and bathrooms. If you cannot be at home, please leave a key with the caretaker, Mr. Brandt, in flat 1A by Monday evening. Hot water will be switched off from 9:00 to 11:00. Please make sure the radiators are not blocked by furniture.",
			"",
			"Thank you for your understanding,",
			"Karin Vogel",
			"Property management"
		].join("\n"),
		routes: ["notes"],
		calls: [{ tool: "create_note" }],
		state: [{ newNote: { titleIncludes: [], contentIncludes: ["brandt"] } }]
	},
	{
		id: "long-log-answer-en",
		category: "long",
		lang: "en",
		prompt: [
			"2025-10-07 22:14:03 INFO  backup-agent starting nightly job (profile: photos)",
			"2025-10-07 22:14:04 INFO  scanning /srv/media/photos (41,220 entries)",
			"2025-10-07 22:31:47 INFO  scan complete, 312 changed files, 4.8 GB to write",
			"2025-10-07 22:31:48 INFO  writing snapshot to /mnt/backup/2025-10-07",
			"2025-10-07 22:52:10 WARN  write slow: 3.1 MB/s (expected > 40 MB/s)",
			"2025-10-07 23:05:33 ERROR write failed: /mnt/backup/2025-10-07/IMG_8812.CR3: No space left on device (errno 28)",
			"2025-10-07 23:05:33 ERROR snapshot aborted after 2.9 GB, 187 of 312 files written",
			"2025-10-07 23:05:34 INFO  cleanup: removed partial snapshot",
			"2025-10-07 23:05:34 INFO  backup-agent exit code 2",
			"2025-10-07 23:05:35 INFO  notifying admin@home.lan",
			"2025-10-07 23:05:36 WARN  smtp: connection refused (mail.home.lan:587), notification not sent",
			"2025-10-08 03:00:00 INFO  disk report: /mnt/backup 931.5 GB total, 929.8 GB used, 1.7 GB free",
			"2025-10-08 03:00:00 INFO  disk report: oldest snapshot 2024-01-02, 214 snapshots kept, retention policy: keep all",
			"",
			"This is from the backup script on my home server. What went wrong, and what should I check first?"
		].join("\n"),
		routes: ["answer"],
		answerIncludes: [["space", "full", "disk"]],
		expectsText: true
	},
	{
		id: "long-trash-installer-en",
		category: "long",
		lang: "en",
		prompt: [
			"Our IT team sent this round:",
			"",
			"Hi all, a quick reminder before the laptop refresh next week. Please remove old installers and disk images from your synced folders, they take up a lot of space and slow down the first sync on the new machines. Anything you still need can be downloaded again from the software portal. Do not delete documents or project files, those will be migrated automatically. If you are unsure whether something is needed, ask in the #it-help channel before Friday. Thanks, Jonas from IT",
			"",
			"I don't need the old installer anymore. Move setup_installer.dmg in my Downloads to the trash."
		].join("\n"),
		routes: ["trash"],
		calls: [{ tool: "trash_items", args: { handles: ["f32"] } }],
		state: [{ item: "f32", trashed: true }]
	},
	{
		id: "long-uploads-week-en",
		category: "long",
		lang: "en",
		prompt: [
			"Which files did I upload this week? I need them for the expense report my manager asked for:",
			"",
			"Hi Sam, could you send me your receipts and photos from the client visit by Thursday? Finance closes the month early this time, so anything that arrives after Thursday noon goes into November. Please attach everything to one email, or put it in the shared expenses directory if that is easier for you. For the hotel, the invoice alone is enough; for meals I need the itemised receipt, not only the card slip. Mileage can go in the usual spreadsheet. Thanks a lot, Priya"
		].join("\n"),
		routes: ["insights"],
		calls: [{ tool: "recent_items" }],
		answerIncludes: [["oma"]],
		expectsText: true
	},
	{
		id: "long-translate-de",
		category: "long",
		lang: "de",
		prompt: [
			"Übersetze mir diese E-Mail bitte ins Deutsche:",
			"",
			"Dear customer,",
			"",
			"thank you for your order no. 48213 from 29 September. Unfortunately, one of the items, the standing desk frame in black, is currently out of stock at our warehouse in Rotterdam. We expect a new delivery in the week of 20 October and will ship your complete order as soon as it arrives. If you prefer, we can send the other items right away at no extra cost, or you can cancel the desk frame and receive a refund within five working days. Please let us know by replying to this email.",
			"",
			"Kind regards,",
			"Customer Service, DeskWorks"
		].join("\n"),
		routes: ["answer"],
		answerIncludes: [["bestell", "liefer", "versand"]],
		expectsText: true
	},
	{
		id: "long-search-invoice-de",
		category: "long",
		lang: "de",
		prompt: [
			"Guten Tag,",
			"",
			"Ihre Telekom Rechnung für Februar 2025 ist da. Rechnungsbetrag: 39,95 EUR. Der Betrag wird am 24.02.2025 von Ihrem Konto mit der IBAN DE12 **** **** **** 4410 abgebucht. Die Rechnung finden Sie wie gewohnt im Kundencenter unter „Meine Rechnungen“. Bitte prüfen Sie die Rechnung zeitnah; Einwände gegen die Rechnung können Sie innerhalb von acht Wochen erheben. Haben Sie Fragen zu Ihrer Rechnung? Unser Service-Team hilft Ihnen gerne weiter.",
			"",
			"Freundliche Grüße",
			"Ihre Telekom",
			"",
			"Habe ich diese Rechnung schon in meinem Drive abgelegt?"
		].join("\n"),
		routes: ["files", "insights"],
		calls: [
			{
				anyOf: [
					{ tool: "search_items", args: { query: { $includes: ["telekom", "rechnung", "invoice", "2025"] } } },
					{ tool: "list_directory", args: { handle: "d2" } }
				]
			}
		],
		answerIncludes: [["invoice_2025-02_telekom"]],
		expectsText: true
	},
	{
		id: "long-reply-anna-de",
		category: "long",
		lang: "de",
		prompt: [
			"Schreib Anna, dass ich die Hetzner-Rechnung heute bezahlt habe. Zur Info, das ist die Bestätigung meiner Bank:",
			"",
			"Überweisung ausgeführt",
			"Empfänger: Hetzner Online GmbH",
			"IBAN: DE92 7605 0101 0010 4285 33",
			"Verwendungszweck: Rechnung R0024471125, Kundennummer K0815-221",
			"Betrag: 18,62 EUR",
			"Ausführungsdatum: 08.10.2025",
			"Auftraggeber: Sam Becker",
			"Status: Die Überweisung wurde erfolgreich an die Empfängerbank übermittelt. Die Gutschrift beim Empfänger erfolgt in der Regel am nächsten Bankarbeitstag. Diese Bestätigung ist ohne Unterschrift gültig. Bitte bewahren Sie sie für Ihre Unterlagen auf."
		].join("\n"),
		routes: ["chats"],
		calls: [{ tool: "draft_chat_message", args: { chat: "c1" } }],
		state: [{ draft: "c1", textIncludes: ["hetzner", "bezahlt", "überwiesen"] }]
	},
	{
		id: "long-reply-carlos-es",
		category: "long",
		lang: "es",
		prompt: [
			"Mira lo que me ha contestado el hotel:",
			"",
			"Estimado cliente:",
			"",
			"Gracias por su interés en Casa Bonay. Le confirmamos que disponemos de habitaciones dobles superiores para las noches del 3 al 6 de junio. La tarifa es de 145 euros por noche, con desayuno incluido, y la cancelación es gratuita hasta 72 horas antes de la llegada. El check-in es a partir de las 15:00 y el check-out hasta las 12:00. Si desea reservar, basta con responder a este correo indicando los nombres de los huéspedes y una tarjeta de garantía.",
			"",
			"Un cordial saludo,",
			"Recepción Casa Bonay",
			"",
			"Escríbele a Carlos que el hotel tiene habitaciones libres del 3 al 6 de junio por 145 euros la noche."
		].join("\n"),
		routes: ["chats"],
		calls: [{ tool: "draft_chat_message", args: { chat: "c3" } }],
		state: [{ draft: "c3", textIncludes: ["145"] }]
	},
	{
		id: "long-move-budget-es",
		category: "long",
		lang: "es",
		prompt: [
			"Mueve presupuesto.xlsx a la carpeta Archive. Este es el correo de Carlos donde lo confirma:",
			"",
			"Hola,",
			"",
			"ya cerramos las cuentas del viaje a Barcelona. Al final gastamos 2.380 euros entre hotel, vuelos y cenas, unos 120 menos de lo previsto, así que no hace falta pedir más dinero a nadie. El presupuesto ya no va a cambiar, puedes guardarlo donde guardes las cosas antiguas. Las facturas del hotel y de los vuelos las tengo yo en papel por si Hacienda pregunta algo. La próxima vez organizo yo el viaje, que te toca descansar.",
			"",
			"Un abrazo,",
			"Carlos"
		].join("\n"),
		routes: ["organize"],
		calls: [{ tool: "move_items", args: { handles: ["f30"], destination: "d8" } }],
		state: [{ item: "f30", parent: "d8" }]
	},
	{
		id: "long-play-workout-es",
		category: "long",
		lang: "es",
		prompt: [
			"Plan de entrenamiento, semana 3:",
			"",
			"Lunes: 10 minutos de calentamiento, 4 series de sentadillas con 12 repeticiones, 3 series de zancadas, plancha de 45 segundos.",
			"Martes: carrera suave de 30 minutos, ritmo cómodo, sin mirar el reloj.",
			"Miércoles: descanso activo, estiramientos y paseo.",
			"Jueves: intervalos, 8 x 400 metros con 90 segundos de pausa entre cada uno.",
			"Viernes: fuerza de tren superior, flexiones, remo con mancuernas y press de hombros, 3 series de 10.",
			"Sábado: carrera larga de 60 minutos.",
			"Domingo: descanso total.",
			"Beber al menos dos litros de agua al día y dormir ocho horas.",
			"",
			"Hoy toca jueves. Pon mi playlist Workout."
		].join("\n"),
		routes: ["audio"],
		calls: [{ tool: "play", args: { handle: "p1" } }]
	},
	{
		id: "long-note-recipe-fr",
		category: "long",
		lang: "fr",
		prompt: [
			"Enregistre cette recette dans une note intitulée « Gratin dauphinois » :",
			"",
			"Pour 6 personnes : 1,5 kg de pommes de terre à chair ferme, 50 cl de crème entière, 50 cl de lait, 2 gousses d'ail, une noix de beurre, sel, poivre et une pincée de muscade.",
			"Éplucher les pommes de terre et les couper en rondelles fines, sans les laver pour garder l'amidon. Frotter un plat à gratin avec l'ail, puis le beurrer. Porter le lait et la crème à frémissement avec l'ail écrasé, le sel, le poivre et la muscade. Y cuire les rondelles 10 minutes en remuant doucement. Verser le tout dans le plat et enfourner 1 heure à 160 °C, jusqu'à ce que le dessus soit bien doré. Laisser reposer 10 minutes avant de servir.",
			"",
			"Astuce de ma grand-mère : ne jamais mettre de fromage, le vrai gratin dauphinois n'en contient pas, et choisir des pommes de terre de taille égale pour une cuisson régulière. On peut le préparer la veille et le réchauffer 20 minutes à 150 °C, il est même meilleur. Accompagne très bien un gigot d'agneau ou une salade verte bien relevée. Pour une version plus légère, remplacer la moitié de la crème par du lait demi-écrémé, mais le résultat sera moins onctueux."
		].join("\n"),
		routes: ["notes"],
		calls: [{ tool: "create_note" }],
		state: [{ newNote: { titleIncludes: ["gratin"] } }]
	},
	{
		id: "long-sharing-tax-fr",
		category: "long",
		lang: "fr",
		prompt: [
			"Bonjour,",
			"",
			"comme chaque année, j'aurai besoin de votre déclaration d'impôts allemande pour préparer le dossier de résidence fiscale. Merci de me la transmettre avant le 31 octobre, de préférence par un lien sécurisé plutôt qu'en pièce jointe. Si votre conseillère en Allemagne l'a déjà reçue, il suffit de me confirmer avec qui le document a été partagé, pour que je puisse lui demander directement une copie. Je reste disponible pour toute question.",
			"",
			"Cordialement,",
			"Hélène Martin, cabinet comptable",
			"",
			"Est-ce que Steuererklärung_2024.pdf est déjà partagé avec quelqu'un ?"
		].join("\n"),
		routes: ["shared"],
		calls: [{ tool: "get_sharing", args: { handle: "f10" } }],
		answerIncludes: [["anna"]],
		expectsText: true
	},
	{
		id: "long-chat-camille-fr",
		category: "long",
		lang: "fr",
		prompt: [
			"Invitation reçue par mail :",
			"",
			"Chers amis, Léa fête ses 30 ans le samedi 18 octobre ! Rendez-vous à partir de 19 h au Petit Comptoir, 14 rue des Martyrs, Paris 9e. Nous avons réservé la salle du fond, il y aura un buffet et un DJ à partir de 22 h. Merci de confirmer votre présence avant le 10 octobre en répondant à ce message. Pour le cadeau commun, Camille centralise la participation, comptez 20 euros par personne. Surtout, pas un mot à Léa, c'est une surprise !",
			"",
			"Qu'est-ce que Camille m'a écrit à propos de samedi ?"
		].join("\n"),
		routes: ["chats"],
		calls: [{ tool: "read_chat", args: { handle: "c12" } }],
		answerIncludes: [["cadeau"]],
		expectsText: true
	},
	{
		id: "long-summarize-meeting-pt",
		category: "long",
		lang: "pt",
		prompt: [
			"Ata da reunião de condomínio, 2 de outubro",
			"",
			"Presentes: 14 de 20 unidades. A síndica apresentou o orçamento para a pintura da fachada: três empresas enviaram propostas, entre 38 mil e 52 mil reais. Foi aprovada por maioria a proposta da Pinta Bem, de 41 mil reais, a ser paga em seis parcelas a partir de janeiro. A obra deve começar em março e durar cerca de oito semanas. Também foi aprovada a troca do interfone, com custo de 6.200 reais, que sai do fundo de reserva. Moradores reclamaram do barulho de obras aos sábados; a partir de agora, obras só até as 13h nesse dia. Próxima reunião em dezembro.",
			"",
			"Resume isso pra mim em três tópicos curtos."
		].join("\n"),
		routes: ["answer"],
		answerIncludes: [["41"]],
		expectsText: true
	},
	{
		id: "long-note-ideas-pt",
		category: "long",
		lang: "pt",
		prompt: [
			"Meu amigo me mandou isso no WhatsApp:",
			"",
			"Cara, tô pensando em largar o emprego e fazer um app no ano que vem. Já testei umas ideias com o pessoal da faculdade: um app pra dividir contas de república, um pra trocar livros usados e um pra lembrar de tomar remédio. Ninguém se animou muito com nenhum. Você não tinha umas ideias de app anotadas? Se tiver alguma boa, me manda que a gente conversa no fim de semana. Posso cuidar do design e você da parte técnica, metade cada um.",
			"",
			"Eu tenho alguma nota com ideias de app? O que diz nela?"
		].join("\n"),
		routes: ["notes"],
		calls: [{ tool: "read_note", args: { handle: "n10" } }],
		answerIncludes: [["receita"]],
		expectsText: true
	},
	{
		id: "long-reply-email-ru",
		category: "long",
		lang: "ru",
		prompt: [
			"Помоги вежливо ответить на это письмо, просто напиши текст ответа:",
			"",
			"Добрый день!",
			"",
			"Мы с коллегами готовим ежегодный отчёт отдела и хотели бы включить в него результаты вашего проекта по автоматизации складского учёта. Не могли бы вы до пятницы прислать краткое описание: какие задачи решались, сколько времени заняла работа и какие показатели удалось улучшить? Достаточно одной страницы. Если удобнее, можем созвониться на пятнадцать минут во вторник или в среду после обеда. Заранее спасибо!",
			"",
			"С уважением,",
			"Ольга Петрова"
		].join("\n"),
		routes: ["answer"],
		answerIncludes: [["ольга"]],
		expectsText: true
	},
	{
		id: "long-note-doctor-ru",
		category: "long",
		lang: "ru",
		prompt: [
			"Рекомендации после приёма, 7 октября:",
			"",
			"Диагноз: острый бронхит. Ибупрофен 400 мг при температуре выше 38,5, не чаще трёх раз в день. Амброксол по одной таблетке три раза в день после еды, курс семь дней. Обильное тёплое питьё, не менее двух литров в сутки. Проветривать комнату, избегать переохлаждения. Ингаляции с физраствором утром и вечером. Если через три дня температура не снизится или появится одышка, срочно повторный приём. Больничный лист открыт до 14 октября, явка на приём 14 октября в 10:30, кабинет 212.",
			"",
			"Сохрани это в заметку, пожалуйста."
		].join("\n"),
		routes: ["notes"],
		calls: [{ tool: "create_note" }],
		state: [{ newNote: { titleIncludes: [], contentIncludes: ["амброксол"] } }]
	},
	{
		id: "long-file-recipe-tr",
		category: "long",
		lang: "tr",
		prompt: [
			"Kuzenim şunu yazdı:",
			"",
			"Selam! Bu akşam annemler geliyor, sana sormak istedim. Geçen kış bize yaptığın mercimek çorbası çok güzeldi, annem hâlâ bahsediyor. Ben de yapmayı denedim ama kıvamı tutmadı, ya çok sulu oldu ya da dibi tuttu. Hangi mercimeği kullanıyordun, kırmızı mı sarı mı? Bir de ne kadar pişirmek gerekiyor, sonra blenderdan mı geçiriyorsun? Tarifi bir yere yazmıştın galiba, bulursan bana atar mısın? Şimdiden çok teşekkürler!",
			"",
			"Tarifler klasöründeki mercimek_çorbası.txt dosyasında çorba kaç dakika pişiyor?"
		].join("\n"),
		routes: ["files"],
		calls: [{ tool: "read_text_file", args: { handle: "f40" } }],
		answerIncludes: [["25"]],
		expectsText: true
	},
	{
		id: "long-note-meeting-tr",
		category: "long",
		lang: "tr",
		prompt: [
			"Bu toplantı notlarını 'Ekip toplantısı' başlıklı bir not olarak kaydet:",
			"",
			"Katılımcılar: Ahmet, Elif, Murat, ben. Yeni müşteri portalının teslim tarihi 15 Kasım olarak kesinleşti. Elif tasarım ekranlarını cuma gününe kadar bitirecek, Murat ödeme entegrasyonunu test ortamına alacak. Sunucu maliyetleri beklenenden yüksek çıktı; Ahmet iki farklı sağlayıcıdan teklif alacak. Müşteriden gelen geri bildirimlerde en çok giriş ekranının yavaşlığından şikâyet edilmiş, bu konu öncelikli. Bir sonraki toplantı salı saat 14:00'te."
		].join("\n"),
		routes: ["notes"],
		calls: [{ tool: "create_note" }],
		state: [{ newNote: { titleIncludes: ["ekip"] } }]
	},
	{
		id: "long-summarize-ar",
		category: "long",
		lang: "ar",
		prompt: [
			"إعلان من إدارة المبنى:",
			"",
			"نود إعلامكم بأن أعمال صيانة المصاعد ستبدأ يوم الأحد القادم وتستمر لمدة أسبوعين. خلال هذه الفترة سيعمل مصعد واحد فقط من أصل ثلاثة، وسيتم تخصيصه لكبار السن والأسر التي لديها أطفال صغار في ساعات الذروة من السابعة إلى التاسعة صباحاً ومن الخامسة إلى السابعة مساءً. كما سيتم قطع المياه يوم الثلاثاء من العاشرة صباحاً حتى الثانية ظهراً لإصلاح الأنابيب الرئيسية. نرجو من السكان عدم ترك أي أغراض في الممرات وموقف السيارات خلال فترة العمل. لأي استفسار يرجى التواصل مع مكتب الإدارة في الطابق الأرضي.",
			"",
			"لخّص هذا الإعلان في جملتين."
		].join("\n"),
		routes: ["answer"],
		answerIncludes: [["مصعد", "المصاعد", "مصاعد"]],
		expectsText: true
	},
	{
		id: "long-reply-fatima-ar",
		category: "long",
		lang: "ar",
		prompt: [
			"اكتب لفاطمة أن فاتورة الكهرباء وصلتني وأنني سأدفعها غداً. هذا نص الرسالة التي وصلتني من الشركة:",
			"",
			"عميلنا العزيز، نود إعلامك بصدور فاتورة الكهرباء لشهر سبتمبر بقيمة 312 درهماً، وتاريخ الاستحقاق هو 15 أكتوبر. يمكنك الدفع عبر التطبيق أو الموقع الإلكتروني أو في أي فرع من فروعنا. في حال التأخر عن السداد بعد تاريخ الاستحقاق ستضاف رسوم تأخير قدرها 25 درهماً. للاستفسار عن تفاصيل الاستهلاك يرجى الاتصال بخدمة العملاء على مدار الساعة. شكراً لاختيارك خدماتنا."
		].join("\n"),
		routes: ["chats"],
		calls: [{ tool: "draft_chat_message", args: { chat: "c10" } }],
		state: [{ draft: "c10", textIncludes: ["الكهرباء", "فاتورة", "غدا"] }]
	},
	{
		id: "long-note-trip-hi",
		category: "long",
		lang: "hi",
		prompt: [
			"उदयपुर यात्रा का प्लान:",
			"",
			"पहला दिन: सुबह 7 बजे की फ्लाइट से उदयपुर पहुँचना, होटल लेक व्यू में चेक-इन, शाम को पिछोला झील में नाव की सवारी।",
			"दूसरा दिन: सिटी पैलेस और जगदीश मंदिर, दोपहर का खाना अंबराई रेस्टोरेंट में, शाम को बागोर की हवेली में लोक नृत्य कार्यक्रम।",
			"तीसरा दिन: सज्जनगढ़ किला और सहेलियों की बाड़ी, रात को स्थानीय बाज़ार से खरीदारी।",
			"चौथा दिन: सुबह नाश्ते के बाद चेक-आउट, दोपहर 2 बजे की फ्लाइट से वापसी।",
			"बजट: लगभग 35,000 रुपये, होटल पहले से बुक है, टैक्सी वहीं पर लेनी है।",
			"",
			"इसे एक नोट में सेव कर दो।"
		].join("\n"),
		routes: ["notes"],
		calls: [{ tool: "create_note" }],
		state: [{ newNote: { titleIncludes: [], contentIncludes: ["पिछोला"] } }]
	},
	{
		id: "long-summarize-hi",
		category: "long",
		lang: "hi",
		prompt: [
			"इस ईमेल का सार हिंदी में दो-तीन लाइनों में बताओ:",
			"",
			"प्रिय किरायेदार, आपको सूचित किया जाता है कि अगले महीने की पहली तारीख से फ्लैट का किराया 18,000 रुपये से बढ़कर 19,500 रुपये हो जाएगा। यह बढ़ोतरी समझौते की शर्तों के अनुसार है, जिसमें हर साल अधिकतम दस प्रतिशत तक किराया बढ़ाने की अनुमति है। रखरखाव शुल्क में कोई बदलाव नहीं है। कृपया नया किराया हर महीने की पाँच तारीख तक बैंक खाते में जमा करें और रसीद व्हाट्सऐप पर भेज दें। अगर आपको कोई आपत्ति हो तो इस महीने की बीस तारीख तक बता दें। धन्यवाद, मकान मालिक।"
		].join("\n"),
		routes: ["answer"],
		answerIncludes: [["19,500", "19500", "19 500"]],
		expectsText: true
	},
	{
		id: "long-reply-rina-id",
		category: "long",
		lang: "id",
		prompt: [
			"Ini garis besar presentasi yang Rina kirim:",
			"",
			"Slide 1: Judul, Peluncuran Aplikasi Kasir Versi 2.",
			"Slide 2: Masalah di versi lama, transaksi lambat saat jam ramai dan laporan harian sering tidak cocok.",
			"Slide 3: Fitur baru, mode offline, struk digital lewat WhatsApp, dan laporan otomatis setiap malam.",
			"Slide 4: Target peluncuran 1 November dengan 50 toko percontohan di Jakarta dan Bandung.",
			"Slide 5: Anggaran pemasaran 120 juta rupiah untuk tiga bulan pertama.",
			"Slide 6: Risiko dan rencana cadangan, termasuk pelatihan kasir di setiap toko.",
			"",
			"Tolong kirim pesan ke Rina bahwa aku sudah baca presentasinya, tapi tanggal di slide 4 harus diganti jadi 1 Desember."
		].join("\n"),
		routes: ["chats"],
		calls: [{ tool: "draft_chat_message", args: { chat: "c9" } }],
		state: [{ draft: "c9", textIncludes: ["desember", "slide 4"] }]
	},
	{
		id: "long-new-directory-id",
		category: "long",
		lang: "id",
		prompt: [
			"Buat folder baru bernama Laporan Klien di dalam folder Projects. Ini email dari klien soal laporannya:",
			"",
			"Selamat siang,",
			"",
			"terima kasih atas kerja samanya selama kuartal ini. Mulai bulan depan kami ingin menerima laporan bulanan dalam format PDF, paling lambat tanggal 5 setiap bulan. Mohon sertakan ringkasan penjualan per wilayah, perbandingan dengan bulan sebelumnya, dan daftar kendala yang perlu kami tindak lanjuti. Laporan bisa dikirim lewat tautan berbagi agar tim keuangan kami bisa mengunduhnya langsung. Jika ada pertanyaan, silakan hubungi saya kapan saja.",
			"",
			"Salam,",
			"Budi Santoso"
		].join("\n"),
		routes: ["organize"],
		calls: [{ tool: "create_directory", args: { parent: "d10" } }],
		state: [{ newDirectory: { parent: "d10", name: "Laporan Klien" } }]
	},
	{
		id: "long-summarize-zh",
		category: "long",
		lang: "zh",
		prompt: [
			"关于调整年假制度的通知：",
			"",
			"各位同事，经公司管理层讨论决定，从明年一月一日起对年假制度进行调整。工作满一年不满五年的员工，年假由五天增加到七天；工作满五年以上的员工，年假由十天增加到十二天。当年未休完的年假可以顺延到次年三月底，逾期作废，不再折算工资。请假需提前一周在系统中提交申请，连续休假超过五天的需要部门负责人和人事部共同审批。春节前后两周为业务高峰期，原则上不安排年假。如有疑问，请联系人事部王经理。",
			"",
			"此外，从下个月起，加班调休也纳入新的考勤系统统一管理。每月加班时长超过二十小时的，可以申请一天调休，调休需在三个月内使用完毕。病假仍按原规定执行，三天以上需要提供医院证明。新制度的详细说明已经上传到公司内网的人事专栏，请大家在本月底前登录系统确认已阅读。各部门负责人请在周会上向本部门员工传达本通知，并收集大家的意见和问题，于下周五前汇总给人事部。如对新制度有任何建议，也欢迎通过内网的意见箱匿名提交。",
			"",
			"帮我用三句话总结一下这个通知。"
		].join("\n"),
		routes: ["answer"],
		answerIncludes: [["七天", "7天", "12天", "十二天"]],
		expectsText: true
	},
	{
		id: "long-note-minutes-zh",
		category: "long",
		lang: "zh",
		prompt: [
			"把下面的会议纪要保存成一条笔记：",
			"",
			"十月产品周会纪要。参会人：李伟、张敏、陈强和我。一、新版本上线时间定为十一月二十日，测试工作在十一月十日前完成。二、张敏负责更新用户手册和帮助中心的文章。三、陈强反馈安卓端登录偶尔失败，需要在下周三前定位原因。四、市场部希望在上线前做一次内部演示，时间暂定十一月十五日下午。五、服务器扩容的预算已经批准，共八万元。下次周会时间为下周一上午十点。",
			"六、客服部反映最近关于导出功能的投诉明显增多，主要是导出大文件时页面卡住，张敏和陈强一起排查，下周会上汇报进展。七、新入职的两位同事由李伟负责带教，先熟悉代码规范和发布流程。八、年底团建的地点还没有定，大家可以在群里投票，周五截止。会议记录由我整理，如有遗漏请在群里补充。九、下季度的用户调研计划由市场部牵头，我们需要在十一月底前提供三个想重点了解的问题。十、办公室的打印机已经报修，维修期间请使用三楼的那台。下周的会议室已经预订好，在五楼大会议室。"
		].join("\n"),
		routes: ["notes"],
		calls: [{ tool: "create_note" }],
		state: [{ newNote: { titleIncludes: [], contentIncludes: ["陈强"] } }]
	},
	{
		id: "long-reply-yuki-ja",
		category: "long",
		lang: "ja",
		prompt: [
			"予約確認のメールが来た：",
			"",
			"この度は和食処さくら亭をご予約いただき、誠にありがとうございます。ご予約内容は以下の通りです。日時は十月十日金曜日の十九時から、人数は二名様、お席は個室のお座敷をご用意しております。コースは季節の懐石コース、お一人様八千八百円です。ご予約の変更やキャンセルは前日の十八時までにお電話でご連絡ください。当日のキャンセルはコース料金の全額を頂戴いたしますので、ご了承ください。皆様のご来店を心よりお待ちしております。",
			"",
			"なお、当店は駅の東口から徒歩五分、商店街を抜けた先の二階にございます。お車でお越しの場合は近隣のコインパーキングをご利用ください。アレルギーや苦手な食材がございましたら、ご来店の三日前までにお知らせいただければ、可能な範囲で対応いたします。お祝いのお席でしたら、デザートにメッセージをお入れすることもできますので、お気軽にお申し付けください。",
			"",
			"ユキに、金曜日の19時にさくら亭を予約したって伝えて。"
		].join("\n"),
		routes: ["chats"],
		calls: [{ tool: "draft_chat_message", args: { chat: "c5" } }],
		state: [{ draft: "c5", textIncludes: ["さくら亭"] }]
	},
	{
		id: "long-find-report-ja",
		category: "long",
		lang: "ja",
		prompt: [
			"報告書_第3四半期.pdf はどのフォルダに入ってる？上司からのメールを貼っておくね：",
			"",
			"お疲れさまです。来週の役員会議で第3四半期の報告書を使いたいので、最新版を共有してもらえますか。先月の会議で指摘された売上の内訳と、新規顧客数の推移のグラフが反映されているか確認をお願いします。もし修正が間に合わなければ、修正前の版でも構いませんが、その場合はどこが未修正かをメモで添えてください。会議資料は木曜日の正午までにまとめる予定です。よろしくお願いします。",
			"あと、前回の版では為替の影響についての説明が少し分かりにくいという意見が出ていたので、可能であれば一段落追加しておいてもらえると助かります。グラフの色は会社のテンプレートに合わせてください。ファイル名は変えずにそのまま共有してもらえれば、こちらで資料に組み込みます。急ぎで申し訳ありませんが、よろしくお願いします。もし難しい点があれば、明日の朝会で少し相談させてください。"
		].join("\n"),
		routes: ["files", "insights"],
		calls: [{ tool: "search_items", args: { query: { $includes: ["報告書", "第3四半期", "第3", "四半期"] } } }],
		answerIncludes: [["downloads"]],
		expectsText: true
	},
	{
		id: "long-rewrite-ja",
		category: "long",
		lang: "ja",
		prompt: [
			"次の文章を取引先に送れるような丁寧なメールに書き直して：",
			"",
			"見積もりの件だけど、前に言ってた金額だとちょっと厳しい。材料費が上がってて、うちも正直ギリギリ。できれば一割くらい上げたい。それが無理なら納期を二週間延ばしてもらえれば、なんとか今の金額でもやれるかも。どっちがいいか今週中に返事ほしい。あと、来月からの分は新しい単価で考えてほしい。前回の納品で数が足りなかった件は本当に申し訳なかった、次からは出荷前にちゃんと確認するようにする。",
			"それと、来年の春に予定してる新しい製品の件も、仕様が決まったら早めに教えてほしい。量が多くなるなら、今のうちに材料をまとめて仕入れておけば少し安くできるかもしれないから。打ち合わせは来週の火曜か水曜の午後ならいつでも大丈夫。資料があれば事前にメールで送ってもらえると助かる。それから、請求書の送り先が先月から経理部の新しい担当者に変わったので、次回からはそちらに送ってほしい。名前と連絡先は後で別のメールで送る。"
		].join("\n"),
		routes: ["answer"],
		answerIncludes: [["見積"]],
		expectsText: true
	}
]
