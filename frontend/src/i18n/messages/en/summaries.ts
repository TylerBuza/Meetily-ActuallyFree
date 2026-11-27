/** Messages for summary model setup, templates and Ask AI. */
const summaries = {
  // Summary model settings (Settings → Summaries)
  failedToLoadModelSettings: 'Failed to load model settings',
  failedToSaveModelSettings: 'Failed to save model settings',
  modelSettingsSaved: 'Model settings saved successfully',
  summarizeAutomatically: 'Summarize automatically',
  summarizeAutomaticallyDescription:
    'Write a summary as soon as a recording is saved. When off, generate one from the meeting page whenever you like.',
  summaryModel: 'Summary model',
  summaryModelDescription:
    'Writes summaries and answers Ask AI. Local models keep everything on this computer; a cloud provider receives the parts of a meeting it needs.',

  // Summary output language
  summaryLanguage: 'Summary Language',
  summaryLanguageDescription:
    'Pin one language as the default for new meetings. Unpinned languages remain as quick-switch options in the summary generator. Auto uses the dominant transcript language.',
  pinAsDefault: 'Pin {language} as default',
  unpinAsDefault: 'Unpin {language} as default',
  clickToSetDefault: 'Click to set as default',
  clickToUnsetDefault: 'Click to unset as default',
  removeLanguage: 'Remove {language}',
  addLanguage: '＋ Add language',
  pinnedDefaultHint: 'Default: {language} - click it again to unset. Max 5 quick-switch options.',
  defaultLanguageHint: 'Click any language to set it as your default. Max 5 quick-switch options.',

  // Custom summary template editor
  customTemplatesTitle: 'Custom summary templates',
  customTemplatesDescription: 'Choose the sections a summary has and how the model writes each one.',
  templateName: 'Template name',
  templateNamePlaceholder: 'e.g. Client discovery call',
  description: 'Description',
  descriptionPlaceholder: 'What is this template for?',
  sections: 'Sections',
  addSection: 'Add section',
  sectionTitle: 'Section title',
  sectionTitlePlaceholder: 'Section title, e.g. Action items',
  sectionFormat: 'Section format',
  removeSection: 'Remove section',
  sectionInstruction: 'Section instruction',
  sectionInstructionPlaceholder:
    'What should the model write here? e.g. List each action item with its owner.',
  clear: 'Clear',
  saveTemplate: 'Save template',
  yourTemplates: 'Your templates',
  deleteTemplate: 'Delete {name}',
  builtInTemplatesNote:
    "Built-in templates can't be deleted. Saving a template with the same name as a built-in replaces it.",
  templateNameRequired: 'Template name is required',
  templateDescriptionRequired: 'Template description is required',
  templateSectionRequired: 'Add at least one section with a title and instruction',
  templateNameInvalid: 'Template name must contain letters or numbers',
  templateSaved: 'Template "{name}" saved',
  templateDeleted: 'Deleted "{name}"',
  failedToSaveTemplate: 'Failed to save template',
  failedToDeleteTemplate: 'Failed to delete',
  builtInCannotDelete: 'Built-in templates cannot be deleted',

  // Section formats
  formatList: 'List',
  formatParagraph: 'Paragraph',
  formatTable: 'Table',
  formatSingleLine: 'Single line',

  // Language display names (codes stay untranslated)
  languageEn: 'English',
  languageZh: 'Chinese',
  languageZhTw: 'Traditional Chinese',
  languageDe: 'German',
  languageEs: 'Spanish',
  languageRu: 'Russian',
  languageKo: 'Korean',
  languageFr: 'French',
  languageJa: 'Japanese',
  languagePt: 'Portuguese',
  languageIt: 'Italian',
  languageNl: 'Dutch',
  languagePl: 'Polish',
  languageAr: 'Arabic',
  languageHi: 'Hindi',
  languageTa: 'Tamil',
  languageTr: 'Turkish',
  languageVi: 'Vietnamese',
  languageTh: 'Thai',
  languageId: 'Indonesian',
  languageSv: 'Swedish',
  languageCs: 'Czech',
  languageDa: 'Danish',
  languageFi: 'Finnish',
  languageEl: 'Greek',
  languageHe: 'Hebrew',
  languageHu: 'Hungarian',
  languageNo: 'Norwegian',
  languageRo: 'Romanian',
  languageUk: 'Ukrainian',
} as const

export default summaries
