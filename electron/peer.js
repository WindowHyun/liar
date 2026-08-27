'use strict';

/**
 * 이 PC의 인스턴스 하나. Electron을 전혀 모른다(그래서 테스트에서 그냥 node로 여러 개
 * 띄워 볼 수 있다).
 *
 * 하는 일:
 *   1. UDP 55500으로 서로를 찾는다 (discovery.js)
 *   2. 찾은 인스턴스들 중 누가 게임 서버를 돌릴지 정한다 (호스트 선출)
 *   3. 내가 호스트면 TCP 55500에 게임 서버를 켜고, 아니면 끈다
 *   4. 지금 접속해야 할 주소(serverUrl)가 바뀌면 알려 준다 → 화면이 그쪽으로 다시 붙는다
 *
 * ── 호스트를 어떻게 정하는가 ──────────────────────────────────────────────
 * "먼저 켠 사람이 호스트"가 자연스럽지만, PC마다 시계가 어긋나 있으면 엉뚱한 사람이
 * 계속 뽑힌다. 그래서 시계를 쓰지 않고 이렇게 정한다.
 *
 *   1) 호스트라고 알리는 인스턴스가 하나라도 있으면 → 그중 nodeId가 가장 작은 쪽
 *   2) 아무도 호스트가 아니면 → 살아 있는 인스턴스 중 nodeId가 가장 작은 쪽
 *
 * 1)이 먼저이기 때문에, 나중에 들어온 사람의 nodeId가 더 작아도 판을 뺏지 않는다
 * (붙어 있던 게임이 초기화되는 걸 막는다). 호스트가 나가면 그때 2)가 걸려서 다음 사람이
 * 이어받는다. 어느 경우든 모두가 같은 규칙으로 같은 답을 낸다.
 *
 * 시작 직후에는 ELECTION_GRACE_MS 동안 선출을 미룬다. 이미 돌고 있는 판이 있는데
 * 내가 아직 그 알림을 못 들은 상태에서 "아무도 호스트가 아니네"라고 판단해 버리면
 * 호스트가 둘이 된다.
 */

const crypto = require('crypto');
const { createDiscovery } = require('./discovery');
const { createGameServer } = require('../web/game-server');
const { log, warn, error } = require('../logger');

const DEFAULT_PORT = 55500;
const ELECTION_GRACE_MS = 2500; // 시작 직후 남의 알림을 먼저 들어 보는 시간
const ELECTION_TICK_MS = 1000;
const SERVER_RETRY_MS = 1000;
const SERVER_MAX_TRIES = 3;

function createPeer(options) {
  const opts = options || {};
  const port = opts.port || DEFAULT_PORT;
  const onStatus = opts.onStatus || (() => {});
  const onVersionMismatch = opts.onVersionMismatch || (() => {});

  const nodeId = opts.nodeId || crypto.randomUUID().slice(0, 8);
  const startedAt = Date.now();

  let hosting = false;          // 게임 서버를 실제로 켜는 데 성공했는가
  let switching = false;        // 서버를 켜거나 끄는 중
  let gameServer = null;
  let discovery = null;
  let electionTimer = null;
  let lastStatusKey = null;

  function aliveNodes() {
    return [
      { nodeId, address: '127.0.0.1', isHost: hosting, isMe: true },
      ...discovery.peers().map((p) => ({ nodeId: p.nodeId, address: p.address, isHost: p.isHost, isMe: false })),
    ];
  }

  /** 위 주석의 규칙 그대로. 모두가 같은 입력에서 같은 답을 내야 한다. */
  function electHost(nodes) {
    const claimers = nodes.filter((n) => n.isHost);
    const pool = claimers.length > 0 ? claimers : nodes;
    return pool.slice().sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0))[0];
  }

  function status() {
    const nodes = discovery ? aliveNodes() : [{ nodeId, address: '127.0.0.1', isHost: false, isMe: true }];
    const ready = Date.now() - startedAt >= ELECTION_GRACE_MS;
    const host = ready ? electHost(nodes) : null;

    let serverUrl = null;
    if (host) {
      if (host.isMe) serverUrl = hosting ? `ws://127.0.0.1:${port}` : null; // 아직 서버가 안 떴으면 붙을 곳이 없다
      else serverUrl = `ws://${host.address}:${port}`;
    }

    return {
      nodeId,
      port,
      ready,
      isHost: !!host && host.isMe && hosting,
      hostId: host ? host.nodeId : null,
      hostAddress: host ? host.address : null,
      serverUrl,
      peerCount: nodes.length,
    };
  }

  function notifyIfChanged() {
    const s = status();
    const key = `${s.serverUrl}|${s.isHost}|${s.peerCount}|${s.ready}`;
    if (key === lastStatusKey) return;
    lastStatusKey = key;
    onStatus(s);
  }

  async function startServerWithRetry() {
    for (let attempt = 1; attempt <= SERVER_MAX_TRIES; attempt += 1) {
      try {
        gameServer = createGameServer({ port });
        await gameServer.start();
        return true;
      } catch (err) {
        gameServer = null;
        // 방금까지 호스트였던 인스턴스가 같은 PC에 있으면 포트가 잠깐 안 놓일 수 있다.
        warn(`[호스트 전환] 게임 서버 시작 실패(${attempt}/${SERVER_MAX_TRIES}): ${err.code || err.message}`);
        if (attempt === SERVER_MAX_TRIES) {
          error('[호스트 전환] 게임 서버를 켜지 못했습니다. 다른 참가자가 호스트를 맡습니다.');
          return false;
        }
        await new Promise((r) => setTimeout(r, SERVER_RETRY_MS));
      }
    }
    return false;
  }

  async function applyElection() {
    if (switching || !discovery) return;
    if (Date.now() - startedAt < ELECTION_GRACE_MS) { notifyIfChanged(); return; }

    const host = electHost(aliveNodes());
    const shouldHost = host.isMe;

    if (shouldHost && !hosting) {
      switching = true;
      log(`[호스트 전환] 내가 호스트가 됩니다 (${nodeId})`);
      hosting = await startServerWithRetry();
      switching = false;
    } else if (!shouldHost && hosting) {
      switching = true;
      log(`[호스트 전환] ${host.nodeId}에게 호스트를 넘깁니다`);
      await gameServer.stop();
      gameServer = null;
      hosting = false;
      switching = false;
    }
    notifyIfChanged();
  }

  return {
    nodeId,
    status,
    isHosting: () => hosting,

    start() {
      discovery = createDiscovery({
        port,
        nodeId,
        buildAnnounce: () => ({ isHost: hosting }),
        onChange: () => { applyElection(); },
        onVersionMismatch, // [E-2] 화면에 "모두 같은 버전으로 받아주세요"를 띄우기 위해
      });
      discovery.start();
      electionTimer = setInterval(applyElection, ELECTION_TICK_MS);
      log(`[시작] nodeId=${nodeId}, 포트 ${port} (UDP 발견 + TCP 게임)`);
      notifyIfChanged();
    },

    async stop() {
      if (electionTimer) { clearInterval(electionTimer); electionTimer = null; }
      if (discovery) { discovery.stop(); discovery = null; }
      if (gameServer) { await gameServer.stop(); gameServer = null; }
      hosting = false;
    },
  };
}

module.exports = { createPeer, DEFAULT_PORT, ELECTION_GRACE_MS };
