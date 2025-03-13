import {
	App,
	Editor,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
} from "obsidian";
import { GoogleGenerativeAI } from "@google/generative-ai";

// Интерфейс настроек плагина
interface LanguageTablePluginSettings {
	apiKey: string;
	nativeLanguage: string; // Родной язык пользователя (полное название)
	learningLanguage: string; // Язык, который изучается (полное название)
	nativeLanguageCode: string; // Код родного языка (например, ru)
	learningLanguageCode: string; // Код изучаемого языка (например, en)
	columns: string[]; // Например, ["Слово", "Перевод", "Транскрипция", "Описание"]
}

const DEFAULT_SETTINGS: LanguageTablePluginSettings = {
	apiKey: "",
	nativeLanguage: "Russian",
	learningLanguage: "English",
	nativeLanguageCode: "ru",
	learningLanguageCode: "en",
	columns: ["Слово", "Перевод", "Транскрипция", "Описание"],
};

interface InsertRowData {
	word: string;
}

export default class LanguageTablePlugin extends Plugin {
	settings: LanguageTablePluginSettings = DEFAULT_SETTINGS;
	lastUsedTableIndex = 0;

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new LanguageTableSettingTab(this.app, this));

		this.addCommand({
			id: "generate-language-table",
			name: "Генерация таблицы для изучения языка",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				new GenerateTableModal(
					this.app,
					this.settings,
					(newSettings: LanguageTablePluginSettings) => {
						this.settings = newSettings;
						this.saveSettings();
						// Передаём языковые коды в генерацию таблицы
						const table = generateTableString(
							newSettings.columns,
							newSettings.learningLanguageCode,
							newSettings.nativeLanguageCode,
						);
						editor.replaceSelection(table + "\n");
						new Notice("Таблица сгенерирована.");
					},
				).open();
			},
		});

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
				new InsertRowModal(
					this.app,
					tables,
					this.lastUsedTableIndex,
					async (selectedIndex: number, rowData: InsertRowData) => {
						this.lastUsedTableIndex = selectedIndex;
						const tableBlock = tables[selectedIndex];

						if (wordExistsInTable(tableBlock.text, rowData.word)) {
							new Notice("Такое слово уже есть в таблице.");
							return;
						}

						const numCols = countTableColumns(tableBlock.text);
						const uniqueId = Date.now();
						const cells: string[] = [];
						for (let i = 0; i < numCols; i++) {
							if (i === 0) {
								cells.push(
									`${rowData.word}<!--ID:${uniqueId}-->`,
								);
							} else {
								cells.push("loading");
							}
						}
						const newRow = "| " + cells.join(" | ") + " |";
						const updatedTable = appendRowToTable(
							tableBlock.text,
							newRow,
						);
						// Обновляем только блок таблицы, не затрагивая остальной текст
						const updatedContent =
							content.slice(0, tableBlock.start) +
							updatedTable +
							content.slice(tableBlock.end);
						editor.setValue(updatedContent);
						new Notice(
							"Строка добавлена с плейсхолдерами." +
								this.settings.nativeLanguage +
								" " +
								this.settings.learningLanguage,
						);

						// Обновляем ячейки асинхронно
						for (let i = 1; i < numCols; i++) {
							const colName = this.settings.columns[i]
								? this.settings.columns[i].toLowerCase()
								: "";
							let prompt = "";
							if (colName.includes("перевод")) {
								prompt = `Переведи слово "${rowData.word}" с ${this.settings.learningLanguageCode} на ${this.settings.nativeLanguageCode} одним-двумя словами`;
							} else if (colName.includes("транскрипция")) {
								prompt = `Предоставь фонетическую транскрипцию слова "${rowData.word}" для ${this.settings.learningLanguageCode}.`;
							} else if (colName.includes("описание")) {
								prompt = `Дай очень краткое (3-5 слов), понятное описание слова "${rowData.word}" для изучающих ${this.settings.learningLanguageCode}.`;
							} else {
								continue;
							}
							fetchGeminiResult(prompt, this.settings.apiKey).then(
								(result) => {
									// Ограничиваем длину результата до первой строки
									const shortResult = result.split("\n")[0];
									updateRowCell(editor, uniqueId, i, shortResult);
								},
							);
						}
					},
				).open();
			},
		});
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

