const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const fs = require('fs');

// Dynamically look for instance_cfg.json right next to the executable/binary,
// falling back to development directory if run via `npm start`
const isPackaged = app.isPackaged;

const binaryDir = process.env.PORTABLE_EXECUTABLE_DIR
  || path.dirname(process.execPath);

const configPath = path.join(binaryDir, 'instance_cfg.json');

let config = {
  web_security: false,
  allow_any_iframes: true, // New option to allow any site to be iframed
  server: "localhost:6053",
  virt_server: "com.eagler.eaglercraft.sdappstore.virt",
  window_width: 1280,
  window_height: 720,
  kiosk: false,
  open_devtools: false,
  user_data_path: null // Optional override in instance_cfg.json
};

try {
  if (fs.existsSync(configPath)) {
    const fileData = fs.readFileSync(configPath, 'utf8');
    config = { ...config, ...JSON.parse(fileData) };
    console.log(`[Config] Loaded successfully from: ${configPath}`);
  } else {
    console.warn(`[Config] instance_cfg.json not found at ${configPath}, using defaults.`);
  }
} catch (err) {
  console.error('[Config] Error parsing instance_cfg.json:', err);
}

// 2. Set User Data Path during setup phase (Must be before app ready)
const targetUserData = config.user_data_path 
  ? (path.isAbsolute(config.user_data_path) ? config.user_data_path : path.join(binaryDir, config.user_data_path))
  : path.join(binaryDir, 'userData');

try {
  fs.mkdirSync(targetUserData, { recursive: true });
  app.setPath('userData', targetUserData);
  console.log(`[Storage] User Data directory set to: ${app.getPath('userData')}`);
} catch (err) {
  console.error('[Storage] Failed to initialize userData:', err);
  app.quit();
}

// Apply global command-line switches based on config before app is ready
if (config.web_security === false) {
  app.commandLine.appendSwitch('disable-web-security');
  app.commandLine.appendSwitch('disable-site-isolation-trials');
  console.log('[Security] Web security disabled globally via config.');
}

async function createWindow() {
  // Load Chrome Extensions from 'chrome_extensions' folder if it exists next to app
  const extensionsDir = path.join(binaryDir, 'chrome_extensions');
  if (fs.existsSync(extensionsDir)) {
    try {
      const extFolders = fs.readdirSync(extensionsDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => path.join(extensionsDir, dirent.name));

      for (const extPath of extFolders) {
        await session.defaultSession.loadExtension(extPath);
        console.log(`[Extension] Loaded extension from: ${extPath}`);
      }
    } catch (err) {
      console.error('[Extension] Failed to load extensions:', err);
    }
  }

  // Execute all .js scripts found in the 'electron_scripts' folder next to the binary
  const scriptsDir = path.join(binaryDir, 'electron_scripts');
  if (fs.existsSync(scriptsDir)) {
    try {
      const scriptFiles = fs.readdirSync(scriptsDir)
        .filter(file => file.endsWith('.js'))
        .map(file => path.join(scriptsDir, file));

      for (const scriptPath of scriptFiles) {
        try {
          // Execute custom script, passing app, session, config, etc., context if needed
          require(scriptPath);
          console.log(`[Script Runner] Executed custom script: ${scriptPath}`);
        } catch (scriptErr) {
          console.error(`[Script Runner] Error executing ${scriptPath}:`, scriptErr);
        }
      }
    } catch (err) {
      console.error('[Script Runner] Failed to read electron_scripts directory:', err);
    }
  }

  // If allow_any_iframes is enabled, intercept headers to strip/override framing blocks
  if (config.allow_any_iframes !== false) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const headers = { ...details.responseHeaders };
      
      Object.keys(headers).forEach(key => {
        const lowerKey = key.toLowerCase();
        if (
          lowerKey === 'x-frame-options' ||
          lowerKey === 'content-security-policy' ||
          lowerKey === 'content-security-policy-report-only'
        ) {
          delete headers[key];
        }
      });

      // Explicitly allow embedding by injecting permissive header
      headers['X-Frame-Options'] = ['ALLOWALL'];

      callback({ cancel: false, responseHeaders: headers });
    });
    console.log('[Security] allow_any_iframes enabled: Frame restrictions removed.');
  }

  // Create the BrowserWindow using options mapped from config
  const mainWindow = new BrowserWindow({
    width: config.window_width || 1280,
    height: config.window_height || 720,
    kiosk: config.kiosk || false,
    autoHideMenuBar: config.auto_hide_menu_bar || true,
    backgroundColor: config.background_color || '#1e1e1e',
    webPreferences: {
      webSecurity: config.web_security,
      nodeIntegration: config.node_integration || false,
      contextIsolation: config.contextIsolation ?? true,
      webviewTag: config.webview_tag || true,
    }
  });

  // Setup URL Redirection / Virtual Domain Interceptor
  const filter = {
    urls: [
      `*://${config.virt_server}/*`,
      `http://${config.virt_server}/*`,
      `https://${config.virt_server}/*`
    ]
  };

  session.defaultSession.webRequest.onBeforeRequest(filter, (details, callback) => {
    try {
      const parsedUrl = new URL(details.url);
      const targetServer = config.server.startsWith('http') ? config.server : `http://${config.server}`;
      const newUrl = `${targetServer}${parsedUrl.pathname}${parsedUrl.search}`;
      
      console.log(`[Virtual Router] Redirecting ${details.url} -> ${newUrl}`);
      callback({ redirectURL: newUrl });
    } catch (e) {
      console.error('[Virtual Router] Redirect failed:', e);
      callback({});
    }
  });

  // Load entry point
  if (config.start_url) {
    mainWindow.loadURL(config.start_url);
  } else {
    mainWindow.loadURL(`http://${config.virt_server}/index.html`);
  }

  if (config.open_devtools) {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});