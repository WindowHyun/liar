'use strict';

/**
 * 무작위 조작으로 규칙을 두들겨 본다(전수 점검용).
 *
 * 손으로 쓴 시나리오는 "생각해 본 순서"만 확인한다. 실제로 터지는 건 아무도 생각하지
 * 않은 순서 - 투표 중에 지목된 사람이 나가고, 그 사이에 새 사람이 들어오고, 동시에
 * 제한 시간이 끝나는 식이다. 여기서는 매 수마다 아래 불변식을 전부 확인한다.
 *
 * 실행: node test/fuzz-test.js [횟수]
 */

const { createRoom, MIN_PLAYERS, TURN_ROUNDS } = require('../web/room');

const PHASES = ['lobby', 'turn', 'free', 'proposal', 'voting', 'guess', 'result'];
const IN_ROUND = ['turn', 'free', 'proposal', 'voting', 'guess'];
const CHAT_MAX = 100;

// ── 재현 가능한 난수 (실패하면 씨앗만 있으면 그대로 재현된다) ──
function makeRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const problems = [];
// 퍼즈가 실제로 깊은 단계까지 갔는지. 여기가 0이면 통과해도 의미가 없다.
const seen = { lobby: 0, turn: 0, free: 0, proposal: 0, voting: 0, guess: 0, result: 0 };
const seenReason = {};
function fail(seed, step, what, detail) {
  problems.push({ seed, step, what, detail });
  console.log(`  FAIL  [씨앗 ${seed} / ${step}수] ${what}${detail ? `  (${detail})` : ''}`);
}