/* Генерация строки таблицы с добавлением языковых кодов */
function generateTableString(
	columns: string[],
	learningLanguageCode: string,
	nativeLanguageCode: string,
): string {
	// Модифицируем названия столбцов: если название содержит "Слово" или "Перевод"
	const modifiedColumns = columns.map((col) => {
		if (col.toLowerCase().includes("слово")) {
			return `${col} ${learningLanguageCode}`;
		} else if (col.toLowerCase().includes("перевод")) {
			return `${col} ${nativeLanguageCode}`;
		}
		return col;
	});
	const header = "| " + modifiedColumns.join(" | ") + " |";
	const separator = "| " + modifiedColumns.map(() => "---").join(" | ") + " |";
	const emptyRow = "| " + modifiedColumns.map(() => " ").join(" | ") + " |";
	return `${header}\n${separator}\n${emptyRow}`;
}

/* Извлечение таблиц: ищем подряд идущие строки, начинающиеся с "|" */
function extractMarkdownTables(
	content: string,
): { text: string; start: number; end: number }[] {
	const tables: { text: string; start: number; end: number }[] = [];
	const regex = /((?:^\|.*\|$\n?)+)/gm;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(content)) !== null) {
		tables.push({
			text: match[1].trim(),
			start: match.index,
			end: regex.lastIndex,
		});
	}
	return tables;
}

/* Подсчёт столбцов по первой строке */
function countTableColumns(tableText: string): number {
	const firstLine = tableText.split("\n")[0];
	const cols = firstLine
		.split("|")
		.map((cell) => cell.trim())
		.filter((cell) => cell !== "");
	return cols.length;
}

/* Проверка наличия слова в первой колонке */
function wordExistsInTable(tableText: string, word: string): boolean {
	const lines = tableText
		.split("\n")
		.filter((line) => line.trim().startsWith("|"));
	for (let i = 2; i < lines.length; i++) {
		const cells = lines[i].split("|").map((cell) => cell.trim());
		if (cells.length > 1 && cells[0].toLowerCase() === word.toLowerCase()) {
			return true;
		}
	}
	return false;
}

/* Проверка, является ли строка пустой (все ячейки пустые) */
function isEmptyRow(row: string): boolean {
	const cells = row.split("|").map((cell) => cell.trim());
	return cells.every((cell) => cell === "");
}

/* Добавление новой строки в конец таблицы */
function appendRowToTable(tableText: string, newRow: string): string {
	const lines = tableText.split("\n");
	while (lines.length > 2 && isEmptyRow(lines[lines.length - 1])) {
		lines.pop();
	}
	lines.push(newRow);
	return lines.join("\n");
}

/* Модальное окно для генерации таблицы */
class GenerateTableModal extends Modal {
	settings: LanguageTablePluginSettings;
	onSubmit: (newSettings: LanguageTablePluginSettings) => void;
	checkboxes: { [key: string]: HTMLInputElement } = {};
	// Добавляем поля для ввода языковых кодов
	learningLangCodeInput: HTMLInputElement;
	nativeLangCodeInput: HTMLInputElement;

	constructor(
		app: App,
		settings: LanguageTablePluginSettings,
		onSubmit: (newSettings: LanguageTablePluginSettings) => void,
	) {
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
		const availableColumns = [
			"Слово",
			"Перевод",
			"Транскрипция",
			"Описание",
		];
		availableColumns.forEach((col) => {
			const div = contentEl.createDiv();
			const checkbox = div.createEl("input", { type: "checkbox" });
			checkbox.checked = this.settings.columns.includes(col);
			this.checkboxes[col] = checkbox;
			div.createEl("label", { text: " " + col });
		});

		// Поля для языковых кодов
		contentEl.createEl("div", { cls: "separator" });
		this.learningLangCodeInput = contentEl.createEl("input", {
			type: "text",
			placeholder: "Код изучаемого языка (например, en)",
		});
		this.learningLangCodeInput.value =
			this.settings.learningLanguageCode || "";
		contentEl.createEl("div", { cls: "separator" });
		this.nativeLangCodeInput = contentEl.createEl("input", {
			type: "text",
			placeholder: "Код родного языка (например, ru)",
		});
		this.nativeLangCodeInput.value = this.settings.nativeLanguageCode || "";

		contentEl.createEl("div", { cls: "separator" });
		const submitButton = contentEl.createEl("button", {
			text: "Создать таблицу",
		});
		submitButton.focus();
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
			// Обновляем настройки с новыми языковыми кодами
			this.onSubmit({
				...this.settings,
				columns: selected,
				learningLanguageCode: this.learningLangCodeInput.value.trim() || "en",
				nativeLanguageCode: this.nativeLangCodeInput.value.trim() || "ru",
			});
			this.close();
		};
	}

	onClose() {
		this.contentEl.empty();
	}
}

