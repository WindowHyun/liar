'use strict';

/**
 * Electron 없이 peer.js만 띄우는 껍데기. 테스트에서 인스턴스를 여러 개 굴리는 데 쓴다.
 * 상태가 바뀔 때마다 한 줄 JSON을 stdout으로 뱉는다.
 *
 * 사용: node test/helpers/headless-peer.js [포트]
 */

const { createPeer } = require('../../electron/peer');

const port = Number(process.argv[2]) || 55500;
const peer = createPeer({
  port,
  onStatus: (s) => { process.stdout.write(`${JSON.stringify(s)}\n`); },
});

peer.start();

// 테스트에서 "게임 서버만 죽었다"를 만든다. peer는 계속 돌면서 알림을 보낸다.
process.on('SIGUSR2', async () => { await peer._debugStopServer(); });

process.on('SIGTERM', async () => { await peer.stop(); process.exit(0); });
process.on('SIGINT', async () => { await peer.stop(); process.exit(0); });
