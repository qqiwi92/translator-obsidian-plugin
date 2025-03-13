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

// Plugin settings interface
interface LanguageTablePluginSettings {
	apiKey: string;
	nativeLanguage: string; // User's native language (full name)
	learningLanguage: string; // Language being learned (full name)
	nativeLanguageCode: string; // Native language code (e.g., ru)
	learningLanguageCode: string; // Learning language code (e.g., en)
	columns: string[]; // For example, ["Word", "Translation", "Transcription", "Description"]
}

const DEFAULT_SETTINGS: LanguageTablePluginSettings = {
	apiKey: "",
	nativeLanguage: "Russian",
	learningLanguage: "English",
	nativeLanguageCode: "ru",
	learningLanguageCode: "en",
	columns: ["Word", "Translation", "Transcription", "Description"],
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
						// Pass language codes to table generation
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
							new Notice("This word already exists in the table.");
							return;
						}

						const numCols = countTableColumns(tableBlock.text);
						const uniqueId = Date.now();
						const cells: string[] = [];
						for (let i = 0; i < numCols; i++) {
							if (i === 0) {
								cells.push(`${rowData.word}<!--ID:${uniqueId}-->`);
							} else {
								cells.push("loading");
							}
						}
						const newRow = "| " + cells.join(" | ") + " |";
						const updatedTable = appendRowToTable(
							tableBlock.text,
							newRow,
						);
						// Update only the table block, leaving the rest of the text untouched
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

						// Update cells asynchronously
						for (let i = 1; i < numCols; i++) {
							const colName = this.settings.columns[i]
								? this.settings.columns[i].toLowerCase()
								: "";
							let prompt = "";
							if (colName.includes("translation")) {
								prompt = `Translate the word "${rowData.word}" from ${this.settings.learningLanguageCode} to ${this.settings.nativeLanguageCode} in one or two words, just translate, do not explain or put something in braces like this 'кот (kot)' `;
							} else if (colName.includes("transcription")) {
								prompt = `Provide the phonetic transcription of the word "${rowData.word}" for ${this.settings.learningLanguageCode}. only in this syntax /dɒɡ/ nothing more.`;
							} else if (colName.includes("description")) {
								prompt = `Give a very brief (3-5 words), clear description of the word "${rowData.word}" for learners of ${this.settings.learningLanguageCode}.`;
							} else {
								continue;
							}
							fetchGeminiResult(prompt, this.settings.apiKey).then(
								(result) => {
									// Limit the result to the first line
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

/* Generate table row string with language codes */
function generateTableString(
	columns: string[],
	learningLanguageCode: string,
	nativeLanguageCode: string,
): string {
	// Modify column names: if the name contains "Word" or "Translation"
	const modifiedColumns = columns.map((col) => {
		if (col.toLowerCase().includes("word")) {
			return `${col} ${learningLanguageCode}`;
		} else if (col.toLowerCase().includes("translation")) {
			return `${col} ${nativeLanguageCode}`;
		}
		return col;
	});
	const header = "| " + modifiedColumns.join(" | ") + " |";
	const separator = "| " + modifiedColumns.map(() => "---").join(" | ") + " |";
	const emptyRow = "| " + modifiedColumns.map(() => " ").join(" | ") + " |";
	return `${header}\n${separator}\n${emptyRow}`;
}

/* Extract Markdown tables: search for consecutive lines starting with "|" */
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

/* Count columns using the first row */
function countTableColumns(tableText: string): number {
	const firstLine = tableText.split("\n")[0];
	const cols = firstLine
		.split("|")
		.map((cell) => cell.trim())
		.filter((cell) => cell !== "");
	return cols.length;
}

/* Check if the word exists in the first column */
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

/* Check if a row is empty (all cells are empty) */
function isEmptyRow(row: string): boolean {
	const cells = row.split("|").map((cell) => cell.trim());
	return cells.every((cell) => cell === "");
}

/* Append a new row to the end of the table */
function appendRowToTable(tableText: string, newRow: string): string {
	const lines = tableText.split("\n");
	while (lines.length > 2 && isEmptyRow(lines[lines.length - 1])) {
		lines.pop();
	}
	lines.push(newRow);
	return lines.join("\n");
}

/* Modal for table generation */
class GenerateTableModal extends Modal {
	settings: LanguageTablePluginSettings;
	onSubmit: (newSettings: LanguageTablePluginSettings) => void;
	checkboxes: { [key: string]: HTMLInputElement } = {};
	// Fields for language codes
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
		contentEl.createEl("h2", { text: "Table Generation" });
		contentEl.createEl("p", { text: "Select columns for the table:" });
		contentEl.createEl("div", { cls: "separator" });
		const availableColumns = [
			"Word",
			"Translation",
			"Transcription",
			"Description",
		];
		availableColumns.forEach((col) => {
			const div = contentEl.createDiv();
			const checkbox = div.createEl("input", { type: "checkbox" });
			checkbox.checked = this.settings.columns.includes(col);
			this.checkboxes[col] = checkbox;
			div.createEl("label", { text: " " + col });
		});

		// Fields for language codes are now handled in a combined setting in the plugin settings
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
			// Update settings with the current language codes (already set via the combined input)
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

/* Modal for inserting a row into a table */
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
		this.wordInput = wordDiv.createEl("input", { type: "text" });
		this.wordInput.style.width = "100%";
		contentEl.createEl("div", { cls: "separator" });
		const selectDiv = contentEl.createDiv();
		selectDiv.createEl("label", { text: "Select a table:" });
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
			text: "Add Row",
		});
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

/* Function to call the Gemini API according to the provided syntax */
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

/* Function to update a specific cell in a row with a unique identifier */
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

/* Plugin settings – Settings Tab */
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
			.setName("Languages")
			.setDesc(
				"Enter your native language and the language you are learning with their codes. Format: Native Language (code), Learning Language (code)"
			)
			.addText((text) =>
				text
					.setPlaceholder("Russian (ru), English (en)")
					.setValue(
						`${this.plugin.settings.nativeLanguage} (${this.plugin.settings.nativeLanguageCode}), ${this.plugin.settings.learningLanguage} (${this.plugin.settings.learningLanguageCode})`
					)
					.onChange(async (value) => {
						const parts = value.split(",");
						if (parts.length !== 2) {
							new Notice("Please enter both languages separated by a comma.");
							return;
						}
						const nativePart = parts[0].trim();
						const learningPart = parts[1].trim();
						const nativeMatch = nativePart.match(/^(.*?)\s*\((.*?)\)$/);
						const learningMatch = learningPart.match(/^(.*?)\s*\((.*?)\)$/);
						if (!nativeMatch || !learningMatch) {
							new Notice(
								"Please use the format: Native Language (code), Learning Language (code)"
							);
							return;
						}
						this.plugin.settings.nativeLanguage = nativeMatch[1].trim();
						this.plugin.settings.nativeLanguageCode = nativeMatch[2].trim();
						this.plugin.settings.learningLanguage = learningMatch[1].trim();
						this.plugin.settings.learningLanguageCode = learningMatch[2].trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Table Columns")
			.setDesc(
				"Specify the column names separated by commas (e.g., Word, Translation, Transcription, Description)"
			)
			.addText((text) =>
				text
					.setPlaceholder("Word, Translation, Transcription, Description")
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
