import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AppendMessageInput,
  BookRecord,
  ChatDoneResult,
  ConversationRecord,
  ConversationWithCount,
  CreateConversationInput,
  FinishImportInput,
  ImportedFile,
  MessageRecord,
  StartChatInput
} from '../shared/types'

const api = {
  listBooks: (): Promise<BookRecord[]> => ipcRenderer.invoke('books:list'),
  pickEpubFiles: (): Promise<string[]> => ipcRenderer.invoke('books:pickFiles'),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('books:pickFolder'),
  scanFolder: (dir: string): Promise<string[]> => ipcRenderer.invoke('books:scanFolder', dir),
  stageImport: (sourcePaths: string[]): Promise<ImportedFile[]> =>
    ipcRenderer.invoke('books:stageImport', sourcePaths),
  stageDroppedFiles: (paths: string[]): Promise<ImportedFile[]> =>
    ipcRenderer.invoke('books:stageDropped', paths),
  // webUtils.getPathForFile 是 Electron 32 起替代 File.path 的方式,在
  // contextIsolation + sandbox 都开启的渲染进程里可用,但只能在 preload 里调用
  // 后经 contextBridge 转出去——渲染层自己拿不到这个模块。
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  finishImport: (input: FinishImportInput): Promise<BookRecord> =>
    ipcRenderer.invoke('books:finishImport', input),
  readBookFile: (id: string): Promise<ArrayBuffer> => ipcRenderer.invoke('books:readFile', id),
  readCover: (id: string): Promise<ArrayBuffer | null> =>
    ipcRenderer.invoke('books:readCover', id),
  readStagedFile: (id: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('books:readStaged', id),
  discardStagedFile: (id: string): Promise<void> =>
    ipcRenderer.invoke('books:discardStaged', id),
  deleteBook: (id: string): Promise<void> => ipcRenderer.invoke('books:delete', id),
  saveProgress: (id: string, cfi: string): Promise<void> =>
    ipcRenderer.invoke('books:saveProgress', id, cfi),
  getLocations: (id: string): Promise<string | null> =>
    ipcRenderer.invoke('books:getLocations', id),
  saveLocations: (id: string, json: string): Promise<void> =>
    ipcRenderer.invoke('books:saveLocations', id, json),
  getSetting: (key: string): Promise<string | null> => ipcRenderer.invoke('settings:get', key),
  setSetting: (key: string, value: string): Promise<void> =>
    ipcRenderer.invoke('settings:set', key, value),
  // 仅端到端测试使用:主进程只在 READER_E2E=1 时注册这个通道,其余环境下调用会被拒绝。
  testImportPaths: (paths: string[]): Promise<string[]> =>
    ipcRenderer.invoke('test:importPaths', paths),

  listConversations: (bookId: string): Promise<ConversationWithCount[]> =>
    ipcRenderer.invoke('chat:listConversations', bookId),
  createConversation: (input: CreateConversationInput): Promise<ConversationRecord> =>
    ipcRenderer.invoke('chat:createConversation', input),
  setConversationMerge: (id: string, mergedEndCfi: string | null): Promise<void> =>
    ipcRenderer.invoke('chat:setConversationMerge', id, mergedEndCfi),
  deleteConversations: (ids: string[]): Promise<void> =>
    ipcRenderer.invoke('chat:deleteConversations', ids),
  listMessages: (conversationId: string): Promise<MessageRecord[]> =>
    ipcRenderer.invoke('chat:listMessages', conversationId),
  appendMessage: (input: AppendMessageInput): Promise<MessageRecord> =>
    ipcRenderer.invoke('chat:appendMessage', input),

  // hasApiKey 只回答有没有设过,不会、也不能返回密钥内容——密钥只在主进程
  // 的 secrets 模块里存在,没有任何通道把它送出主进程。
  hasApiKey: (): Promise<boolean> => ipcRenderer.invoke('secrets:hasApiKey'),
  setApiKey: (key: string): Promise<void> => ipcRenderer.invoke('secrets:setApiKey', key),
  clearApiKey: (): Promise<void> => ipcRenderer.invoke('secrets:clearApiKey'),

  startChat: (input: StartChatInput): Promise<string> => ipcRenderer.invoke('chat:start', input),
  abortChat: (requestId: string): Promise<void> => ipcRenderer.invoke('chat:abort', requestId),
  // 事件订阅返回取消函数,不把 ipcRenderer 的原始 event 对象透给渲染层。
  onChatChunk: (cb: (requestId: string, text: string) => void): (() => void) => {
    const handler = (_e: unknown, requestId: string, text: string): void => cb(requestId, text)
    ipcRenderer.on('chat:chunk', handler)
    return () => ipcRenderer.off('chat:chunk', handler)
  },
  onChatDone: (cb: (requestId: string, result: ChatDoneResult) => void): (() => void) => {
    const handler = (_e: unknown, requestId: string, result: ChatDoneResult): void =>
      cb(requestId, result)
    ipcRenderer.on('chat:done', handler)
    return () => ipcRenderer.off('chat:done', handler)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
