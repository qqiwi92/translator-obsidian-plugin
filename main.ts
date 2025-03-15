import {
	App,
	Editor,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	requestUrl,
} from "obsidian";
import { GoogleGenerativeAI } from "@google/generative-ai";

// settings interface
interface LanguageTablePluginSettings {
	apiKey: string;
	nativeLanguage: string; // User's native language (full name)
	learningLanguage: string; // Language being learned (full name)
	nativeLanguageCode: string; // Native language code (e.g., ru)
	learningLanguageCode: string; // Learning language code (e.g., en)
	columns: string[]; // ["Word", "Translation", "Transcription", "Description"]
	aiProvider: "gemini" | "ollama"; // New: choose between Gemini and Ollama
	localModelName: string;
}

const DEFAULT_SETTINGS: LanguageTablePluginSettings = {
	apiKey: "",
	nativeLanguage: "Russian",
	learningLanguage: "English",
	nativeLanguageCode: "ru",
	learningLanguageCode: "en",
	columns: ["Word", "Translation", "Transcription", "Description"],
	aiProvider: "gemini",
	localModelName: "gemma3:1b",
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
			name: "Generate Language Learning Table",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				new GenerateTableModal(
					this.app,
					this.settings,
					(newSettings: LanguageTablePluginSettings) => {
						this.settings = newSettings;
						this.saveSettings();
						const table = generateTableString(
							newSettings.columns,
							newSettings.learningLanguageCode,
							newSettings.nativeLanguageCode,
						);
						editor.replaceSelection(table + "\n");
						new Notice("Table generated.");
					},
				).open();
			},
		});

		this.addCommand({
			id: "insert-word-row",
			name: "Insert New Word Row",
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				const content = editor.getValue();
				const tables = extractMarkdownTables(content);
				if (tables.length === 0) {
					new Notice("No tables found in the document.");
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
							new Notice(
								"This word already exists in the table.",
							);
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
						// Replace only the table block
						const updatedContent =
							content.slice(0, tableBlock.start) +
							updatedTable +
							content.slice(tableBlock.end);
						editor.setValue(updatedContent);
						new Notice(
							"Row added with placeholders. " +
								this.settings.nativeLanguage +
								" " +
								this.settings.learningLanguage,
						);

						// AI updating for each non-word column
						for (let i = 1; i < numCols; i++) {
							const colName = this.settings.columns[i]
								? this.settings.columns[i].toLowerCase()
								: "";

							let prompt = "";
							if (colName.toLowerCase().includes("translation")) {
								prompt = `Translate the word "${rowData.word}" from ${this.settings.learningLanguage}(${this.settings.learningLanguageCode}) to ${this.settings.nativeLanguage}(${this.settings.nativeLanguageCode}) in one or two words, just translate without explanations.`;
							} else if (
								colName.toLowerCase().includes("transcription")
							) {
								prompt = `Provide the phonetic transcription of the word "${rowData.word}" for ${this.settings.learningLanguage}(${this.settings.learningLanguageCode}) using a format like /dɒɡ/.`;
							} else if (
								colName.toLowerCase().includes("description")
							) {
								prompt = `Give a very brief (3-5 words) description of the word "${rowData.word}" for learners of ${this.settings.learningLanguage}(${this.settings.learningLanguageCode})`;
							} else {
								continue;
							}
							fetchAiResult(
								prompt,
								this.settings.apiKey,
								this.settings.aiProvider,
								this.settings.localModelName,
							).then((result) => {
								const shortResult = result.split("\n")[0];
								updateRowCell(editor, uniqueId, i, shortResult);
							});
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

function generateTableString(
	columns: string[],
	learningLanguageCode: string,
	nativeLanguageCode: string,
): string {
	const modifiedColumns = columns.map((col) => {
		if (col.toLowerCase().includes("word")) {
			return `${col} ${learningLanguageCode}`;
		} else if (col.toLowerCase().includes("translation")) {
			return `${col} ${nativeLanguageCode}`;
		}
		return col;
	});
	const header = "| " + modifiedColumns.join(" | ") + " |";
	const separator =
		"| " + modifiedColumns.map(() => "---").join(" | ") + " |";
	const emptyRow = "| " + modifiedColumns.map(() => " ").join(" | ") + " |";
	return `${header}\n${separator}\n${emptyRow}`;
}

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

function countTableColumns(tableText: string): number {
	const firstLine = tableText.split("\n")[0];
	const cols = firstLine
		.split("|")
		.map((cell) => cell.trim())
		.filter((cell) => cell !== "");
	return cols.length;
}

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

function isEmptyRow(row: string): boolean {
	const cells = row.split("|").map((cell) => cell.trim());
	return cells.every((cell) => cell === "");
}

function appendRowToTable(tableText: string, newRow: string): string {
	const lines = tableText.split("\n");
	while (lines.length > 2 && isEmptyRow(lines[lines.length - 1])) {
		lines.pop();
	}
	lines.push(newRow);
	return lines.join("\n");
}

async function fetchAiResult(
	prompt: string,
	apiKey: string,
	aiProvider: "gemini" | "ollama",
	model: string,
): Promise<string> {
	if (aiProvider === "ollama") {
		try {
			const response = await requestUrl({
				url: "http://127.0.0.1:11434/api/generate",
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: model,
					prompt: prompt,
					stream: false,
				}),
			});
			return response.json.response.split("\n")[0].trim();
		} catch (error) {
			new Notice("Error fetching Ollama response: " + error);
			console.error("Error fetching Ollama response:", error);
			return "";
		}
	} else {
		// Gemini: using GoogleGenerativeAI
		try {
			const genAI = new GoogleGenerativeAI(apiKey);
			const model = genAI.getGenerativeModel({
				model: "gemini-1.5-flash",
			});
			const result = await model.generateContent(prompt);
			return result.response.text().split("\n")[0].trim();
		} catch (error) {
			new Notice("Error fetching Gemini response: " + error);
			console.error("Error fetching Gemini response:", error);
			return "";
		}
	}
}

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

class GenerateTableModal extends Modal {
	settings: LanguageTablePluginSettings;
	onSubmit: (newSettings: LanguageTablePluginSettings) => void;
	checkboxes: { [key: string]: HTMLInputElement } = {};

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
		contentEl.createEl("h2", { text: "Table Generation" });
		contentEl.createEl("p", { text: "Select columns for the table:" });
		contentEl.createEl("div", { cls: "separator" });
		const availableColumns = [
			...new Set([
				...this.settings.columns,
				"Word",
				"Translation",
				"Transcription",
				"Description",
			]),
		];
		availableColumns.forEach((col) => {
			const div = contentEl.createDiv();
			const checkbox = div.createEl("input", { type: "checkbox" });
			checkbox.checked = this.settings.columns.includes(col);
			this.checkboxes[col] = checkbox;
			div.createEl("label", { text: " " + col });
		});
		contentEl.createEl("div", { cls: "separator" });
		const submitButton = contentEl.createEl("button", {
			text: "Create Table",
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
				new Notice("Please select at least one column.");
				return;
			}
			this.onSubmit({
				...this.settings,
				columns: selected,
			});
			this.close();
		};
	}

	onClose() {
		this.contentEl.empty();
	}
}

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
		contentEl.createEl("h2", { text: "Insert Row into Table" });
		const wordDiv = contentEl.createDiv();
		wordDiv.createEl("label", { text: "New word:" });
		this.wordInput = wordDiv.createEl("input", {
			type: "text",
			cls: "take-full-width",
		});
		contentEl.createEl("div", { cls: "separator" });
		const selectDiv = contentEl.createDiv();
		selectDiv.createEl("label", { text: "Select a table:" });
		this.tableSelect = selectDiv.createEl("select", {
			cls: "take-full-width",
		});
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
		const submitButton = contentEl.createEl("button", { text: "Add Row" });
		submitButton.onclick = () => {
			const word = this.wordInput.value.trim();
			if (!word) {
				new Notice("Please enter a word.");
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
			text: "Language Learning Table Plugin Settings",
		});

		new Setting(containerEl)
			.setName("Gemini API Key")
			.setDesc("Enter your API key to use Gemini AI")
			.addText((text) =>
				text
					.setPlaceholder("Your API key")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("AI Provider")
			.setDesc(
				"Select which AI provider to use: Gemini (cloud) or Ollama (local)",
			)
			.addDropdown((drop) => {
				drop.addOption("gemini", "Gemini");
				drop.addOption("ollama", "Ollama");
				drop.setValue(this.plugin.settings.aiProvider);
				drop.onChange(async (value: "gemini" | "ollama") => {
					this.plugin.settings.aiProvider = value;
					await this.plugin.saveSettings();
				});
			});
		new Setting(containerEl)
			.setName("Name of local model")
			.setDesc(
				"Enter the name of your local model (gemma3:1b is recommended)",
			)
			.addText((text) => {
				text.setPlaceholder("Name of local model")
					.setValue(this.plugin.settings.localModelName)
					.onChange(async (value) => {
						this.plugin.settings.localModelName = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Languages")
			.setDesc(
				"Enter your native language and the language you are learning with their codes. Format: Native Language (code), Learning Language (code)",
			)
			.addText((text) =>
				text
					.setPlaceholder("Russian (ru), English (en)")
					.setValue(
						`${this.plugin.settings.nativeLanguage} (${this.plugin.settings.nativeLanguageCode}), ${this.plugin.settings.learningLanguage} (${this.plugin.settings.learningLanguageCode})`,
					)
					.onChange(async (value) => {
						const parts = value.split(",");
						if (parts.length !== 2) {
							new Notice(
								"Please enter both languages separated by a comma.",
							);
							return;
						}
						const nativePart = parts[0].trim();
						const learningPart = parts[1].trim();
						const nativeMatch =
							nativePart.match(/^(.*?)\s*\((.*?)\)$/);
						const learningMatch =
							learningPart.match(/^(.*?)\s*\((.*?)\)$/);
						if (!nativeMatch || !learningMatch) {
							new Notice(
								"Please use the format: Native Language (code), Learning Language (code)",
							);
							return;
						}
						this.plugin.settings.nativeLanguage =
							nativeMatch[1].trim();
						this.plugin.settings.nativeLanguageCode =
							nativeMatch[2].trim();
						this.plugin.settings.learningLanguage =
							learningMatch[1].trim();
						this.plugin.settings.learningLanguageCode =
							learningMatch[2].trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Table Columns")
			.setDesc(
				"Specify the column names separated by commas (e.g., Word, Translation, Transcription, Description)",
			)
			.addText((text) =>
				text
					.setPlaceholder(
						"Word, Translation, Transcription, Description",
					)
					.setValue(this.plugin.settings.columns.join(", "))
					.onChange(async (value) => {
						this.plugin.settings.columns = [... new Set([...value
							.split(",")
							.map((v) => v.trim())
							.filter((v) => v), 'Word', 'Translation'])];
						await this.plugin.saveSettings();
					}),
			);
	}
}
