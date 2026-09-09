'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRoom } = require('../web/room');
const { validateClientMessage } = require('../web/protocol');
const { isAllowedOrigin } = require('../web/origin');

function fixture(n = 4) {
  let clock = 0; let timers = [];
  const kicked = [];
  const room = createRoom({ random: () => 0, now: () => clock, onKick: (id) => kicked.push(id),
    setTimer(fn, ms) { const t = { fn, at: clock + ms }; timers.push(t); return t; },
    clearTimer(t) { timers = timers.filter((v) => v !== t); },
  });
  const players = Array.from({ length: n }, (_, i) => room.join({ nickname: `P${i}` }));
  function advance(ms) {
    const end = clock + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      if (!timers[0] || timers[0].at > end) break;
      const t = timers.shift(); clock = t.at; t.fn();
    }
    clock = end;
  }
  return { room, players, advance, kicked, pending: () => timers.length };
}

test('repeated disconnects each receive a full grace period', () => {
  const { room: r, players: [a], advance } = fixture();
  r.disconnect(a.playerId); advance(9000);
  r.join({ nickname: 'A', token: a.token }); r.disconnect(a.playerId); advance(1000);
  assert.ok(r.playerIds().includes(a.playerId));
  advance(9000); assert.ok(!r.playerIds().includes(a.playerId));
});

test('disconnected proposal answers cannot pass a connected-player majority', () => {
  const { room: r, players: p } = fixture(5);
  r.start();
  while (r._debug().phase === 'turn') r.say(r.stateFor(p[0].playerId).round.speaker.id, 'hint');
  r.respondProposal(p[1].playerId, true); r.disconnect(p[1].playerId);
  r.respondProposal(p[2].playerId, true);
  const s = r.stateFor(p[0].playerId);
  assert.equal(s.phase, 'proposal');
  assert.equal(s.round.proposal.agree, 1); assert.equal(s.round.proposal.total, 4);
});

test('spectators do not satisfy start requirements or receive roles, turns or game votes', () => {
  const { room: r, players: [a] } = fixture(1);
  const w = r.join({ nickname: 'Watcher', spectator: true });
  assert.ok(r.start(a.playerId));
  const b = r.join({ nickname: 'B' });
  assert.ok(r.start(w.playerId)); assert.equal(r.start(a.playerId), null);
  const s = r.stateFor(w.playerId);
  assert.equal(s.you.word, null); assert.equal(s.you.isLiar, false);
  assert.equal(s.you.inRound, false); assert.equal(s.canStart, false);
  assert.equal(s.round.roster.length, 2);
  assert.ok(r.say(w.playerId, 'spoiler'));
  assert.ok(r.setMode(a.playerId, true));
  while (r._debug().phase === 'turn') r.say(r.stateFor(a.playerId).round.speaker.id, 'hint');
  assert.ok(r.respondProposal(w.playerId, true));
  r.respondProposal(a.playerId, false); r.respondProposal(b.playerId, false);
  assert.ok(r.vote(w.playerId, a.playerId));
});

test('spectator preference survives reconnect and rounds; mode switch applies to next round', () => {
  const { room: r, players: p } = fixture();
  const w = r.join({ nickname: 'Watcher', spectator: true });
  r.disconnect(w.playerId);
  const restored = r.join({ nickname: 'Watcher', token: w.token, spectator: false });
  assert.equal(restored.playerId, w.playerId);
  assert.equal(r.stateFor(w.playerId).you.spectator, true);
  r.start(); r.leave(p[0].playerId); // deterministic liar leaves
  assert.equal(r._debug().phase, 'result');
  r.start(); assert.equal(r.stateFor(w.playerId).you.inRound, false);
  assert.equal(r.setMode(w.playerId, false), null);
  assert.equal(r.stateFor(w.playerId).you.inRound, false);
});

test('spectator capacity is separate and bounded; switching cannot overfill player seats', () => {
  const { room: r } = fixture(8);
  const watchers = Array.from({ length: 16 }, () => r.join({ nickname: 'Watcher', spectator: true }));
  assert.ok(watchers.every((w) => w.playerId));
  assert.ok(r.join({ nickname: 'extra', spectator: true }).error);
  assert.ok(r.setMode(watchers[0].playerId, false));
  assert.ok(r.join({ nickname: 'extra' }).error);
});

test('kick needs strict majority, excludes target and spectators, and allows immediate re-entry as a new participant', () => {
  const { room: r, players: p, kicked } = fixture(5);
  const w = r.join({ nickname: 'Watcher', spectator: true });
  assert.ok(r.requestKick(w.playerId, p[4].playerId));
  assert.equal(r.requestKick(p[0].playerId, p[4].playerId), null);
  const vote = r.stateFor(p[0].playerId).moderation.proposal;
  assert.equal(vote.required, 3); assert.equal(vote.total, 4);
  assert.ok(r.voteKick(p[4].playerId, vote.id, true));
  assert.ok(r.voteKick(w.playerId, vote.id, true));
  assert.ok(r.voteKick(p[1].playerId, 'stale', true));
  r.voteKick(p[0].playerId, vote.id, true); // cannot double count
  r.voteKick(p[1].playerId, vote.id, true);
  assert.equal(kicked.length, 0); // 2/4 is a tie
  r.voteKick(p[2].playerId, vote.id, true);
  assert.deepEqual(kicked, [p[4].playerId]);
  assert.ok(!r.playerIds().includes(p[4].playerId));
  const returned = r.join({ nickname: 'return', token: p[4].token });
  assert.ok(returned.playerId);
  assert.notEqual(returned.playerId, p[4].playerId);
  assert.notEqual(returned.token, p[4].token);
});

