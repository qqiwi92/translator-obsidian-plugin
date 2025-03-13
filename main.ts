import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";

// Интерфейс настроек плагина
interface LanguageTablePluginSettings {
	apiKey: string;
	nativeLanguage: string;   // Родной язык пользователя
	learningLanguage: string; // Язык, который изучается
	columns: string[];        // Например, ["Слово", "Перевод", "Транскрипция", "Описание"]
	provider: string;         // Выбранный провайдер: "ChatGPT" или "Gemini"
}

const DEFAULT_SETTINGS: LanguageTablePluginSettings = {
	apiKey: "",
	nativeLanguage: "Russian",
	learningLanguage: "English",
	columns: ["Слово", "Перевод", "Транскрипция", "Описание"],
	provider: "ChatGPT",
};

interface InsertRowData {
	word: string;
}

export default class LanguageTablePlugin extends Plugin {
	settings: LanguageTablePluginSettings = DEFAULT_SETTINGS;
	lastUsedTableIndex = 0;

	async onload() {
		await this.loadSettings();

		// Добавляем вкладку настроек плагина
		this.addSettingTab(new LanguageTableSettingTab(this.app, this));

		// Команда для генерации таблицы
		this.addCommand({
			id: "generate-language-table",
			name: "Генерация таблицы для изучения языка",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				new GenerateTableModal(this.app, this.settings, (newSettings: LanguageTablePluginSettings) => {
					this.settings = newSettings;
					this.saveSettings();
					const table = generateTableString(newSettings.columns);
					editor.replaceSelection(table + "\n");
					new Notice("Таблица сгенерирована.");
				}).open();
			},
		});

		// Команда для вставки новой строки в таблицу с автоматическим заполнением
		this.addCommand({
			id: "insert-word-row",
			name: "Вставка строки с новым словом",
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				const content = editor.getValue();
				const tables = extractMarkdownTables(content);
				if (tables.length === 0) {
					new Notice("В документе не найдено таблиц.");
					return;
				}
				new InsertRowModal(this.app, tables, this.lastUsedTableIndex, async (selectedIndex: number, rowData: InsertRowData) => {
					this.lastUsedTableIndex = selectedIndex;
					const tableBlock = tables[selectedIndex];

					// Проверка: слово уже есть в первой колонке таблицы?
					if (wordExistsInTable(tableBlock.text, rowData.word)) {
						new Notice("Такое слово уже есть в таблице.");
						return;
					}

					// Формируем новую строку, заполняя все ячейки
					const numCols = countTableColumns(tableBlock.text);
					const cells: string[] = [];
					// Первая колонка – само слово
					cells.push(rowData.word);
					// Для остальных столбцов генерируем значение через API с учетом выбранного провайдера
					for (let i = 1; i < numCols; i++) {
						const colName = this.settings.columns[i] ? this.settings.columns[i].toLowerCase() : "";
						let prompt = "";
						if (colName.includes("перевод")) {
							prompt = `Переведи слово "${rowData.word}" с ${this.settings.nativeLanguage} на ${this.settings.learningLanguage}.`;
						} else if (colName.includes("транскрипция")) {
							prompt = `Предоставь фонетическую транскрипцию слова "${rowData.word}" для ${this.settings.learningLanguage}.`;
						} else if (colName.includes("описание")) {
							prompt = `Дай краткое, понятное описание слова "${rowData.word}" для изучающих ${this.settings.learningLanguage}.`;
						} else {
							cells.push("");
							continue;
						}
						const response = await fetchTranslationResult(prompt, this.settings.apiKey, this.settings.provider);
						cells.push(response);
					}

					// Собираем строку таблицы
					const newRow = "| " + cells.join(" | ") + " |";
					const updatedTable = appendRowToTable(tableBlock.text, newRow);
					const updatedContent = content.slice(0, tableBlock.start) + updatedTable + content.slice(tableBlock.end);
					editor.setValue(updatedContent);
					new Notice("Новая строка добавлена.");
				}).open();
			},
		});
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

/* Функция для генерации строки таблицы */
function generateTableString(columns: string[]): string {
	const header = "| " + columns.map(col => col.trim() || " ").join(" | ") + " |";
	const separator = "| " + columns.map(() => "---").join(" | ") + " |";
	const emptyRow = "| " + columns.map(() => " ").join(" | ") + " |";
	return `${header}\n${separator}\n${emptyRow}`;
}

