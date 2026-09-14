export const SETTING_KEYS = {
  endpoint: 'llmEndpoint',
  model: 'llmModel',
  systemPrompt: 'llmSystemPrompt',
  contextLimit: 'llmContextLimit',
  sidebarWidth: 'sidebarWidth'
} as const

export const DEFAULT_CONTEXT_LIMIT = 8000

export const DEFAULT_SYSTEM_PROMPT = [
  '你是一个电子书阅读助手。用户正在阅读一本书,你会看到书名、作者,以及用户当前这一页的正文。',
  '',
  '回答时请遵守:',
  '- 一律用简体中文回答。',
  '- 只根据用户已经读到的内容作答,不要剧透后文情节。',
  '- 简洁直接,不要复述用户已经看得到的原文。',
  '- 用户如果划选了原文片段,优先围绕那几句回答。',
  '- 不知道就说不知道,不要编造书里没有的内容。'
].join('\n')
