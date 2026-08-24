/**
 * 桌面端菜单与右键菜单
 *
 * 这些用例的由来：应用菜单里一直没有 Edit 菜单，于是 macOS 上 ⌘V 在渲染进程里
 * 完全不生效（系统是靠菜单项的 key equivalent 派发它的），用户在设置页粘不了
 * API key。同一类问题还牵出 Window 菜单缺失（⌘M / ⌘W 失效）、应用菜单被顶掉
 * （⌘Q 失效），以及 Electron 根本不带默认右键菜单。
 *
 * 每一项都有用例盯着，掉了要红。
 */

const {
  labelsFor,
  buildAppMenuTemplate,
  buildContextMenuTemplate
} = require('../../electron-menu');

const baseOptions = {
  language: 'en',
  platform: 'darwin',
  navigate: () => {},
  openDocumentation: () => {},
  openFind: () => {},
  findAgain: () => {}
};

/** 把模板拍平成 role 列表，方便断言 */
function rolesIn(submenu) {
  return (submenu || []).map((item) => item.role).filter(Boolean);
}

function menuNamed(template, label) {
  return template.find((entry) => entry.label === label);
}

function itemWithAccelerator(submenu, accelerator) {
  return submenu.find((item) => item.accelerator === accelerator);
}

describe('application menu', () => {
  it('has an Edit menu carrying every standard editing role', () => {
    const edit = menuNamed(buildAppMenuTemplate(baseOptions), 'Edit');

    expect(edit).toBeDefined();
    // 这些 role 就是 ⌘Z / ⇧⌘Z / ⌘X / ⌘C / ⌘V / ⌘A 的归属
    expect(rolesIn(edit.submenu)).toEqual([
      'undo',
      'redo',
      'cut',
      'copy',
      'paste',
      'pasteAndMatchStyle',
      'delete',
      'selectAll'
    ]);
  });

  it('binds paste through a role rather than a hand-rolled click handler', () => {
    const edit = menuNamed(buildAppMenuTemplate(baseOptions), 'Edit');
    const paste = edit.submenu.find((item) => item.role === 'paste');

    // role 自带 accelerator 与原生行为；换成 click 就等于把 ⌘V 重新丢掉
    expect(paste).toBeDefined();
    expect(paste.click).toBeUndefined();
  });

  it('puts the macOS app menu first so Navigation keeps its own slot', () => {
    const template = buildAppMenuTemplate(baseOptions);

    // 不占住第一格的话，导航菜单会被系统顶成应用菜单：
    // 标题变进程名，「关于 / 隐藏 / 退出」（含 ⌘Q）一并消失
    expect(template[0]).toEqual({ role: 'appMenu' });
    expect(menuNamed(template, 'Navigation')).toBeDefined();
  });

  it('omits the macOS-only app menu on other platforms', () => {
    const template = buildAppMenuTemplate({ ...baseOptions, platform: 'win32' });

    expect(template.some((entry) => entry.role === 'appMenu')).toBe(false);
    expect(template[0].label).toBe('Navigation');
    expect(menuNamed(template, 'Edit')).toBeDefined();
  });

  it('gives non-mac platforms a Quit item, since they have no app menu', () => {
    const nav = menuNamed(buildAppMenuTemplate({ ...baseOptions, platform: 'win32' }), 'Navigation');

    expect(rolesIn(nav.submenu)).toContain('quit');
  });

  it('has a Window menu so the window shortcuts reach the window', () => {
    const windowMenu = menuNamed(buildAppMenuTemplate(baseOptions), 'Window');

    expect(windowMenu).toBeDefined();
    expect(rolesIn(windowMenu.submenu)).toEqual(['minimize', 'zoom', 'close', 'front']);
  });

  it('drops the macOS-only front role off mac', () => {
    const windowMenu = menuNamed(
      buildAppMenuTemplate({ ...baseOptions, platform: 'linux' }),
      'Window'
    );

    expect(rolesIn(windowMenu.submenu)).toEqual(['minimize', 'zoom', 'close']);
  });

  it('keeps the full View menu', () => {
    const view = menuNamed(buildAppMenuTemplate(baseOptions), 'View');

    expect(rolesIn(view.submenu)).toEqual([
      'reload',
      'forceReload',
      'toggleDevTools',
      'resetZoom',
      'zoomIn',
      'zoomOut',
      'togglefullscreen'
    ]);
  });

  it('localises the Edit menu with the rest of the UI', () => {
    const edit = menuNamed(buildAppMenuTemplate({ ...baseOptions, language: 'zh' }), '编辑');

    expect(edit).toBeDefined();
    expect(edit.submenu.find((item) => item.role === 'paste').label).toBe('粘贴');
    // 换了语言也不能把 role 丢了，否则中文界面下 ⌘V 又会失效
    expect(rolesIn(edit.submenu)).toContain('paste');
  });

  it('falls back to English for an unknown language', () => {
    expect(labelsFor('fr')).toBe(labelsFor('en'));
    expect(menuNamed(buildAppMenuTemplate({ ...baseOptions, language: 'fr' }), 'Edit')).toBeDefined();
  });

  it('keeps every navigation entry wired to a route', () => {
    const visited = [];
    const nav = menuNamed(
      buildAppMenuTemplate({ ...baseOptions, navigate: (p) => visited.push(p) }),
      'Navigation'
    );
    nav.submenu.filter((item) => item.click).forEach((item) => item.click());

    expect(visited).toEqual(['/', '/settings', '/generator', '/add-problem']);
  });
});

