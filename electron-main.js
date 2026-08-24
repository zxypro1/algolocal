const { app, BrowserWindow, shell, Menu, ipcMain, protocol, net, dialog, clipboard, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createServer } = require('http');
// electron 的 net 已经占用了这个名字，Node 的 net 只能另起一个
const nodeNet = require('node:net');
const { labelsFor, buildAppMenuTemplate, buildContextMenuTemplate } = require('./electron-menu');
const { isInternalUrl, isSafeExternalUrl } = require('./electron-urls');

// Global error handlers
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Expose app root for Next.js API routes to locate resources correctly
// 当使用 asar 打包并配置 asarUnpack 时，解包的资源位于 app.asar.unpacked 目录
process.env.APP_ROOT = app.isPackaged 
  ? path.join(process.resourcesPath, 'app.asar.unpacked') 
  : __dirname;

// In packaged apps, always use production mode
// In development, use NODE_ENV to determine mode
const dev = app.isPackaged ? false : (process.env.NODE_ENV !== 'production');
const hostname = 'localhost';
// 首选端口。被占用时会自动往后找，实际使用的端口在启动时写回 port。
const preferredPort = 3000;
let port = preferredPort;

let mainWindow;
let server;
let nextApp;

/** 当前菜单用的那套文案，右键菜单跟着应用语言走 */
let currentMenuLabels = labelsFor('en');

/** 应用自己的页面地址（判定逻辑与用例都在 electron-urls.js） */
function isAppUrl(candidate) {
  return isInternalUrl(candidate, { hostname, port });
}

/** 只把 http(s) 交给系统浏览器；file:// javascript: 这类一律不碰 */
function openExternalSafely(candidate) {
  if (isSafeExternalUrl(candidate)) shell.openExternal(candidate);
}

// Function to update the application menu
function updateApplicationMenu(language = 'en') {
  currentMenuLabels = labelsFor(language);
  const template = buildAppMenuTemplate({
    language,
    platform: process.platform,
    navigate: (routePath) => mainWindow && mainWindow.loadURL(`http://${hostname}:${port}${routePath}`),
    openDocumentation: () => openExternalSafely('https://github.com/zxypro1/OfflineLeetPractice'),
    openFind: () => mainWindow && mainWindow.webContents.send('find:open'),
    findAgain: (forward) => mainWindow && mainWindow.webContents.send('find:again', forward)
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** 装上右键菜单：键盘快捷键之外的另一条剪切/复制/粘贴路径 */
function attachContextMenu(webContents) {
  webContents.on('context-menu', (_event, params) => {
    const template = buildContextMenuTemplate(params, currentMenuLabels, {
      copyLink: (url) => clipboard.writeText(url),
      openLink: (url) => openExternalSafely(url),
      copyImage: (p) => webContents.copyImageAt(p.x, p.y),
      saveImageAs: (url) => saveImageAs(webContents, url),
      replaceMisspelling: (word) => webContents.replaceMisspelling(word)
    });
    if (template.length === 0) return;
    // 窗口可能在右键和弹出之间被关掉，fromWebContents 这时返回 null
    const window = BrowserWindow.fromWebContents(webContents);
    if (!window) return;
    Menu.buildFromTemplate(template).popup({ window });
  });
}

/**
 * 「图片另存为」。
 *
 * downloadURL 触发 will-download，默认行为是直接落到下载目录、不问用户。
 * 这里给这一次下载挂上保存对话框，走完就把标记清掉。
 */
// 按地址记，而不是一个全局布尔：万一同时有别的下载在跑，
// 布尔会被那一次消费掉，对话框就弹到错误的文件上了。
const pendingSaveAs = new Set();
function saveImageAs(webContents, url) {
  pendingSaveAs.add(url);
  webContents.downloadURL(url);
}

/**
 * 下载行为。
 *
 * 浏览器里点下载会弹「保存到哪里」，Electron 不接这个事件的话会静默存到
 * 默认目录，用户完全不知道文件去哪了。
 */
let downloadHandlerAttached = false;
function attachDownloadHandler(session) {
  // session 是全局共享的；createWindow 可能再跑一次（macOS 上关窗后重新激活），
  // 重复注册会让同一次下载弹两个对话框。
  if (downloadHandlerAttached) return;
  downloadHandlerAttached = true;

  session.on('will-download', (_event, item) => {
    if (pendingSaveAs.has(item.getURL())) {
      pendingSaveAs.delete(item.getURL());
      const suggested = item.getFilename();
      const target = dialog.showSaveDialogSync(mainWindow, { defaultPath: suggested });
      if (!target) {
        item.cancel();
        return;
      }
      item.setSavePath(target);
    }
    item.once('done', (_e, state) => {
      if (state === 'completed') {
        shell.showItemInFolder(item.getSavePath());
      }
    });
  });
}

/**
 * 导航守卫。
 *
 * setWindowOpenHandler 只管 window.open / target=_blank；普通 <a href> 点击走的是
 * will-navigate。不拦的话，AI 回答或题解 markdown 里的外链会把整个应用窗口导航走，
 * 而这个窗口没有地址栏也没有后退键，用户就出不来了。
 */
function attachNavigationGuards(webContents) {
  webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openExternalSafely(url);
  });

  webContents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) return { action: 'allow' };
    openExternalSafely(url);
    return { action: 'deny' };
  });
}

