'use strict';

/**
 * Electron 껍데기.
 *
 * 하는 일은 세 가지뿐이다. 게임 규칙은 web/room.js에, LAN 발견과 호스트 선출은
 * electron/peer.js에 있다. 여기는 창을 띄우고 그 둘을 이어 주기만 한다.
 *   1. peer를 시작한다 (UDP 55500으로 서로를 찾고, 뽑히면 TCP 55500에 게임 서버를 켠다)
 *   2. 창을 띄우고 web/public/index.html을 연다
 *   3. 붙어야 할 서버 주소가 바뀌면 창에 알려 준다
 *
 * web/ 아래 코드는 Electron을 전혀 모른다. 그래야 브라우저로도 계속 돌아가고, 문제가
 * 생겼을 때 Electron 문제인지 게임 문제인지 바로 갈린다.
 */

const path = require('path');
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { createPeer, DEFAULT_PORT } = require('./peer');
const { createUiServer } = require('./ui-server');
const { log, error, LOG_PATH } = require('../logger');

const PORT = Number(process.env.LIAR_PORT) || DEFAULT_PORT;

let mainWindow = null;
let peer = null;
let uiServer = null;
let uiPort = null;

function sendStatus(status) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('server-changed', status.serverUrl);
}

function createWindow() {
  if (!uiPort) {
    error('[Electron] 화면 서버가 준비되지 않았습니다.');
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 820,
    minHeight: 560,
    title: 'Slack',
    autoHideMenuBar: true,
    backgroundColor: '#F5F5F7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // file:// 이 아니라 http://127.0.0.1 로 띄운다. 그래야 다른 PC(호스트)의 WebSocket에
  // 붙을 때 브라우저 엔진의 출처 제약에 걸리지 않는다.
  mainWindow.loadURL(`http://127.0.0.1:${uiPort}/`);

  // 창 안에서 외부 링크를 열면 앱이 그 페이지로 넘어가 버린다. 기본 브라우저로 보낸다.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-finish-load', () => {
    if (peer) sendStatus(peer.status());
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// 같은 PC에서 두 번 실행해도 막지 않는다. 게임 통신이 TCP(WebSocket)라서,
// 예전 LAN 버전처럼 "제시어가 한쪽에만 도착하는" 문제가 생기지 않는다.
// 오히려 한 PC에서 둘을 띄워 테스트할 수 있어 편하다.

app.whenReady().then(async () => {
  uiServer = createUiServer();
  uiPort = await uiServer.start();

  peer = createPeer({ port: PORT, onStatus: sendStatus });
  peer.start();
  log(`[Electron] 시작 (게임 포트 ${PORT}, 화면 포트 ${uiPort}, 로그: ${LOG_PATH})`);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

ipcMain.handle('get-status', () => (peer ? peer.status() : null));

app.on('window-all-closed', async () => {
  if (peer) await peer.stop();
  if (uiServer) uiServer.stop();
  app.quit();
});

process.on('uncaughtException', (err) => {
  // 창이 없는 빌드에서는 콘솔이 안 보이므로 로그 파일에 반드시 남긴다.
  error(`[치명적 오류] ${err.stack || err.message}`);
});