/* Извлечение markdown-таблиц из текста */
function extractMarkdownTables(content: string): { text: string; start: number; end: number }[] {
	const tables: { text: string; start: number; end: number }[] = [];
	const regex = /((\|.*\|\n)+)(\|[\s-|]+\|\n)/g;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(content)) !== null) {
		const end = regex.lastIndex;
		const tableText = match[0];
		tables.push({ text: tableText, start: match.index, end });
	}
	return tables;
}

/* Подсчёт количества столбцов */
function countTableColumns(tableText: string): number {
	const firstLine = tableText.split("\n")[0];
	const cols = firstLine.split("|").map(cell => cell.trim()).filter(cell => cell !== "");
	return cols.length;
}

/* Проверка, есть ли слово в первой колонке таблицы */
function wordExistsInTable(tableText: string, word: string): boolean {
	const lines = tableText.split("\n").filter(line => line.trim().startsWith("|"));
	for (let i = 2; i < lines.length; i++) {
		const cells = lines[i].split("|").map(cell => cell.trim());
		if (cells.length > 1 && cells[1].toLowerCase() === word.toLowerCase()) {
			return true;
		}
	}
	return false;
}

/* Добавление новой строки в конец таблицы */
function appendRowToTable(tableText: string, newRow: string): string {
	const lines = tableText.split("\n");
	let lastIndex = lines.length - 1;
	while (lastIndex >= 0 && lines[lastIndex].trim() === "") {
		lastIndex--;
	}
	lines.splice(lastIndex + 1, 0, newRow);
	return lines.join("\n");
}

/* Модальное окно для генерации таблицы */
class GenerateTableModal extends Modal {
	settings: LanguageTablePluginSettings;
	onSubmit: (newSettings: LanguageTablePluginSettings) => void;
	checkboxes: { [key: string]: HTMLInputElement } = {};

	constructor(app: App, settings: LanguageTablePluginSettings, onSubmit: (newSettings: LanguageTablePluginSettings) => void) {
		super(app);
		this.settings = settings;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Генерация таблицы" });
		contentEl.createEl("p", { text: "Выберите столбцы для таблицы:" });
		contentEl.createEl("div", { cls: "separator" });
		const availableColumns = ["Слово", "Перевод", "Транскрипция", "Описание"];
		availableColumns.forEach((col) => {
			const div = contentEl.createDiv();
			const checkbox = div.createEl("input", { type: "checkbox" });
			checkbox.checked = this.settings.columns.includes(col);
			this.checkboxes[col] = checkbox;
			div.createEl("label", { text: " " + col });
		});
		contentEl.createEl("div", { cls: "separator" });
		const submitButton = contentEl.createEl("button", { text: "Создать таблицу" });
		submitButton.onclick = () => {
			const selected: string[] = [];
			for (const col in this.checkboxes) {
				if (this.checkboxes[col].checked) {
					selected.push(col);
				}
			}
			if (selected.length === 0) {
				new Notice("Выберите хотя бы один столбец.");
				return;
			}
			this.onSubmit({ ...this.settings, columns: selected });
			this.close();
		};
	}

	onClose() {
		this.contentEl.empty();
	}
}

/* Модальное окно для вставки новой строки в таблицу */
class InsertRowModal extends Modal {
	tables: { text: string; start: number; end: number }[];
	lastUsedIndex: number;
	onSubmit: (selectedIndex: number, data: InsertRowData) => void;
	wordInput: HTMLInputElement;
	tableSelect: HTMLSelectElement;

	constructor(app: App, tables: { text: string; start: number; end: number }[], lastUsedIndex: number, onSubmit: (selectedIndex: number, data: InsertRowData) => void) {
		super(app);
		this.tables = tables;
		this.lastUsedIndex = lastUsedIndex;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Вставка строки в таблицу" });
		const wordDiv = contentEl.createDiv();
		wordDiv.createEl("label", { text: "Новое слово:" });
		this.wordInput = wordDiv.createEl("input", { type: "text" });
		this.wordInput.style.width = "100%";
		contentEl.createEl("div", { cls: "separator" });
		const selectDiv = contentEl.createDiv();
		selectDiv.createEl("label", { text: "Выберите таблицу:" });
		this.tableSelect = selectDiv.createEl("select");
		this.tableSelect.style.width = "100%";
		this.tables.forEach((tableBlock, index) => {
			const headerSnippet = tableBlock.text.split("\n")[0].slice(0, 40) + "...";
			const option = this.tableSelect.createEl("option", { text: headerSnippet, value: index.toString() });
			if (index === this.lastUsedIndex) {
				option.selected = true;
			}
		});
		contentEl.createEl("div", { cls: "separator" });
		const submitButton = contentEl.createEl("button", { text: "Добавить строку" });
		submitButton.onclick = () => {
			const word = this.wordInput.value.trim();
			if (!word) {
				new Notice("Введите слово.");
				return;
			}
			const selectedIndex = parseInt(this.tableSelect.value);
			this.onSubmit(selectedIndex, { word });
			this.close();
		};
	}

