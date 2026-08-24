/**
 * 桌面端菜单
 *
 * 这些用例的由来：应用菜单里一直没有 Edit 菜单，于是 macOS 上 ⌘V 在渲染进程里
 * 完全不生效（系统是靠菜单项的 key equivalent 派发它的），用户在设置页粘不了
 * API key。Electron 也不带默认右键菜单，所以「右键 → 粘贴」这条后备路径同样是断的。
 *
 * 两条路径各自都有用例盯着，掉了要红。
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
  openDocumentation: () => {}
};

/** 把模板拍平成 role 列表，方便断言 */
function rolesIn(submenu) {
  return (submenu || []).map((item) => item.role).filter(Boolean);
}

function menuNamed(template, label) {
  return template.find((entry) => entry.label === label);
}

describe('application menu', () => {
  it('has an Edit menu carrying the standard editing roles', () => {
    const template = buildAppMenuTemplate(baseOptions);
    const edit = menuNamed(template, 'Edit');

    expect(edit).toBeDefined();
    // 这些 role 就是 ⌘Z / ⇧⌘Z / ⌘X / ⌘C / ⌘V / ⌘A 的归属
    expect(rolesIn(edit.submenu)).toEqual([
      'undo',
      'redo',
      'cut',
      'copy',
      'paste',
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
    // 标题变进程名，「关于 / 隐藏 / 退出」一并消失
    expect(template[0]).toEqual({ role: 'appMenu' });
    expect(menuNamed(template, 'Navigation')).toBeDefined();
  });

  it('omits the macOS-only app menu on other platforms', () => {
    const template = buildAppMenuTemplate({ ...baseOptions, platform: 'win32' });

    expect(template.some((entry) => entry.role === 'appMenu')).toBe(false);
    expect(template[0].label).toBe('Navigation');
    expect(menuNamed(template, 'Edit')).toBeDefined();
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
    const template = buildAppMenuTemplate({ ...baseOptions, navigate: (p) => visited.push(p) });
    menuNamed(template, 'Navigation').submenu.forEach((item) => item.click());

    expect(visited).toEqual(['/', '/settings', '/generator', '/add-problem']);
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
});
