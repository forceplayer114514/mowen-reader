import { contextBridge, ipcRenderer } from 'electron'
import type { BookRecord, FinishImportInput, ImportedFile } from '../shared/types'

const api = {
  listBooks: (): Promise<BookRecord[]> => ipcRenderer.invoke('books:list'),
  pickEpubFiles: (): Promise<string[]> => ipcRenderer.invoke('books:pickFiles'),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('books:pickFolder'),
  scanFolder: (dir: string): Promise<string[]> => ipcRenderer.invoke('books:scanFolder', dir),
  stageImport: (sourcePaths: string[]): Promise<ImportedFile[]> =>
    ipcRenderer.invoke('books:stageImport', sourcePaths),
  finishImport: (input: FinishImportInput): Promise<BookRecord> =>
    ipcRenderer.invoke('books:finishImport', input),
  readBookFile: (id: string): Promise<ArrayBuffer> => ipcRenderer.invoke('books:readFile', id),
  readStagedFile: (filePath: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('books:readStaged', filePath),
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
