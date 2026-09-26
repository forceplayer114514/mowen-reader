import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ setMenu: vi.fn() }))
vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/reader-menu-test',
    setPath: vi.fn(), setName: vi.fn(), on: vi.fn(),
    whenReady: () => Promise.resolve(),
    isPackaged: true
  },
  BrowserWindow: vi.fn(function () {
    return { once: vi.fn(), loadURL: vi.fn(), loadFile: vi.fn() }
  }),
  Menu: { setApplicationMenu: mocks.setMenu },
  safeStorage: {}
}))
vi.mock('../../src/main/ipc', () => ({ registerIpc: vi.fn(), abortAllChats: vi.fn() }))
vi.mock('../../src/main/paths', () => ({ initDataDir: vi.fn() }))
vi.mock('../../src/main/secrets', () => ({ initSecrets: vi.fn() }))

const platform = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform })
  vi.resetModules()
  mocks.setMenu.mockClear()
})

it('Windows 启动时移除默认应用菜单，而不是仅仅隐藏', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  await import('../../src/main/index')
  expect(mocks.setMenu).toHaveBeenCalledWith(null)
})

it('macOS 不移除系统菜单，以保留退出和编辑快捷键', async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  await import('../../src/main/index')
  expect(mocks.setMenu).not.toHaveBeenCalled()
})
