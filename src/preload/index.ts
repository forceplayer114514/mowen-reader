import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { BookRecord, FinishImportInput, ImportedFile } from '../shared/types'

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
    ipcRenderer.invoke('settings:set', key, value)
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