describe('find in page', () => {
  it('wires the find accelerators, since Electron gives no find for free', () => {
    const edit = menuNamed(buildAppMenuTemplate(baseOptions), 'Edit');

    expect(itemWithAccelerator(edit.submenu, 'CmdOrCtrl+F')).toBeDefined();
    expect(itemWithAccelerator(edit.submenu, 'CmdOrCtrl+G')).toBeDefined();
    expect(itemWithAccelerator(edit.submenu, 'Shift+CmdOrCtrl+G')).toBeDefined();
  });

  it('calls openFind when Find is picked', () => {
    let opened = 0;
    const edit = menuNamed(
      buildAppMenuTemplate({ ...baseOptions, openFind: () => (opened += 1) }),
      'Edit'
    );
    itemWithAccelerator(edit.submenu, 'CmdOrCtrl+F').click();

    expect(opened).toBe(1);
  });

  it('passes the search direction through to findAgain', () => {
    const directions = [];
    const edit = menuNamed(
      buildAppMenuTemplate({ ...baseOptions, findAgain: (forward) => directions.push(forward) }),
      'Edit'
    );
    itemWithAccelerator(edit.submenu, 'CmdOrCtrl+G').click();
    itemWithAccelerator(edit.submenu, 'Shift+CmdOrCtrl+G').click();

    expect(directions).toEqual([true, false]);
  });
});