// 제시어가 라이어의 상태에 실려 나갔는지 찾는다. 찾으면 그 자리(경로)를, 없으면 null을.
//
// 상태 전체를 문자열로 만들어 놓고 제시어가 들어 있는지 보는 방식이었는데, 한국어에는
// 낱말 경계가 없어서 짧은 제시어가 안내 문구에 그냥 걸린다("게" ⊂ "게임이 시작되었습니다").
// 그래서 자리를 따져 본다. 대화 내용(chat[].text)은 빼는데, 시민이 제시어를 그대로 쳐도
// 그건 규칙이 제대로 도는 것이고, 안내 문구는 제시어를 끼워 넣지 않는 고정 문장이기
// 때문이다(web/room.js에서 round.word를 쓰는 곳은 정답 확인·결과 공개·you.word뿐이다).
// 나머지 자리는 전부 훑으므로, 새 항목이 제시어를 흘리면 그대로 잡힌다.
function leakPath(node, word, path) {
  const here = path || 'state';
  if (typeof node === 'string') return node.includes(word) ? here : null;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const hit = leakPath(node[i], word, `${here}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) {
      if (here === 'state' && k === 'chat') continue; // 위 설명 참고
      const hit = leakPath(node[k], word, `${here}.${k}`);
      if (hit) return hit;
    }
  }
  return null;
}

function runOne(seed, steps) {
  const rnd = makeRandom(seed);
  let clock = 0;
  let seq = 0;
  const timers = [];
  const setTimer = (fn, ms) => { seq += 1; const t = { id: seq, at: clock + (ms || 0), fn }; timers.push(t); return t; };
  const clearTimer = (t) => { if (!t) return; const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); };
  const advance = (ms) => {
    const target = clock + ms;
    for (let g = 0; g < 500; g += 1) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      if (timers.length === 0 || timers[0].at > target) break;
      const t = timers.shift();
      clock = t.at;
      t.fn();
    }
    clock = target;
  };

  const room = createRoom({ setTimer, clearTimer, now: () => clock, random: rnd });
  const known = []; // { playerId, token }
  let broke = false;

  const pick = (list) => (list.length ? list[Math.floor(rnd() * list.length)] : null);

  for (let step = 1; step <= steps && !broke; step += 1) {
    const before = room._debug();
    const ids = room.playerIds();
    const roll = Math.floor(rnd() * 13);

    try {
      if (roll === 0 || known.length === 0) {
        const seat = room.join({ nickname: `P${known.length + 1}` });
        known.push(seat);
      } else if (roll === 1) {
        const who = pick(known);
        if (who) room.disconnect(who.playerId);
      } else if (roll === 2) {
        const who = pick(known);
        if (who) room.leave(who.playerId);
      } else if (roll === 3) {
        // 끊겼던 사람이 돌아온다 (토큰 재사용)
        const who = pick(known);
        if (who) {
          const back = room.join({ nickname: 'P다시', token: who.token });
          who.playerId = back.playerId;
        }
      } else if (roll === 4) {
        room.start();
      } else if (roll === 5) {
        // 대부분은 차례인 사람이 말한다. 아무나 고르면 설명 단계를 못 빠져나가서
        // 투표·정답 단계까지 도달하질 못한다(그러면 점검이 겉돈다).
        const speaker = before.phase === 'turn' && before.round
          ? before.round.speakOrder[before.round.speakIndex] : null;
        const who = (speaker && rnd() < 0.85) ? speaker : pick(ids);
        if (who) room.say(who, '무언가 설명');
      } else if (roll === 10) {
        // 다 같이 한 사람을 지목한다. 무작위로 흩뿌리면 늘 동점이라 정답 단계를 못 본다.
        if (before.phase === 'voting' && before.round) {
          const alive = before.round.roster.map((r) => r.id).filter((id) => ids.includes(id));
          const target = pick(alive);
          for (const voter of alive) if (voter !== target) room.vote(voter, target);
        } else if (before.phase === 'proposal') {
          // 찬반도 다 같이 답해 본다
          const agree = rnd() < 0.6;
          for (const voter of ids) room.respondProposal(voter, agree);
        }
      } else if (roll === 6) {
        const who = pick(ids);
        if (who) room.callVote(who);
      } else if (roll === 7) {
        const who = pick(ids);
        if (who) room.respondProposal(who, rnd() < 0.5);
      } else if (roll === 8) {
        const who = pick(ids);
        const target = pick(ids);
        if (who && target) room.vote(who, target);
      } else if (roll === 9) {
        // 지목된 사람이 실제로 답을 낸다. 절반은 정답, 절반은 오답.
        if (before.phase === 'guess' && before.round && before.round.accusedId) {
          room.guess(before.round.accusedId, rnd() < 0.5 ? before.round.word : '엉뚱한답');
        } else {
          const who = pick(ids);
          if (who) room.guess(who, '아무말');
        }
      } else {
        advance(Math.floor(rnd() * 70000)); // 제한 시간을 넘겨 보기도 한다
      }
    } catch (err) {
      fail(seed, step, `예외 발생 (roll=${roll})`, err.stack ? err.stack.split('\n')[0] : String(err));
      broke = true;
      break;
    }

    // ── 매 수마다 확인하는 불변식 ──
    const dbg = room._debug();
    const { phase, round, result } = dbg;
    const all = room.playerIds();
    seen[phase] += 1;
    if (phase === 'result' && result) seenReason[result.reason] = (seenReason[result.reason] || 0) + 1;

    const bad = (what, detail) => { fail(seed, step, what, detail); broke = true; };

    if (!PHASES.includes(phase)) { bad('알 수 없는 단계', phase); break; }
    if (IN_ROUND.includes(phase) && !round) { bad('진행 중인데 라운드가 없다', phase); break; }
    if (!IN_ROUND.includes(phase) && round) { bad('끝났는데 라운드가 남아 있다', phase); break; }
    if (phase === 'proposal' && !round.proposal) { bad('찬반 단계인데 제안이 없다'); break; }
    if (phase === 'guess' && !round.accusedId) { bad('정답 단계인데 지목된 사람이 없다'); break; }
    if (phase === 'result' && !result) { bad('결과 단계인데 결과가 없다'); break; }

    if (round) {
      const rosterIds = new Set(round.roster.map((r) => r.id));
      if (new Set(round.speakOrder).size !== round.speakOrder.length) { bad('대화권 순서에 중복이 있다', round.speakOrder.join(',')); break; }
      if (round.speakOrder.some((id) => !rosterIds.has(id))) { bad('참가자가 아닌 사람이 대화권 순서에 있다'); break; }
      if ([...round.spoken].some((id) => !rosterIds.has(id))) { bad('참가자가 아닌 사람이 설명을 마쳤다'); break; }
      if (round.speakRound < 1 || round.speakRound > TURN_ROUNDS) { bad('바퀴 수가 범위를 벗어났다', String(round.speakRound)); break; }
      if (!rosterIds.has(round.liarId)) { bad('라이어가 참가자 명단에 없다'); break; }

      // 라이어가 판에서 사라진 채로 진행되면 안 된다 (도망간 라이어 승 문제)
      const liarPresent = all.includes(round.liarId);
      if (!liarPresent) { bad('라이어가 없는데 판이 계속된다'); break; }

      // 혼자 남은 채로 판이 이어지면 안 된다
      const activeCount = round.roster.filter((r) => all.includes(r.id)).length;
      if (activeCount < 2) { bad('혼자 남았는데 판이 계속된다', `남은 인원 ${activeCount}`); break; }
    }

    if (result && phase !== 'result') { bad('진행 중인데 결과가 남아 있다', phase); break; }

    // 각자에게 맞춘 상태가 항상 만들어지고, 새면 안 되는 것이 안 새는지
    for (const id of all.concat(['없는사람'])) {
      let s;
      try { s = room.stateFor(id); } catch (err) { bad('상태 만들기 실패', err.message); break; }
      let json;
      try { json = JSON.stringify(s); } catch (err) { bad('상태를 보낼 수 없다', err.message); break; }

      if (round && id === round.liarId) {
        const where = leakPath(s, round.word);
        if (where) { bad('라이어에게 제시어가 새어 나갔다', `${round.word} @ ${where}`); break; }
      }
      for (const seat of known) {
        if (seat.token && json.includes(seat.token)) { bad('토큰이 상태로 새어 나갔다'); break; }
      }
      if (s.chat.length > CHAT_MAX) { bad('대화 기록이 상한을 넘었다', String(s.chat.length)); break; }
      if (!PHASES.includes(s.phase)) { bad('상태의 단계가 이상하다', s.phase); break; }
      if (s.canStart && !(s.phase === 'lobby' || s.phase === 'result')) { bad('진행 중인데 시작할 수 있다고 나온다', s.phase); break; }
      if (s.round && s.round.speakTotal < s.round.spokenCount) {
        bad('설명한 사람이 전체보다 많다', `${s.round.spokenCount}/${s.round.speakTotal}`); break;
      }
      // 화면은 "N명 중 M명 설명함"으로 보여 준다. N이 이미 나간 사람까지 세면
      // 아무리 기다려도 M이 N에 닿지 않아 "안 끝나는 것처럼" 보인다.
      if (s.phase === 'turn' && s.round) {
        const here = s.round.roster.filter((r) => !r.left).length;
        if (s.round.speakTotal !== here) {
          bad('설명 진행 표시가 실제 인원과 다르다', `표시 ${s.round.speakTotal} / 실제 ${here}`); break;
        }
      }
    }
    if (broke) break;

    const rec = room.stateFor(all[0] || 'x').record;
    if (rec.rounds !== rec.liarWins + rec.citizenWins) {
      bad('전적 합이 맞지 않는다', JSON.stringify(rec)); break;
    }
    if (timers.length > 200) { bad('타이머가 계속 쌓인다', String(timers.length)); break; }
  }
  return !broke;
}

const steps = 400;
const rounds = Number(process.argv[2]) || 300;
console.log(`무작위 규칙 점검: 씨앗 ${rounds}개 × ${steps}수`);

let ok = 0;
for (let seed = 1; seed <= rounds; seed += 1) {
  if (runOne(seed, steps)) ok += 1;
}
console.log(`  ${ok}/${rounds} 씨앗 통과 (최소 인원 ${MIN_PLAYERS}, 설명 ${TURN_ROUNDS}바퀴)`);
console.log('  거쳐 간 단계 :', Object.entries(seen).map(([k, v]) => `${k} ${v}`).join(' · '));
console.log('  나온 결과    :', Object.entries(seenReason).map(([k, v]) => `${k} ${v}`).join(' · ') || '(없음)');

// 깊은 단계에 한 번도 못 가면 "통과"가 아무 의미가 없다. 그것 자체를 실패로 본다.
for (const phase of ['turn', 'free', 'proposal', 'voting', 'guess', 'result']) {
  if (seen[phase] === 0) {
    problems.push({ what: `단계 ${phase}에 한 번도 도달하지 못했다 - 점검이 겉돌고 있다` });
    console.log(`  FAIL  단계 ${phase}에 한 번도 도달하지 못했다 - 점검이 겉돌고 있다`);
  }
}
console.log(`\n무작위 규칙 점검: ${problems.length === 0 ? '문제 없음' : `${problems.length}건 발견`}`);
process.exit(problems.length === 0 ? 0 : 1);
