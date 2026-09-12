import { contextBridge } from 'electron'

const api = {
  ping: (): string => 'pong'
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
