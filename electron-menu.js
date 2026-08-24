/**
 * 菜单模板
 *
 * 单独成一个模块是为了能被测试直接 require —— 它不碰 electron，
 * 只产出模板数据，由 electron-main.js 交给 Menu.buildFromTemplate。
 *
 * 这里最要紧的是 Edit 菜单：macOS 通过菜单项的 key equivalent 派发
 * ⌘V / ⌘C / ⌘X / ⌘A / ⌘Z，菜单里没有对应 role 的话，这些快捷键在渲染进程里
 * 就完全不生效。设置页粘不了 API key 就是这么来的，所以 tests/desktop 里
 * 有一条用例专门盯着它别再掉。
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
    selectAll: 'Select All',
    view: 'View',
    help: 'Help',
    documentation: 'Documentation'
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
    selectAll: '全选',
    view: '视图',
    help: '帮助',
    documentation: '文档'
  }
};

/** 未知语言一律回落到英文，而不是抛错 */
function labelsFor(language) {
  return MENU_LABELS[language] || MENU_LABELS.en;
}

/**
 * @param {object} options
 * @param {string} options.language
 * @param {string} options.platform          process.platform
 * @param {(path: string) => void} options.navigate
 * @param {() => void} options.openDocumentation
 */
function buildAppMenuTemplate({ language, platform, navigate, openDocumentation }) {
  const labels = labelsFor(language);
  const isMac = platform === 'darwin';

  return [
    // macOS 的第一个子菜单永远被当成应用菜单。不显式给出 appMenu 的话，
    // 我们的第一项（导航）会被系统顶上这个位置：标题变成进程名，
    // 而「关于 / 隐藏 / 退出」这些标准项整个消失。
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: labels.navigation,
      submenu: [
        { label: labels.home, click: () => navigate('/') },
        { label: labels.settings, click: () => navigate('/settings') },
        { label: labels.aiGenerator, click: () => navigate('/generator') },
        { label: labels.addProblem, click: () => navigate('/add-problem') }
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
        { role: 'selectAll', label: labels.selectAll }
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
      label: labels.help,
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
 * @param {object} params  Electron context-menu 事件的 params
 * @param {object} labels  labelsFor() 的结果
 * @returns {Array} 模板；返回空数组表示这里不该弹菜单
 */
function buildContextMenuTemplate(params, labels) {
  const { isEditable = false, editFlags = {}, selectionText = '' } = params || {};
  const hasSelection = selectionText.trim().length > 0;

  // 只在有意义的地方弹：可编辑区域，或者选中了文本想复制
  if (!isEditable && !hasSelection) return [];

  const template = [];
  if (isEditable) {
    template.push({ role: 'cut', label: labels.cut, enabled: Boolean(editFlags.canCut) });
  }
  template.push({ role: 'copy', label: labels.copy, enabled: Boolean(editFlags.canCopy) });
  if (isEditable) {
    template.push({ role: 'paste', label: labels.paste, enabled: Boolean(editFlags.canPaste) });
    template.push({ type: 'separator' });
    template.push({
      role: 'selectAll',
      label: labels.selectAll,
      enabled: Boolean(editFlags.canSelectAll)
    });
  }
  return template;
}

module.exports = { MENU_LABELS, labelsFor, buildAppMenuTemplate, buildContextMenuTemplate };
