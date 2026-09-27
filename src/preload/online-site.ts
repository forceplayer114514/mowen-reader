import { ipcRenderer } from 'electron'

// No API is exposed to the website. Script-created clicks cannot grant navigation permission.
function openClickedLink(event: MouseEvent): void {
  if (!event.isTrusted || event.defaultPrevented || (event.type === 'click' ? event.button !== 0 : event.button !== 1)) return
  const link = event.composedPath().find(node => node instanceof HTMLAnchorElement) as HTMLAnchorElement | undefined
  const href = link?.getAttribute('href')?.trim()
  if (!link || !href || href.startsWith('#')) return
  if (!URL.canParse(link.href)) return
  const url = new URL(link.href)
  if (!['https:', 'http:'].includes(url.protocol)) return
  // ponytail: native HTTP navigation skips click-ad scripts; hash/JS-only controls stay with the site.
  event.preventDefault()
  event.stopImmediatePropagation()
  ipcRenderer.send('online:open-link', { url: url.href, download: link.hasAttribute('download') })
}

window.addEventListener('click', openClickedLink, true)
window.addEventListener('auxclick', openClickedLink, true)
