'use strict';

/**
 * [P3-33] 메시지 스키마 검증.
 *
 * 예전에는 msg.type만 보고 나머지 필드를 그대로 썼다. 그래서
 *   - 닉네임 없는 DESC가 오면 화면 쪽 name.slice(0, 2)에서 예외가 났고,
 *   - GUESS의 word가 문자열이 아니면 msg.word.trim()에서 예외가 났고,
 *   - 그 예외들이 전부 "패킷 처리 실패" 경고 한 줄로 뭉뚱그려졌다.
 *
 * 형식이 어긋난 패킷은 게임 로직에 닿기 전에 여기서 버린다. 게임 로직은 필드 모양을
 * 믿고 써도 된다. 모르는 필드(msgId, needAck 등)는 문제 삼지 않는다 - 나중에 필드가
 * 추가돼도 구버전이 그 메시지를 통째로 버리지 않게 하기 위해서다.
 */

const LIMITS = {
  id: 64,
  nickname: 24,
  text: 300,
  word: 60,
  roster: 32,     // 한 라운드 최대 인원
  reason: 32,
  winner: 16,
};

function str(v, max) { return typeof v === 'string' && v.length > 0 && v.length <= max; }
function optStr(v, max) { return v === undefined || v === null || (typeof v === 'string' && v.length <= max); }
function bool(v) { return typeof v === 'boolean'; }

const CHECKS = {
  ACK: (m) => (str(m.ackFor, LIMITS.id) ? null : 'ackFor'),

  HELLO: (m) => (str(m.id, LIMITS.id) && str(m.nickname, LIMITS.nickname) ? null : 'id/nickname'),
  JOIN: (m) => (str(m.id, LIMITS.id) && str(m.nickname, LIMITS.nickname) ? null : 'id/nickname'),

  START: (m) => {
    if (!str(m.id, LIMITS.id)) return 'id';
    if (!str(m.roundId, LIMITS.id)) return 'roundId';
    if (!Array.isArray(m.roster) || m.roster.length === 0 || m.roster.length > LIMITS.roster) return 'roster';
    for (const p of m.roster) {
      if (!p || typeof p !== 'object') return 'roster 항목';
      if (!str(p.id, LIMITS.id) || !str(p.nickname, LIMITS.nickname)) return 'roster 항목';
    }
    return null;
  },

  WORD: (m) => {
    if (!str(m.roundId, LIMITS.id) || !str(m.to, LIMITS.id)) return 'roundId/to';
    if (!str(m.category, LIMITS.word)) return 'category';
    if (!(m.word === null || str(m.word, LIMITS.word))) return 'word';   // 라이어에게는 null로 간다
    if (!bool(m.isLiar)) return 'isLiar';
    return null;
  },

  DESC: (m) => (str(m.id, LIMITS.id) && str(m.nickname, LIMITS.nickname) && str(m.text, LIMITS.text) ? null : 'id/nickname/text'),

  CALL_VOTE: (m) => (str(m.id, LIMITS.id) && str(m.roundId, LIMITS.id) ? null : 'id/roundId'),

  VOTE: (m) => (str(m.voterId, LIMITS.id) && str(m.roundId, LIMITS.id) && str(m.targetId, LIMITS.id) ? null : 'voterId/roundId/targetId'),

  ACCUSED: (m) => (str(m.id, LIMITS.id) && str(m.roundId, LIMITS.id) && str(m.accusedId, LIMITS.id) ? null : 'id/roundId/accusedId'),

  REVEAL: (m) => (str(m.id, LIMITS.id) && str(m.roundId, LIMITS.id) && bool(m.isLiar) ? null : 'id/roundId/isLiar'),

  GUESS: (m) => (str(m.id, LIMITS.id) && str(m.roundId, LIMITS.id) && str(m.word, LIMITS.word) ? null : 'id/roundId/word'),

  RESULT: (m) => {
    if (!str(m.id, LIMITS.id) || !str(m.roundId, LIMITS.id)) return 'id/roundId';
    if (!str(m.winner, LIMITS.winner) || !str(m.reason, LIMITS.reason)) return 'winner/reason';
    if (!optStr(m.guess, LIMITS.word)) return 'guess';
    return null;
  },
};

/** 문제가 없으면 null, 있으면 사람이 읽을 수 있는 사유 문자열을 돌려준다. */
function validate(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return '메시지가 객체가 아님';
  if (typeof msg.type !== 'string') return 'type 없음';
  const check = CHECKS[msg.type];
  if (!check) return `알 수 없는 type: ${String(msg.type).slice(0, 32)}`;
  const bad = check(msg);
  return bad ? `${msg.type}의 ${bad} 필드가 형식에 맞지 않음` : null;
}

/** [P2-18] 제시어 비교용 정규화. 공백과 대소문자 차이로 정답이 오답 처리되지 않게 한다. */
function normalizeWord(word) {
  return String(word == null ? '' : word).trim().toLowerCase().replace(/\s+/g, '');
}

module.exports = { validate, normalizeWord, LIMITS };
