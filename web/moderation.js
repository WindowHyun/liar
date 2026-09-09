'use strict';

const crypto = require('crypto');
const VOTE_MS = 30000;
const BAN_MS = 10 * 60 * 1000;

function createModeration({ players, now, setTimer, clearTimer, onChange, onKick }) {
  let proposal = null;
  let timer = null;
  let result = null;
  const bans = new Map();
  const cooldowns = new Map();
  const eligible = (id) => {
    const p = players.get(id);
    return p && p.connected && !p.spectator;
  };
  function finish(passed, message) {
    const previous = proposal;
    if (timer !== null) clearTimer(timer);
    timer = null;
    proposal = null;
    result = { id: previous.id, passed, message };
    if (passed) {
      const target = players.get(previous.targetId);
      if (target) { bans.set(target.token, now() + BAN_MS); onKick(target.id); }
    }
    onChange();
  }
  function counts() {
    let agree = 0; let disagree = 0;
    for (const [id, yes] of proposal.answers) {
      if (!eligible(id)) continue;
      if (yes) agree += 1; else disagree += 1;
    }
    return { agree, disagree };
  }
  function request(by, targetId) {
    if (!eligible(by)) return '게임 참가자만 강퇴를 제안할 수 있습니다.';
    if (by === targetId || !players.get(targetId)?.connected) return '다른 접속자를 선택해 주세요.';
    if (proposal) return '이미 강퇴 투표가 진행 중입니다.';
    if ((cooldowns.get(by) || 0) > now()) return '강퇴 제안은 30초마다 할 수 있습니다.';
    for (const [id, until] of cooldowns) if (until <= now()) cooldowns.delete(id);
    const voters = [...players.keys()].filter((id) => id !== targetId && eligible(id));
    if (voters.length < 2) return '대상자를 제외하고 최소 2명의 게임 참가자가 필요합니다.';
    proposal = { id: crypto.randomUUID(), targetId, targetName: players.get(targetId).nickname,
      voters: new Set(voters), required: Math.floor(voters.length / 2) + 1,
      answers: new Map([[by, true]]), endsAt: now() + VOTE_MS };
    cooldowns.set(by, now() + VOTE_MS);
    result = null;
    timer = setTimer(() => finish(false, '강퇴 투표가 시간 초과로 부결되었습니다.'), VOTE_MS);
    onChange();
    return null;
  }
  function vote(id, proposalId, agree) {
    if (!proposal || proposal.id !== proposalId) return '이미 종료된 강퇴 투표입니다.';
    if (!proposal.voters.has(id) || !eligible(id)) return '이 강퇴 투표에 참여할 수 없습니다.';
    proposal.answers.set(id, agree);
    const { agree: yes, disagree: no } = counts();
    if (yes >= proposal.required) finish(true, `${proposal.targetName}님이 다수결로 강퇴되었습니다.`);
    else if (proposal.voters.size - no < proposal.required) finish(false, '강퇴 투표가 부결되었습니다.');
    else onChange();
    return null;
  }
  function depart(id) {
    if (!proposal) return;
    if (proposal.targetId === id && !players.has(id)) { finish(false, '대상자가 나가 강퇴 투표가 취소되었습니다.'); return; }
    // Keep the initial threshold. Leaving must never make kicking easier.
    proposal.answers.delete(id);
  }
  return {
    request, vote, depart,
    isBanned(token) {
      for (const [key, until] of bans) if (until <= now()) bans.delete(key);
      return bans.has(token);
    },
    stateFor(id) {
      return { result, proposal: proposal ? {
        id: proposal.id, targetId: proposal.targetId, targetName: proposal.targetName,
        total: proposal.voters.size, required: proposal.required, endsAt: proposal.endsAt,
        ...counts(), canVote: proposal.voters.has(id) && !!eligible(id),
        answer: proposal.answers.has(id) ? proposal.answers.get(id) : null,
      } : null };
    },
    dispose() { if (timer !== null) clearTimer(timer); timer = null; proposal = null; bans.clear(); cooldowns.clear(); },
  };
}

module.exports = { createModeration };
