import { Titlebar, TitlebarColor } from 'custom-electron-titlebar'
import { colorBgContainer, colorBgContainerDark } from 'common/theme'
import getUrlParam from 'licia/getUrlParam'
import isMac from 'licia/isMac'
import $ from 'licia/$'
import type { MirrorHeading } from 'common/types'
import mainObj from './main'
import { webUtils } from 'electron'

let titleBar: Titlebar

window.addEventListener('DOMContentLoaded', async () => {
  const isCustomTitleBar = await mainObj.isCustomTitlebar()
  if (isCustomTitleBar) {
    titleBar = new Titlebar({
      containerOverflow: 'hidden',
    })
    const $body = $('body')
    $body.addClass('custom-titlebar')
    if (getUrlParam('page') && !isMac) {
      $body.addClass('hide-cet-menubar')
    }
  }

  updateTheme()
  mainObj.on('updateTheme', updateTheme)
})

async function updateTheme() {
  const theme = await mainObj.getTheme()
  if (theme === 'dark') {
    document.body.classList.add('-theme-with-dark-background')
  } else {
    document.body.classList.remove('-theme-with-dark-background')
  }
  const isCustomTitlebar = await mainObj.isCustomTitlebar()
  if (isCustomTitlebar) {
    const backgroundColor = TitlebarColor.fromHex(
      theme === 'dark' ? colorBgContainerDark : colorBgContainer
    )
    ;(titleBar as any).currentOptions.menuBarBackgroundColor = backgroundColor
    titleBar.updateBackground(backgroundColor)
  }
}

mainObj.on('mergedMirrorLabel', (label: MirrorHeading | null, toolInset: number, headerHeight: number) => {
  const root = document.documentElement
  const heading = document.getElementById('merged-mirror-label')
  // The host resends the label on did-finish-load when attaching during navigation.
  if (!heading) return
  heading.replaceChildren()
  heading.title = label ? [label.name, label.detail].filter(Boolean).join(' · ') : ''
  heading.hidden = !label
  if (label) {
    const name = document.createElement('span')
    name.textContent = label.name
    heading.append(name)
    if (label.detail) {
      const detail = document.createElement('small')
      detail.textContent = label.detail
      heading.append(detail)
    }
    root.dataset.mirrorLabel = heading.title
    root.style.setProperty('--mirror-header-height', headerHeight + 'px')
    root.style.setProperty('--mirror-tool-inset', toolInset + 'px')
  } else {
    delete root.dataset.mirrorLabel
    root.style.removeProperty('--mirror-tool-inset')
    root.style.removeProperty('--mirror-header-height')
  }
})

mainObj.on('refreshMenu', () => {
  if (titleBar) {
    titleBar.refreshMenu()
  }
})

export default {
  setTitle: (title: string) => {
    document.title = title
    if (titleBar) {
      titleBar.updateTitle(title)
    }
  },
  getPathForFile: (file: File) => {
    return webUtils.getPathForFile(file)
  },
}
