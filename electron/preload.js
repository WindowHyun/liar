'use strict';

/**
 * 화면(렌더러)에 "지금 붙어야 할 게임 서버 주소"만 건네준다.
 *
 * contextIsolation을 켠 채로 필요한 것만 노출한다. 화면 쪽 코드는 Node를 전혀 쓰지 못하고,
 * 여기 적힌 함수 두 개만 볼 수 있다.
 */

const { contextBridge, ipcRenderer } = require('electron');

let serverUrl = null;
const listeners = [];
const noticeListeners = [];

function update(url) {
  if (url === serverUrl) return;
  serverUrl = url;
  for (const fn of listeners) {
    try { fn(url); } catch { /* 화면 쪽 예외가 여기까지 올라오지 않게 */ }
  }
}

ipcRenderer.on('server-changed', (_event, url) => update(url));

// [E-2] 버전 불일치처럼 화면에 띄워야 하는 알림
ipcRenderer.on('notice', (_event, notice) => {
  for (const fn of noticeListeners) {
    try { fn(notice); } catch { /* 화면 쪽 예외가 여기까지 올라오지 않게 */ }
  }
});

// 창이 뜬 시점에 이미 호스트가 정해져 있을 수 있다. 지금 상태를 한 번 받아 온다.
ipcRenderer.invoke('get-status').then((status) => {
  if (status) update(status.serverUrl);
}).catch(() => { /* 아직 준비 전 */ });

contextBridge.exposeInMainWorld('liar', {
  isElectron: true,
  getServer: () => serverUrl,
  onServerChange: (fn) => { if (typeof fn === 'function') listeners.push(fn); },
  onNotice: (fn) => { if (typeof fn === 'function') noticeListeners.push(fn); },
  // [요청] 창을 내려 둔 사이에 대화가 오거나 내 차례가 되면 알린다.
  // 창이 눈앞에 있는지는 메인 쪽에서 판단하므로, 화면은 그냥 알리기만 하면 된다.
  notifyAttention: () => { ipcRenderer.send('attention'); },
});
