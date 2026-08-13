const { app, BrowserWindow, shell, Menu, ipcMain, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createServer } = require('http');

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
const port = 3000;

let mainWindow;
let server;
let nextApp;

// Function to update the application menu
function updateApplicationMenu(language = 'en') {
  const menuLabels = {
    en: {
      navigation: 'Navigation',
      home: 'Home',
      settings: 'Settings',
      aiGenerator: 'AI Generator',
      addProblem: 'Add Problem',
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
      view: '视图',
      help: '帮助',
      documentation: '文档'
    }
  };
  
  const labels = menuLabels[language] || menuLabels.en;
  
  const menu = Menu.buildFromTemplate([
    {
      label: labels.navigation,
      submenu: [
        {
          label: labels.home,
          click: () => mainWindow && mainWindow.loadURL(`http://localhost:${port}`)
        },
        {
          label: labels.settings,
          click: () => mainWindow && mainWindow.loadURL(`http://localhost:${port}/settings`)
        },
        {
          label: labels.aiGenerator,
          click: () => mainWindow && mainWindow.loadURL(`http://localhost:${port}/generator`)
        },
        {
          label: labels.addProblem,
          click: () => mainWindow && mainWindow.loadURL(`http://localhost:${port}/add-problem`)
        }
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
      submenu: [
        {
          label: labels.documentation,
          click: () => shell.openExternal('https://github.com/zxypro1/OfflineLeetPractice')
        }
      ]
    }
  ]);
  Menu.setApplicationMenu(menu);
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
      
      return configData;
    }
  } catch (error) {
    console.error('Error loading saved configuration:', error);
  }
  return {};
}

// Start Next.js server
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
      server.listen(port, hostname, (err) => {
        if (err) {
          reject(err);
          return;
        }
        console.log(`> Ready on http://${hostname}:${port}`);
        resolve();
      });
    });
  } catch (error) {
    console.error('Failed to start Next.js server:', error);
    throw error;
  }
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
  
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
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
      spellcheck: false
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

  // Open external links in the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http') && !url.includes('localhost')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
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
