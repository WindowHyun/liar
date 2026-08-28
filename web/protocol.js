'use strict';

/**
 * 브라우저 → 서버 메시지 검증.
 *
 * LAN 버전(../protocol.js)은 "LAN의 누구나 아무 패킷이나 보낼 수 있다"는 전제로 모든
 * 게임 메시지를 검증해야 했다. 웹 버전은 규칙 판정이 전부 서버에 있으므로, 검증할 것은
 * 브라우저가 보내는 조작 요청 몇 가지뿐이다.
 *
 * web/ 아래는 LAN 버전을 지워도 그대로 돌아가도록 자기완결적으로 둔다.
 */

const LIMITS = { nickname: 24, text: 300, word: 60, id: 64, token: 64 };

function str(v, max) { return typeof v === 'string' && v.trim().length > 0 && v.length <= max; }
function optStr(v, max) { return v === undefined || v === null || (typeof v === 'string' && v.length <= max); }

const CLIENT_MESSAGES = {
  join: (m) => (str(m.nickname, LIMITS.nickname) && optStr(m.token, LIMITS.token) ? null : 'nickname/token'),
  start: () => null,
  leave: () => null,
  chat: (m) => (str(m.text, LIMITS.text) ? null : 'text'),
  callVote: () => null,
  proposalVote: (m) => (typeof m.agree === 'boolean' ? null : 'agree'),
  vote: (m) => (str(m.targetId, LIMITS.id) ? null : 'targetId'),
  guess: (m) => (str(m.word, LIMITS.word) ? null : 'word'),
};

/** 문제가 없으면 null, 있으면 사유 문자열. */
function validateClientMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return '메시지가 객체가 아님';
  if (typeof msg.type !== 'string') return 'type 없음';
  const check = CLIENT_MESSAGES[msg.type];
  if (!check) return `알 수 없는 type: ${String(msg.type).slice(0, 32)}`;
  const bad = check(msg);
  return bad ? `${msg.type}의 ${bad} 필드가 형식에 맞지 않음` : null;
}

/** 제시어 비교용 정규화. 공백·대소문자 차이로 맞힌 정답이 오답 처리되지 않게 한다. */
function normalizeWord(word) {
  return String(word == null ? '' : word).trim().toLowerCase().replace(/\s+/g, '');
}

module.exports = { validateClientMessage, normalizeWord, LIMITS };
