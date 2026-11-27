import type { Messages } from '../en'

/** 简体中文：summary model setup, templates and Ask AI */
const summaries: Messages['summaries'] = {
  // 摘要模型设置（设置 → 摘要）
  failedToLoadModelSettings: '无法加载模型设置',
  failedToSaveModelSettings: '无法保存模型设置',
  modelSettingsSaved: '模型设置已保存',
  summarizeAutomatically: '自动生成摘要',
  summarizeAutomaticallyDescription:
    '录制保存后立即生成摘要。关闭后，可随时在会议页面手动生成。',
  summaryModel: '摘要模型',
  summaryModelDescription:
    '用于撰写摘要并回答“询问 AI”。本地模型会将一切保留在这台电脑上；使用云端服务商时，只会向其发送会议中必要的部分。',

  // 摘要输出语言
  summaryLanguage: '摘要语言',
  summaryLanguageDescription:
    '固定一种语言作为新会议的默认语言。未固定的语言会保留为摘要生成器中的快捷切换选项。“自动”会使用转写内容中的主要语言。',
  pinAsDefault: '将 {language} 设为默认',
  unpinAsDefault: '取消将 {language} 设为默认',
  clickToSetDefault: '点击设为默认',
  clickToUnsetDefault: '点击取消默认',
  removeLanguage: '移除 {language}',
  addLanguage: '＋ 添加语言',
  pinnedDefaultHint: '默认：{language}，再次点击可取消。最多 5 个快捷切换选项。',
  defaultLanguageHint: '点击任意语言将其设为默认。最多 5 个快捷切换选项。',

  // 自定义摘要模板编辑器
  customTemplatesTitle: '自定义摘要模板',
  customTemplatesDescription: '选择摘要包含哪些部分，以及模型如何撰写每个部分。',
  templateName: '模板名称',
  templateNamePlaceholder: '例如：客户需求访谈',
  description: '描述',
  descriptionPlaceholder: '这个模板用于什么场景？',
  sections: '部分',
  addSection: '添加部分',
  sectionTitle: '部分标题',
  sectionTitlePlaceholder: '部分标题，例如：行动项',
  sectionFormat: '部分格式',
  removeSection: '移除部分',
  sectionInstruction: '部分写作说明',
  sectionInstructionPlaceholder: '模型在这里应该写什么？例如：列出每个行动项及其负责人。',
  clear: '清空',
  saveTemplate: '保存模板',
  yourTemplates: '你的模板',
  deleteTemplate: '删除{name}',
  builtInTemplatesNote: '内置模板无法删除。保存与内置模板同名的模板会将其替换。',
  templateNameRequired: '请填写模板名称',
  templateDescriptionRequired: '请填写模板描述',
  templateSectionRequired: '请至少添加一个包含标题和写作说明的部分',
  templateNameInvalid: '模板名称必须包含字母或数字',
  templateSaved: '模板“{name}”已保存',
  templateDeleted: '已删除“{name}”',
  failedToSaveTemplate: '无法保存模板',
  failedToDeleteTemplate: '无法删除',
  builtInCannotDelete: '内置模板无法删除',

  // 部分格式
  formatList: '列表',
  formatParagraph: '段落',
  formatTable: '表格',
  formatSingleLine: '单行',

  // 语言显示名（语言代码保持原样）
  languageEn: '英语',
  languageZh: '中文',
  languageZhTw: '繁体中文',
  languageDe: '德语',
  languageEs: '西班牙语',
  languageRu: '俄语',
  languageKo: '韩语',
  languageFr: '法语',
  languageJa: '日语',
  languagePt: '葡萄牙语',
  languageIt: '意大利语',
  languageNl: '荷兰语',
  languagePl: '波兰语',
  languageAr: '阿拉伯语',
  languageHi: '印地语',
  languageTa: '泰米尔语',
  languageTr: '土耳其语',
  languageVi: '越南语',
  languageTh: '泰语',
  languageId: '印尼语',
  languageSv: '瑞典语',
  languageCs: '捷克语',
  languageDa: '丹麦语',
  languageFi: '芬兰语',
  languageEl: '希腊语',
  languageHe: '希伯来语',
  languageHu: '匈牙利语',
  languageNo: '挪威语',
  languageRo: '罗马尼亚语',
  languageUk: '乌克兰语',
}

export default summaries