// Load saved configuration
function loadSavedConfig() {
  try {
    const configPath = path.join(os.homedir(), '.offline-leet-practice', 'config.json');
    if (fs.existsSync(configPath)) {
      const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      
      // Set environment variables for AI providers
      if (configData.deepSeek) {
        if (configData.deepSeek.apiKey) process.env.DEEPSEEK_API_KEY = configData.deepSeek.apiKey;
        if (configData.deepSeek.model) process.env.DEEPSEEK_MODEL = configData.deepSeek.model;
        if (configData.deepSeek.timeout) process.env.DEEPSEEK_API_TIMEOUT = configData.deepSeek.timeout;
        if (configData.deepSeek.maxTokens) process.env.DEEPSEEK_MAX_TOKENS = configData.deepSeek.maxTokens;
      }
      
      if (configData.openAI) {
        if (configData.openAI.apiKey) process.env.OPENAI_API_KEY = configData.openAI.apiKey;
        if (configData.openAI.model) process.env.OPENAI_MODEL = configData.openAI.model;
      }
      
      if (configData.qwen) {
        if (configData.qwen.apiKey) process.env.QWEN_API_KEY = configData.qwen.apiKey;
        if (configData.qwen.model) process.env.QWEN_MODEL = configData.qwen.model;
      }
      
      if (configData.claude) {
        if (configData.claude.apiKey) process.env.CLAUDE_API_KEY = configData.claude.apiKey;
        if (configData.claude.model) process.env.CLAUDE_MODEL = configData.claude.model;
      }
      
      if (configData.ollama) {
        if (configData.ollama.endpoint) process.env.OLLAMA_ENDPOINT = configData.ollama.endpoint;
        if (configData.ollama.model) process.env.OLLAMA_MODEL = configData.ollama.model;
      }

      if (configData.compatible) {
        if (configData.compatible.endpoint) process.env.OPENAI_COMPATIBLE_ENDPOINT = configData.compatible.endpoint;
        if (configData.compatible.model) process.env.OPENAI_COMPATIBLE_MODEL = configData.compatible.model;
        if (configData.compatible.apiKey) process.env.OPENAI_COMPATIBLE_API_KEY = configData.compatible.apiKey;
      }
      
      return configData;
    }
  } catch (error) {
    console.error('Error loading saved configuration:', error);
  }
  return {};
}

// Start Next.js server
function isPortFree(candidate) {
  return new Promise((resolve) => {
    const probe = nodeNet.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(candidate, hostname);
  });
}

// 3000 是开发机上最容易被别的项目占掉的端口。占用时不该让应用起不来，
// 往后找一个空闲端口即可。
async function findFreePort(preferred, attempts = 20) {
  for (let candidate = preferred; candidate < preferred + attempts; candidate += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(candidate)) {
      return candidate;
    }
  }
  throw new Error(`No free port available in range ${preferred}-${preferred + attempts - 1}`);
}