/* Модальное окно для вставки строки в таблицу */
class InsertRowModal extends Modal {
	tables: { text: string; start: number; end: number }[];
	lastUsedIndex: number;
	onSubmit: (selectedIndex: number, data: InsertRowData) => void;
	wordInput: HTMLInputElement;
	tableSelect: HTMLSelectElement;

	constructor(
		app: App,
		tables: { text: string; start: number; end: number }[],
		lastUsedIndex: number,
		onSubmit: (selectedIndex: number, data: InsertRowData) => void,
	) {
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
			const headerSnippet =
				tableBlock.text.split("\n")[0].slice(0, 40) + "...";
			const option = this.tableSelect.createEl("option", {
				text: headerSnippet,
				value: index.toString(),
			});
			if (index === this.lastUsedIndex) {
				option.selected = true;
			}
		});
		contentEl.createEl("div", { cls: "separator" });
		const submitButton = contentEl.createEl("button", {
			text: "Добавить строку",
		});
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

/* Функция вызова Gemini API согласно предоставленному синтаксису */
async function fetchGeminiResult(
	prompt: string,
	apiKey: string,
): Promise<string> {
	try {
		const genAI = new GoogleGenerativeAI(apiKey);
		const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
		const result = await model.generateContent(prompt);
		return result.response.text().split("\n")[0].trim();
	} catch (error) {
		new Notice("Error fetching Gemini response: " + error);
		console.error("Error fetching Gemini response:", error);
		return "";
	}
}

/* Функция для обновления конкретной ячейки строки с уникальным идентификатором */
function updateRowCell(
	editor: Editor,
	uniqueId: number,
	cellIndex: number,
	newContent: string,
) {
	const content = editor.getValue();
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].includes(`<!--ID:${uniqueId}-->`)) {
			const cells = lines[i]
				.split("|")
				.slice(1, -1)
				.map((cell) => cell.trim());
			cells[cellIndex] = newContent;
			lines[i] = "| " + cells.join(" | ") + " |";
			break;
		}
	}
	editor.setValue(lines.join("\n"));
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
		containerEl.createEl("h2", {
			text: "Настройки плагина таблицы для изучения языка",
		});

		new Setting(containerEl)
			.setName("API ключ Gemini")
			.setDesc("Введите ваш API ключ для использования Gemini AI")
			.addText((text) =>
				text
					.setPlaceholder("Ваш API ключ")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Родной язык")
			.setDesc("Язык, на котором вы владеете (например, Russian)")
			.addText((text) =>
				text
					.setPlaceholder("Родной язык")
					.setValue(this.plugin.settings.nativeLanguage)
					.onChange(async (value) => {
						this.plugin.settings.nativeLanguage = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Изучаемый язык")
			.setDesc("Язык, который вы изучаете (например, English)")
			.addText((text) =>
				text
					.setPlaceholder("Изучаемый язык")
					.setValue(this.plugin.settings.learningLanguage)
					.onChange(async (value) => {
						this.plugin.settings.learningLanguage = value;
						await this.plugin.saveSettings();
					}),
			);

		// Настройка для языковых кодов
		new Setting(containerEl)
			.setName("Код изучаемого языка")
			.setDesc("Введите код изучаемого языка (например, en)")
			.addText((text) =>
				text
					.setPlaceholder("en")
					.setValue(this.plugin.settings.learningLanguageCode)
					.onChange(async (value) => {
						this.plugin.settings.learningLanguageCode = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Код родного языка")
			.setDesc("Введите код вашего родного языка (например, ru)")
			.addText((text) =>
				text
					.setPlaceholder("ru")
					.setValue(this.plugin.settings.nativeLanguageCode)
					.onChange(async (value) => {
						this.plugin.settings.nativeLanguageCode = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Столбцы таблицы")
			.setDesc(
				"Укажите через запятую названия столбцов (например: Слово, Перевод, Транскрипция, Описание)",
			)
			.addText((text) =>
				text
					.setPlaceholder("Слово, Перевод, Транскрипция, Описание")
					.setValue(this.plugin.settings.columns.join(", "))
					.onChange(async (value) => {
						this.plugin.settings.columns = value
							.split(",")
							.map((v) => v.trim())
							.filter((v) => v);
						await this.plugin.saveSettings();
					}),
			);
	}
}
