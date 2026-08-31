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
const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, session, shell } = require('electron');
const { createPeer, DEFAULT_PORT } = require('./peer');
const { createUiServer } = require('./ui-server');
const { log, error, LOG_PATH } = require('../logger');

const PORT = Number(process.env.LIAR_PORT) || DEFAULT_PORT;

let mainWindow = null;
let splashWindow = null;
let tray = null;
let blinkTimer = null;
let peer = null;
let uiServer = null;
let uiPort = null;

// [요청] 창을 내려 둔 사이에 온 것을 알린다. 트레이 아이콘이 깜빡이는 주기.
const BLINK_MS = 600;
// 로딩 화면을 너무 빨리 지우면 번쩍하고 만다. 최소 이만큼은 보여준다.
const SPLASH_MIN_MS = 700;

function sendStatus(status) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('server-changed', status.serverUrl);
}

/** [E-2] 버전이 다른 인스턴스를 봤다는 것을 화면에 알린다. */
function sendNotice(notice) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('notice', notice);
}

/**
 * [요청] 창을 내려 둔 사이에 대화가 오거나 내 차례가 되면 알린다.
 *
 * 두 가지를 같이 쓴다. 작업 표시줄 깜빡임(flashFrame)은 Windows가 "주목해 달라"는
 * 표준 방식이고, 트레이 아이콘 깜빡임은 작업 표시줄을 숨겨 둔 사람에게도 보인다.
 * 트레이 아이콘은 눌러서 창을 다시 여는 통로이기도 하다.
 *
 * 창을 다시 보는 순간(focus/restore/show) 둘 다 끈다.
 */
function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
  if (icon.isEmpty()) return; // 아이콘을 못 읽으면 트레이 없이 간다(앱은 계속 돈다)
  // 트레이는 작은 아이콘이다. 원본 그대로 넣으면 OS에 따라 뭉개진다.
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  log('[Electron] 트레이 아이콘 준비');
  tray.setToolTip('Slack');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '열기', click: showMainWindow },
    { type: 'separator' },
    { label: '종료', click: () => { app.quit(); } },
  ]));
  tray.on('click', showMainWindow);
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** 창이 이미 눈앞에 있으면 알릴 이유가 없다. */
function needsAttention() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  return mainWindow.isMinimized() || !mainWindow.isVisible() || !mainWindow.isFocused();
}

function startAttention() {
  if (!needsAttention()) return;
  mainWindow.flashFrame(true);
  if (!tray || blinkTimer) return;
  const onIcon = nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 16, height: 16 });
  const offIcon = nativeImage.createEmpty();
  let on = false;
  blinkTimer = setInterval(() => {
    on = !on;
    try { tray.setImage(on ? offIcon : onIcon); } catch { /* 트레이가 사라진 뒤 */ }
  }, BLINK_MS);
}

function stopAttention() {
  if (blinkTimer) { clearInterval(blinkTimer); blinkTimer = null; }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.flashFrame(false);
  if (!tray) return;
  const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
  try { tray.setImage(icon.resize({ width: 16, height: 16 })); } catch { /* 트레이가 사라진 뒤 */ }
}

/**
 * [요청] 앱을 켜면 곧바로 뜨는 로딩 화면.
 *
 * 예전에는 창이 뜨고 나서 화면이 그려질 때까지 흰 화면이 잠깐 남았다. 그 사이
 * 사용자는 앱이 켜진 건지 알 수 없다. 본 창은 준비될 때까지 숨겨 두고(show:false)
 * 이 창을 먼저 보여준 뒤, 본 화면이 다 그려지면 바꿔치기한다.
 *
 * 화면 서버(127.0.0.1)로 띄운다. file://로 띄우면 CSP에 걸려 스타일이 죽는다.
 */