async function startNextServer() {
  try {
    // Load configuration first
    loadSavedConfig();
    
    // Get the correct directory path for Next.js
    let nextDir = __dirname;
    if (app.isPackaged) {
      // In packaged app, use the app path directly (asar disabled)
      nextDir = app.getAppPath();
    }
    
    // Dynamically require next to handle potential issues
    const next = require('next');

    port = await findFreePort(preferredPort);
    if (port !== preferredPort) {
      console.log(`> Port ${preferredPort} is in use, falling back to ${port}`);
    }

    nextApp = next({ 
      dev, 
      hostname, 
      port,
      dir: nextDir 
    });
    
    const nextHandler = nextApp.getRequestHandler();
    
    await nextApp.prepare();
    
    server = createServer(async (req, res) => {
      try {
        await nextHandler(req, res);
      } catch (error) {
        console.error('Error occurred handling', req.url, error);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end('internal server error');
        }
      }
    });
    
    // Listen for server errors
    server.on('error', (error) => {
      console.error('Server error:', error);
    });
    
    server.on('clientError', (error, socket) => {
      console.error('Client error:', error);
    });

    return new Promise((resolve, reject) => {
      // server.listen() 失败时错误走的是 'error' 事件，回调根本不会被调用。
      // 只在回调里 resolve/reject 会让这个 Promise 永远悬着，
      // 于是 await 不返回、createWindow() 永远不执行——表现就是「进程活着但没有窗口」。
      const onListenError = (error) => reject(error);
      server.once('error', onListenError);

      server.listen(port, hostname, (err) => {
        if (err) {
          server.removeListener('error', onListenError);
          reject(err);
          return;
        }
        server.removeListener('error', onListenError);
        console.log(`> Ready on http://${hostname}:${port}`);
        resolve();
      });
    });
  } catch (error) {
    console.error('Failed to start Next.js server:', error);
    throw error;
  }
}

const CONFIG_PATH = path.join(os.homedir(), '.offline-leet-practice', 'config.json');

function readConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (error) {
    console.error('Error reading config:', error);
  }
  return {};
}

/**
 * 记住窗口大小和位置。
 *
 * 浏览器会替你记住窗口几何，Electron 每次都从默认值重开。
 * 存之前先跟当前显示器比一下：外接屏拔掉之后，旧坐标会把窗口开到屏幕外。
 */
function persistWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
  try {
    const config = readConfig();
    config.windowBounds = { ...mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized() };
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (error) {
    console.error('Error saving window bounds:', error);
  }
}

/** 落在任何一块屏幕里才用，否则回落到默认居中 */
function restoredWindowBounds() {
  const saved = readConfig().windowBounds;
  if (!saved || typeof saved.width !== 'number' || typeof saved.height !== 'number') return null;

  const visible = screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return (
      saved.x >= area.x - 50 &&
      saved.y >= area.y - 50 &&
      saved.x + saved.width <= area.x + area.width + 50 &&
      saved.y + saved.height <= area.y + area.height + 50
    );
  });
  return visible ? saved : null;
}

let savedThemePref = 'light';

function createWindow() {
  // Load theme preference
  try {
    const configPath = path.join(os.homedir(), '.offline-leet-practice', 'config.json');
    if (fs.existsSync(configPath)) {
      const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (configData.theme) {
        savedThemePref = configData.theme;
      }
    }
  } catch (error) {
    console.error('Error loading theme preference:', error);
  }
  
  const restored = restoredWindowBounds();

  mainWindow = new BrowserWindow({
    width: restored?.width ?? 1400,
    height: restored?.height ?? 900,
    ...(restored && typeof restored.x === 'number' ? { x: restored.x, y: restored.y } : {}),
    minWidth: 1000,
    minHeight: 700,
    title: 'AlgoLocal',
    backgroundColor: savedThemePref === 'dark' ? '#11182f' : '#FFFFFF',
    // 使用默认标题栏，避免红绿灯按钮与内容重叠
    titleBarStyle: 'default',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'electron-preload.js'),
      webSecurity: true,
      // 浏览器里输入框天然有拼写检查，关掉等于桌面端平白少一项
      spellcheck: true
    },
    icon: path.join(__dirname, 'public', 'icon.png'),
    show: false // Don't show until ready
  });

  // Load saved language preference
  let savedLanguage = 'en';
  try {
    const configPath = path.join(os.homedir(), '.offline-leet-practice', 'config.json');
    if (fs.existsSync(configPath)) {
      const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (configData.language) {
        savedLanguage = configData.language;
      }
    }
  } catch (error) {
    console.error('Error loading preferences:', error);
  }
  
  // Update the application menu with the saved language
  updateApplicationMenu(savedLanguage);

  // 右键菜单：键盘快捷键之外的另一条剪切/复制/粘贴路径
  attachContextMenu(mainWindow.webContents);

  // 外链走系统浏览器，不在应用窗口里导航
  attachNavigationGuards(mainWindow.webContents);

  // 下载要弹保存对话框，而不是静默落盘
  attachDownloadHandler(mainWindow.webContents.session);

  // 查找命中数回传给查找栏
  mainWindow.webContents.on('found-in-page', (_event, result) => {
    if (mainWindow) {
      mainWindow.webContents.send('find:result', {
        activeMatchOrdinal: result.activeMatchOrdinal,
        matches: result.matches
      });
    }
  });

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    if (restored?.maximized) mainWindow.maximize();
    mainWindow.show();
  });

  // 拖动/缩放停下来之后再写盘，别每一帧都写
  let boundsTimer = null;
  const scheduleBoundsSave = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(persistWindowBounds, 400);
  };
  mainWindow.on('resize', scheduleBoundsSave);
  mainWindow.on('move', scheduleBoundsSave);
  mainWindow.on('close', () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    persistWindowBounds();
  });

  // Load the app
  const loadUrl = `http://${hostname}:${port}`;
  mainWindow.loadURL(loadUrl);
  
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// App ready event
app.whenReady().then(async () => {
  try {
    // Start Next.js server first
    await startNextServer();
    
    // Then create the window
    createWindow();
  } catch (error) {
    console.error('Failed to start application:', error);
    dialog.showErrorBox(
      'AlgoLocal could not start',
      `The local server failed to start.\n\n${error && error.message ? error.message : error}`
    );
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    cleanup();
    app.quit();
  }
});

