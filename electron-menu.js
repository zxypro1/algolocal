/**
 * 菜单模板
 *
 * 单独成一个模块是为了能被测试直接 require —— 它不碰 electron，
 * 只产出模板数据，由 electron-main.js 交给 Menu.buildFromTemplate。
 *
 * 这里最要紧的是 Edit 菜单：macOS 通过菜单项的 key equivalent 派发
 * ⌘V / ⌘C / ⌘X / ⌘A / ⌘Z，菜单里没有对应 role 的话，这些快捷键在渲染进程里
 * 就完全不生效。设置页粘不了 API key 就是这么来的，所以 tests/desktop 里
 * 有一整组用例专门盯着这些 role 别再掉。
 */

const MENU_LABELS = {
  en: {
    navigation: 'Navigation',
    home: 'Home',
    settings: 'Settings',
    aiGenerator: 'AI Generator',
    addProblem: 'Add Problem',
    edit: 'Edit',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    pasteAndMatchStyle: 'Paste and Match Style',
    delete: 'Delete',
    selectAll: 'Select All',
    find: 'Find…',
    findNext: 'Find Next',
    findPrevious: 'Find Previous',
    view: 'View',
    window: 'Window',
    help: 'Help',
    documentation: 'Documentation',
    copyLink: 'Copy Link Address',
    openLink: 'Open Link in Browser',
    copyImage: 'Copy Image',
    saveImageAs: 'Save Image As…',
    noSuggestions: 'No spelling suggestions'
  },
  zh: {
    navigation: '导航',
    home: '首页',
    settings: '设置',
    aiGenerator: 'AI 生成器',
    addProblem: '添加题目',
    edit: '编辑',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '复制',
    paste: '粘贴',
    pasteAndMatchStyle: '粘贴并匹配样式',
    delete: '删除',
    selectAll: '全选',
    find: '查找…',
    findNext: '查找下一个',
    findPrevious: '查找上一个',
    view: '视图',
    window: '窗口',
    help: '帮助',
    documentation: '文档',
    copyLink: '复制链接地址',
    openLink: '在浏览器中打开链接',
    copyImage: '复制图片',
    saveImageAs: '图片另存为…',
    noSuggestions: '没有拼写建议'
  }
};

/** 未知语言一律回落到英文，而不是抛错 */
function labelsFor(language) {
  return MENU_LABELS[language] || MENU_LABELS.en;
}

/**
 * @param {object} options
 * @param {string} options.language
 * @param {string} options.platform            process.platform
 * @param {(path: string) => void} options.navigate
 * @param {() => void} options.openDocumentation
 * @param {() => void} options.openFind
 * @param {(forward: boolean) => void} options.findAgain
 */
function buildAppMenuTemplate({
  language,
  platform,
  navigate,
  openDocumentation,
  openFind,
  findAgain
}) {
  const labels = labelsFor(language);
  const isMac = platform === 'darwin';

  return [
    // macOS 的第一个子菜单永远被当成应用菜单。不显式给出 appMenu 的话，
    // 我们的第一项（导航）会被系统顶上这个位置：标题变成进程名，
    // 而「关于 / 隐藏 / 退出」这些标准项整个消失（⌘Q 也跟着没了）。
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: labels.navigation,
      submenu: [
        { label: labels.home, click: () => navigate('/') },
        { label: labels.settings, click: () => navigate('/settings') },
        { label: labels.aiGenerator, click: () => navigate('/generator') },
        { label: labels.addProblem, click: () => navigate('/add-problem') },
        // 非 macOS 上应用菜单不存在，退出得挂在这儿
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit' }])
      ]
    },
    {
      // 少了这一整块，⌘V / ⌘C / ⌘X / ⌘A / ⌘Z 在 macOS 上全部失效。
      label: labels.edit,
      submenu: [
        { role: 'undo', label: labels.undo },
        { role: 'redo', label: labels.redo },
        { type: 'separator' },
        { role: 'cut', label: labels.cut },
        { role: 'copy', label: labels.copy },
        { role: 'paste', label: labels.paste },
        { role: 'pasteAndMatchStyle', label: labels.pasteAndMatchStyle },
        { role: 'delete', label: labels.delete },
        { role: 'selectAll', label: labels.selectAll },
        { type: 'separator' },
        // 浏览器里 ⌘F 是白送的，Electron 里得自己接 findInPage
        { label: labels.find, accelerator: 'CmdOrCtrl+F', click: () => openFind() },
        { label: labels.findNext, accelerator: 'CmdOrCtrl+G', click: () => findAgain(true) },
        { label: labels.findPrevious, accelerator: 'Shift+CmdOrCtrl+G', click: () => findAgain(false) }
      ]
    },
    {
      label: labels.view,
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      // ⌘M / ⌘W 同样是靠菜单项派发的
      label: labels.window,
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'close' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [])
      ]
    },
    {
      label: labels.help,
      role: 'help',
      submenu: [{ label: labels.documentation, click: () => openDocumentation() }]
    }
  ];
}