	onClose() {
		this.contentEl.empty();
	}
}

/* Функция вызова API перевода в зависимости от выбранного провайдера */
async function fetchTranslationResult(prompt: string, apiKey: string, provider: string): Promise<string> {
	if (provider === "Gemini") {
		// Пример запроса к API Gemini AI (endpoint и payload условны)
		const url = "https://api.googleai.com/v1/translate"; // Замените на реальный endpoint, если доступен
		const requestBody = {
			prompt: prompt,
			max_tokens: 150,
		};
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Authorization": `Bearer ${apiKey}`
				},
				body: JSON.stringify(requestBody)
			});
			const data = await response.json();
			if (data.result) {
				return data.result.trim();
			} else {
				console.error("Unexpected Gemini API response:", data);
				return "";
			}
		} catch (error) {
			console.error("Error fetching Gemini response:", error);
			return "";
		}
	} else {
		// Запрос к ChatGPT API
		const url = "https://api.openai.com/v1/chat/completions";
		const requestBody = {
			model: "gpt-3.5-turbo",
			messages: [
				{ role: "system", content: "Ты помогаешь изучать иностранные языки." },
				{ role: "user", content: prompt }
			],
			temperature: 0.2,
			max_tokens: 150,
		};
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Authorization": `Bearer ${apiKey}`
				},
				body: JSON.stringify(requestBody)
			});
			const data = await response.json();
			if (data.choices && data.choices[0]?.message?.content) {
				return data.choices[0].message.content.trim();
			} else {
				console.error("Unexpected ChatGPT API response:", data);
				return "";
			}
		} catch (error) {
			console.error("Error fetching ChatGPT response:", error);
			return "";
		}
	}
}

/* Настройки плагина – вкладка настроек */
class LanguageTableSettingTab extends PluginSettingTab {
	plugin: LanguageTablePlugin;

	constructor(app: App, plugin: LanguageTablePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Настройки плагина таблицы для изучения языка" });

		new Setting(containerEl)
			.setName("API ключ OpenAI/Gemini")
			.setDesc("Введите ваш API ключ для использования ChatGPT или Gemini AI")
			.addText(text =>
				text.setPlaceholder("Ваш API ключ")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Родной язык")
			.setDesc("Язык, на котором вы владеете (например, Russian)")
			.addText(text =>
				text.setPlaceholder("Родной язык")
					.setValue(this.plugin.settings.nativeLanguage)
					.onChange(async (value) => {
						this.plugin.settings.nativeLanguage = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Изучаемый язык")
			.setDesc("Язык, который вы изучаете (например, English)")
			.addText(text =>
				text.setPlaceholder("Изучаемый язык")
					.setValue(this.plugin.settings.learningLanguage)
					.onChange(async (value) => {
						this.plugin.settings.learningLanguage = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Столбцы таблицы")
			.setDesc("Укажите через запятую названия столбцов (например: Слово, Перевод, Транскрипция, Описание)")
			.addText(text =>
				text.setPlaceholder("Слово, Перевод, Транскрипция, Описание")
					.setValue(this.plugin.settings.columns.join(", "))
					.onChange(async (value) => {
						this.plugin.settings.columns = value.split(",").map(v => v.trim()).filter(v => v);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Провайдер")
			.setDesc("Выберите провайдера для перевода: ChatGPT или Gemini AI")
			.addDropdown(drop => 
				drop.addOption("ChatGPT", "ChatGPT")
					.addOption("Gemini", "Gemini")
					.setValue(this.plugin.settings.provider)
					.onChange(async (value) => {
						this.plugin.settings.provider = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