app.on('before-quit', () => {
  cleanup();
});

function cleanup() {
  if (server) {
    server.close(() => {
      console.log('Server closed');
    });
  }
}

// 页内查找：菜单发 find:open 给渲染进程，渲染进程把关键词回传到这里
ipcMain.handle('find:query', (_event, text, options) => {
  if (!mainWindow || !text) return false;
  mainWindow.webContents.findInPage(text, options || {});
  return true;
});

ipcMain.handle('find:stop', () => {
  if (mainWindow) mainWindow.webContents.stopFindInPage('clearSelection');
  return true;
});

// IPC event handlers for configuration management
ipcMain.handle('save-config', async (event, configData) => {
  try {
    const configDir = path.join(os.homedir(), '.offline-leet-practice');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    const configPath = path.join(configDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(configData, null, 2));
    
    // Reload environment variables
    loadSavedConfig();
    
    // Update menu if language changed
    if (configData.language) {
      updateApplicationMenu(configData.language);
    }
    
    return { success: true };
  } catch (error) {
    console.error('Error saving configuration:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('load-config', async () => {
  try {
    const configPath = path.join(os.homedir(), '.offline-leet-practice', 'config.json');
    
    if (fs.existsSync(configPath)) {
      const configData = fs.readFileSync(configPath, 'utf8');
      return { success: true, data: JSON.parse(configData) };
    } else {
      return { success: true, data: {} };
    }
  } catch (error) {
    console.error('Error loading configuration:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('set-language', async (event, language) => {
  try {
    let configData = {};
    const configPath = path.join(os.homedir(), '.offline-leet-practice', 'config.json');
    
    if (fs.existsSync(configPath)) {
      configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
    
    configData.language = language;
    
    const configDir = path.join(os.homedir(), '.offline-leet-practice');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    fs.writeFileSync(configPath, JSON.stringify(configData, null, 2));
    updateApplicationMenu(language);
    
    return { success: true };
  } catch (error) {
    console.error('Error setting language:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('set-theme', async (event, theme) => {
  try {
    let configData = {};
    const configPath = path.join(os.homedir(), '.offline-leet-practice', 'config.json');
    
    if (fs.existsSync(configPath)) {
      configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
    
    configData.theme = theme;
    
    const configDir = path.join(os.homedir(), '.offline-leet-practice');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    fs.writeFileSync(configPath, JSON.stringify(configData, null, 2));
    
    if (mainWindow) {
      mainWindow.setBackgroundColor(theme === 'dark' ? '#1A1B1E' : '#FFFFFF');
    }
    
    return { success: true };
  } catch (error) {
    console.error('Error setting theme:', error);
    return { success: false, error: error.message };
  }
});