function createSplash() {
  splashWindow = new BrowserWindow({
    width: 380,
    height: 260,
    frame: false,
    resizable: false,
    movable: false,
    show: false,
    center: true,
    skipTaskbar: true,
    backgroundColor: '#3F0E40',
    title: 'Slack',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splashWindow.loadURL(`http://127.0.0.1:${uiPort}/loading.html`);
  splashWindow.once('ready-to-show', () => {
    if (!splashWindow || splashWindow.isDestroyed()) return;
    splashWindow.show();
    log('[Electron] 로딩 화면 표시');
  });
}

function closeSplash() {
  if (!splashWindow || splashWindow.isDestroyed()) { splashWindow = null; return; }
  splashWindow.destroy();
  splashWindow = null;
  log('[Electron] 로딩 화면 닫음 - 본 화면으로');
}

function createWindow() {
  if (!uiPort) {
    error('[Electron] 화면 서버가 준비되지 않았습니다.');
    return;
  }

  mainWindow = new BrowserWindow({
    // 기본 Electron 로고 대신 이 앱의 아이콘. (tools/make-icon.js로 만든다)
    icon: path.join(__dirname, 'icon.png'),
    width: 1100,
    height: 720,
    minWidth: 820,
    minHeight: 560,
    title: 'Slack',
    // 로딩 화면을 먼저 보여주고, 다 그려지면 이 창으로 바꾼다.
    show: false,
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

  const openedAt = Date.now();
  mainWindow.webContents.on('did-finish-load', () => {
    if (peer) sendStatus(peer.status());
    // 로딩 화면이 번쩍하고 사라지지 않게 최소 시간은 채운다.
    const wait = Math.max(0, SPLASH_MIN_MS - (Date.now() - openedAt));
    setTimeout(() => {
      closeSplash();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
    }, wait);
  });

  // 화면을 못 띄우는 상황에서도 창은 반드시 보여야 한다. 로딩 화면에 갇히지 않게.
  mainWindow.webContents.on('did-fail-load', () => {
    closeSplash();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });

  // 창을 다시 보면 알림을 끈다.
  for (const ev of ['focus', 'restore', 'show']) mainWindow.on(ev, stopAttention);

  mainWindow.on('closed', () => { mainWindow = null; });
}

// 같은 PC에서 두 번 실행해도 막지 않는다. 게임 통신이 TCP(WebSocket)라서,
// 예전 LAN 버전처럼 "제시어가 한쪽에만 도착하는" 문제가 생기지 않는다.
// 오히려 한 PC에서 둘을 띄워 테스트할 수 있어 편하다.

app.whenReady().then(async () => {
  // 이 앱은 바깥 인터넷에 나갈 일이 전혀 없다. 오직 같은 LAN의 호스트와 이 PC의 화면
  // 서버에만 붙는다. 그런데 회사 PC처럼 시스템 프록시가 걸려 있으면 Chromium이 LAN
  // 주소까지 프록시로 보내 버리고, 프록시는 그걸 거절한다(실제로 403이 떨어진다).
  //   WebSocket connection to 'ws://192.0.2.2:55500/' failed:
  //   Error during WebSocket handshake: Unexpected response code: 403
  // 그러면 "내 화면은 되는데(루프백은 프록시를 안 탄다) 남에게는 안 붙는" 증상이 된다.
  // 프록시를 아예 타지 않도록 못 박는다.
  try {
    await session.defaultSession.setProxy({ mode: 'direct' });
  } catch (err) {
    error(`[프록시 설정 실패] ${err.message} - 사내 프록시가 있으면 접속이 안 될 수 있습니다.`);
  }

  // [M1] 화면 서버를 못 띄우면 창이 아예 안 뜬다. 그대로 두면 사용자는 exe를 눌러도
  // 아무 일도 일어나지 않는 것처럼 보이고, 단서는 로그 파일에만 남는다.
  uiServer = createUiServer();
  try {
    uiPort = await uiServer.start();
  } catch (err) {
    error(`[화면 서버 실패] ${err.code || ''} ${err.message}`);
    dialog.showErrorBox(
      '실행할 수 없습니다',
      `화면을 띄울 포트(55510~55520)를 모두 다른 프로그램이 쓰고 있습니다.\n`
      + `해당 프로그램을 끄고 다시 실행해 주세요.\n\n자세한 내용: ${LOG_PATH}`,
    );
    app.quit();
    return;
  }

  // [E-4] 화면은 로컬 파일만 쓴다. 외부에서 무엇도 불러오지 않도록 못 박는다.
  // (이게 없으면 Electron이 렌더러 콘솔에 보안 경고를 계속 띄운다.)
  // connect-src만 열어 두는 이유: 게임 서버가 다른 PC라 주소를 미리 알 수 없다.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: Object.assign({}, details.responseHeaders, {
        'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src *"],
      }),
    });
  });

  peer = createPeer({
    port: PORT,
    onStatus: sendStatus,
    onNotice: (n) => {
      if (n.kind !== 'portBusy') return;
      sendNotice({
        kind: 'portBusy',
        text: `${n.port}번 포트를 다른 프로그램이 쓰고 있어 게임을 열 수 없습니다.`
          + ' 예전 버전이 아직 켜져 있지 않은지 확인하고, 모두 같은 파일로 다시 받아주세요.',
      });
    },
    onVersionMismatch: (d) => sendNotice({
      kind: 'versionMismatch',
      text: `다른 참가자와 프로그램 버전이 다릅니다(상대 v${d.peerVersion} / 나 v${d.myVersion}). 모두 같은 파일로 다시 받아주세요.`,
    }),
  });
  peer.start();
  log(`[Electron] 시작 (게임 포트 ${PORT}, 화면 포트 ${uiPort}, 로그: ${LOG_PATH})`);

  createSplash();   // 본 창이 준비될 때까지 이걸 보여준다
  createTray();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

ipcMain.handle('get-status', () => (peer ? peer.status() : null));

// [요청] 화면이 "알릴 만한 일이 생겼다"고 알려 온다(대화 도착 / 내 차례).
// 창이 눈앞에 있으면 startAttention()이 알아서 무시한다.
ipcMain.on('attention', () => { startAttention(); });

app.on('window-all-closed', async () => {
  if (blinkTimer) { clearInterval(blinkTimer); blinkTimer = null; }
  if (tray) { tray.destroy(); tray = null; }
  closeSplash();
  if (peer) await peer.stop();
  if (uiServer) uiServer.stop();
  app.quit();
});

process.on('uncaughtException', (err) => {
  // 창이 없는 빌드에서는 콘솔이 안 보이므로 로그 파일에 반드시 남긴다.
  error(`[치명적 오류] ${err.stack || err.message}`);
});

// 여기까지 올라온 실패도 그냥 삼키면 원인을 영영 못 찾는다. 앱은 살려 두되 남긴다.
process.on('unhandledRejection', (reason) => {
  error(`[처리되지 않은 실패] ${reason && reason.stack ? reason.stack : reason}`);
});