/**
 * 右键菜单的模板。
 *
 * Electron 不带默认上下文菜单，不自己装一个的话，输入框上右键什么都不弹——
 * 键盘快捷键之外的另一条粘贴路径同样是断的。
 *
 * @param {object} params    Electron context-menu 事件的 params
 * @param {object} labels    labelsFor() 的结果
 * @param {object} actions   { copyLink, openLink, copyImage, saveImageAs, replaceMisspelling }
 * @returns {Array} 模板；返回空数组表示这里不该弹菜单
 */
function buildContextMenuTemplate(params, labels, actions = {}) {
  const {
    isEditable = false,
    editFlags = {},
    selectionText = '',
    linkURL = '',
    mediaType = 'none',
    srcURL = '',
    misspelledWord = '',
    dictionarySuggestions = []
  } = params || {};

  const hasSelection = selectionText.trim().length > 0;
  const isImage = mediaType === 'image' && Boolean(srcURL);
  const template = [];

  // 拼写建议排在最前面，和浏览器一致。开了拼写检查却不给改正入口，
  // 等于只画红波浪线不让修。
  if (misspelledWord) {
    if (dictionarySuggestions.length === 0) {
      template.push({ label: labels.noSuggestions, enabled: false });
    } else {
      dictionarySuggestions.slice(0, 5).forEach((suggestion) => {
        template.push({
          label: suggestion,
          click: () => actions.replaceMisspelling && actions.replaceMisspelling(suggestion)
        });
      });
    }
    template.push({ type: 'separator' });
  }

  if (isEditable) {
    template.push({ role: 'cut', label: labels.cut, enabled: Boolean(editFlags.canCut) });
  }
  if (isEditable || hasSelection) {
    template.push({ role: 'copy', label: labels.copy, enabled: Boolean(editFlags.canCopy) });
  }
  if (isEditable) {
    template.push({ role: 'paste', label: labels.paste, enabled: Boolean(editFlags.canPaste) });
    template.push({ type: 'separator' });
    template.push({
      role: 'selectAll',
      label: labels.selectAll,
      enabled: Boolean(editFlags.canSelectAll)
    });
  }

  if (linkURL) {
    if (template.length) template.push({ type: 'separator' });
    template.push({ label: labels.copyLink, click: () => actions.copyLink && actions.copyLink(linkURL) });
    // 外链一律交给系统浏览器，绝不在应用窗口里导航过去
    template.push({ label: labels.openLink, click: () => actions.openLink && actions.openLink(linkURL) });
  }

  if (isImage) {
    if (template.length) template.push({ type: 'separator' });
    template.push({ label: labels.copyImage, click: () => actions.copyImage && actions.copyImage(params) });
    template.push({ label: labels.saveImageAs, click: () => actions.saveImageAs && actions.saveImageAs(srcURL) });
  }

  return template;
}

module.exports = { MENU_LABELS, labelsFor, buildAppMenuTemplate, buildContextMenuTemplate };