test('disconnects do not lower kick threshold; new arrivals cannot vote; timeout cleans proposal', () => {
  const { room: r, players: p, advance, kicked } = fixture(5);
  r.requestKick(p[0].playerId, p[4].playerId);
  const proposal = r.stateFor(p[0].playerId).moderation.proposal;
  r.disconnect(p[1].playerId); r.disconnect(p[2].playerId);
  const newPlayer = r.join({ nickname: 'New' });
  assert.ok(r.voteKick(newPlayer.playerId, proposal.id, true));
  r.voteKick(p[3].playerId, proposal.id, true);
  assert.equal(r.stateFor(p[0].playerId).moderation.proposal.required, 3);
  advance(30000);
  assert.equal(kicked.length, 0);
  assert.equal(r.stateFor(p[0].playerId).moderation.proposal, null);
});

test('target leaving cancels vote; spectators can be kicked; two-player unilateral kicks are blocked', () => {
  const { room: r, players: p } = fixture(2);
  assert.ok(r.requestKick(p[0].playerId, p[1].playerId));
  const w = r.join({ nickname: 'Watcher', spectator: true });
  assert.equal(r.requestKick(p[0].playerId, w.playerId), null);
  r.leave(w.playerId);
  assert.equal(r.stateFor(p[0].playerId).moderation.proposal, null);
});

test('majority NO rejects; proposal cooldown prevents immediate repeated harassment', () => {
  const { room: r, players: p, advance } = fixture(4);
  r.requestKick(p[0].playerId, p[3].playerId);
  const proposal = r.stateFor(p[0].playerId).moderation.proposal;
  r.voteKick(p[1].playerId, proposal.id, false);
  r.voteKick(p[2].playerId, proposal.id, false);
  assert.equal(r.stateFor(p[0].playerId).moderation.result.passed, false);
  assert.ok(r.requestKick(p[0].playerId, p[3].playerId));
  advance(30000);
  assert.equal(r.requestKick(p[0].playerId, p[3].playerId), null);
});

for (const disconnect of [false, true]) {
  test(`empty room clears kick history after ${disconnect ? 'disconnect grace' : 'explicit leave'}`, () => {
    const { room: r, players: p, advance } = fixture(3);
    r.requestKick(p[0].playerId, p[2].playerId);
    r.voteKick(p[1].playerId, r.stateFor(p[0].playerId).moderation.proposal.id, true);
    assert.equal(r.stateFor(p[0].playerId).moderation.result.passed, true);
    for (const player of p.slice(0, 2)) {
      if (disconnect) r.disconnect(player.playerId);
      else r.leave(player.playerId);
    }
    if (disconnect) advance(10000);
    const next = r.join({ nickname: 'New visitor' });
    assert.deepEqual(r.stateFor(next.playerId).moderation, { result: null, proposal: null });
    advance(30000);
    assert.deepEqual(r.stateFor(next.playerId).moderation, { result: null, proposal: null });
    r.dispose();
  });
}

test('empty room cancels pending kick timer so it cannot publish a result in a new room', () => {
  const { room: r, players: p, advance } = fixture(3);
  r.requestKick(p[0].playerId, p[2].playerId);
  for (const player of p) r.leave(player.playerId);
  const next = r.join({ nickname: 'New visitor' });
  advance(30000);
  assert.deepEqual(r.stateFor(next.playerId).moderation, { result: null, proposal: null });
  r.dispose();
});

test('kicking the liar finishes the round and dispose clears every timer', () => {
  const f = fixture(); const { room: r, players: p } = f;
  r.start(); r.requestKick(p[1].playerId, p[0].playerId);
  const proposal = r.stateFor(p[1].playerId).moderation.proposal;
  r.voteKick(p[2].playerId, proposal.id, true);
  assert.equal(r.stateFor(p[1].playerId).result.reason, 'liarLeft');
  r.disconnect(p[3].playerId); assert.ok(f.pending() > 0);
  r.dispose(); assert.equal(f.pending(), 0);
});

test('Origin guard accepts same DNS origin, explicit proxy origin and only Electron loopback ports', () => {
  const request = (origin, host = 'liar.example.com', secure = true) => ({ origin, secure, req: { headers: { host } } });
  assert.equal(isAllowedOrigin(request('https://liar.example.com')), true);
  assert.equal(isAllowedOrigin(request('http://203.0.113.1:8080')), false);
  assert.equal(isAllowedOrigin(request('http://127.0.0.1:1234')), false);
  assert.equal(isAllowedOrigin(request('http://127.0.0.1:55510')), true);
  assert.equal(isAllowedOrigin(request('https://proxy.example.com'), ['https://proxy.example.com']), true);
  assert.equal(isAllowedOrigin(request('null')), false);
  assert.equal(isAllowedOrigin(request('https://liar.example.com@evil.example')), false);
});

test('protocol validates spectator and kick payloads and rejects inherited property names', () => {
  assert.equal(validateClientMessage({ type: 'join', nickname: 'A', spectator: true }), null);
  assert.ok(validateClientMessage({ type: 'join', nickname: 'A', spectator: 'yes' }));
  assert.ok(validateClientMessage({ type: 'kickVote', agree: true }));
  assert.ok(validateClientMessage({ type: 'toString' }));
});