describe('context menu', () => {
  const labels = labelsFor('en');
  const allFlags = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true };

  it('offers paste on an editable field', () => {
    const template = buildContextMenuTemplate(
      { isEditable: true, editFlags: allFlags, selectionText: '' },
      labels
    );

    expect(rolesIn(template)).toEqual(['cut', 'copy', 'paste', 'selectAll']);
    expect(template.find((item) => item.role === 'paste').enabled).toBe(true);
  });

  it('mirrors the editFlags so unavailable actions render greyed out', () => {
    const template = buildContextMenuTemplate(
      {
        isEditable: true,
        editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: false },
        selectionText: ''
      },
      labels
    );

    expect(template.find((item) => item.role === 'paste').enabled).toBe(true);
    expect(template.find((item) => item.role === 'cut').enabled).toBe(false);
    expect(template.find((item) => item.role === 'selectAll').enabled).toBe(false);
  });

  it('offers copy only when read-only text is selected', () => {
    const template = buildContextMenuTemplate(
      { isEditable: false, editFlags: { canCopy: true }, selectionText: 'hello' },
      labels
    );

    // 不可编辑的地方给 paste 是没有意义的
    expect(rolesIn(template)).toEqual(['copy']);
  });

  it('stays closed on a plain right-click with nothing to act on', () => {
    expect(
      buildContextMenuTemplate({ isEditable: false, editFlags: {}, selectionText: '   ' }, labels)
    ).toEqual([]);
  });

  it('offers link actions on a link', () => {
    const copied = [];
    const opened = [];
    const template = buildContextMenuTemplate(
      { isEditable: false, editFlags: {}, selectionText: '', linkURL: 'https://example.com/x' },
      labels,
      { copyLink: (u) => copied.push(u), openLink: (u) => opened.push(u) }
    );
    template.filter((item) => item.click).forEach((item) => item.click());

    expect(template.map((item) => item.label).filter(Boolean)).toEqual([
      'Copy Link Address',
      'Open Link in Browser'
    ]);
    expect(copied).toEqual(['https://example.com/x']);
    expect(opened).toEqual(['https://example.com/x']);
  });

  it('offers image actions on an image', () => {
    const saved = [];
    const template = buildContextMenuTemplate(
      { mediaType: 'image', srcURL: 'https://example.com/a.png', editFlags: {}, selectionText: '' },
      labels,
      { copyImage: () => {}, saveImageAs: (u) => saved.push(u) }
    );
    template.find((item) => item.label === 'Save Image As…').click();

    expect(template.map((item) => item.label).filter(Boolean)).toEqual([
      'Copy Image',
      'Save Image As…'
    ]);
    expect(saved).toEqual(['https://example.com/a.png']);
  });

  it('combines editable and link entries when a link sits in a text field', () => {
    const template = buildContextMenuTemplate(
      { isEditable: true, editFlags: allFlags, selectionText: '', linkURL: 'https://example.com' },
      labels,
      {}
    );

    expect(rolesIn(template)).toEqual(['cut', 'copy', 'paste', 'selectAll']);
    expect(template.some((item) => item.label === 'Copy Link Address')).toBe(true);
  });

  it('localises alongside the application menu', () => {
    const template = buildContextMenuTemplate(
      { isEditable: true, editFlags: allFlags, selectionText: '' },
      labelsFor('zh')
    );

    expect(template.find((item) => item.role === 'paste').label).toBe('粘贴');
  });

  it('survives a params object with fields missing', () => {
    expect(() => buildContextMenuTemplate({}, labels)).not.toThrow();
    expect(buildContextMenuTemplate({}, labels)).toEqual([]);
  });

  it('offers spelling corrections on a misspelled word', () => {
    const replaced = [];
    const template = buildContextMenuTemplate(
      {
        isEditable: true,
        editFlags: allFlags,
        selectionText: '',
        misspelledWord: 'teh',
        dictionarySuggestions: ['the', 'ten', 'tea']
      },
      labels,
      { replaceMisspelling: (w) => replaced.push(w) }
    );
    template[0].click();

    // 建议排在最前，紧跟一条分隔线，然后才是常规编辑项
    expect(template.slice(0, 3).map((item) => item.label)).toEqual(['the', 'ten', 'tea']);
    expect(template[3]).toEqual({ type: 'separator' });
    expect(replaced).toEqual(['the']);
    expect(rolesIn(template)).toEqual(['cut', 'copy', 'paste', 'selectAll']);
  });

  it('says so when a misspelling has no suggestions', () => {
    const template = buildContextMenuTemplate(
      { isEditable: true, editFlags: allFlags, misspelledWord: 'zzxq', dictionarySuggestions: [] },
      labels
    );

    expect(template[0]).toEqual({ label: 'No spelling suggestions', enabled: false });
  });

  it('caps the suggestion list so the menu stays usable', () => {
    const template = buildContextMenuTemplate(
      {
        isEditable: true,
        editFlags: allFlags,
        misspelledWord: 'x',
        dictionarySuggestions: ['a', 'b', 'c', 'd', 'e', 'f', 'g']
      },
      labels
    );

    expect(template.filter((item) => /^[a-g]$/.test(item.label || '')).length).toBe(5);
  });

  it('does not blow up when no action handlers are supplied', () => {
    const template = buildContextMenuTemplate(
      { linkURL: 'https://example.com', editFlags: {}, selectionText: '' },
      labels
    );

    expect(() => template.forEach((item) => item.click && item.click())).not.toThrow();
  });
});
