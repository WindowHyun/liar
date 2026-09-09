'use strict';
/* global ws, state, myId, readToken, sendMessage, kicked, joined, reconnectTimer */

const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const WebSocket = require('ws');
const { createGameServer } = require('../web/game-server');

async function main() {
  const server = createGameServer({ port: 4198, host: '127.0.0.1' });
  let browser;
  await server.start();
  try {
    browser = await chromium.launch({ headless: true });
    // All pages deliberately share localStorage, as ordinary tabs do.
    const context = await browser.newContext();
    const pages = [];
    const errors = [];
    for (const [i, name] of ['Alpha', 'Beta', 'Gamma', 'Watcher'].entries()) {
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto('http://127.0.0.1:4198');
      await page.waitForFunction(() => ws && ws.readyState === WebSocket.OPEN);
      await page.fill('#nickname-input', name);
      if (i === 3) await page.check('#spectator-input');
      else await page.uncheck('#spectator-input');
      await page.click('#join-btn');
      await page.waitForFunction(() => state && state.you);
      pages.push(page);
    }
    const [a, b, c, watcher] = pages;
    const ids = await Promise.all(pages.map((p) => p.evaluate(() => myId)));
    const tokens = await Promise.all(pages.map((p) => p.evaluate(() => readToken())));
    assert.equal(new Set(tokens).size, 4);
    await a.reload();
    await a.waitForFunction((id) => state && state.you && state.you.id === id, ids[0]);
    assert.equal(await a.evaluate(() => readToken()), tokens[0]);
    assert.equal(await a.evaluate(() => state.you.nickname), 'Alpha');
    assert.equal(await watcher.isDisabled('#start-btn'), true);
    await watcher.click('#mode-btn');
    await watcher.waitForFunction(() => state.you.spectator === false);
    await watcher.click('#mode-btn');
    await watcher.waitForFunction(() => state.you.spectator === true);
    console.log('PASS shared-context tabs retain independent identities after reload; spectator toggle works');

    // Repeat join on an established connection must not cancel the round or orphan a seat.
    await a.click('#start-btn');
    await a.waitForFunction(() => state.phase === 'turn');
    await watcher.waitForFunction(() => state.phase === 'turn');
    assert.equal(await watcher.evaluate(() => state.you.word), null);
    assert.equal(await watcher.evaluate(() => state.you.inRound), false);
    assert.equal(await watcher.locator('#participant-list button[data-kick]').count(), 0);
    assert.equal(await watcher.isDisabled('#chat-input'), true);
    assert.equal(await a.isDisabled('#mode-btn'), true);
    await a.evaluate(() => sendMessage({ type: 'join', nickname: 'again', token: readToken() }));
    await a.waitForFunction(() => document.getElementById('banner').textContent.includes('이미 참가'));
    assert.equal(await a.evaluate(() => state.phase), 'turn');
    console.log('PASS spectator has no role/chat/game controls; duplicate join preserves active round');

    // Kick a spectator: 3 eligible players => 2 YES needed (initiator counts once).
    await a.click(`button[data-kick="${ids[3]}"]`);
    await b.waitForSelector('#moderation-panel button[data-kick-vote="yes"]');
    assert.equal(await b.evaluate(() => state.moderation.proposal.required), 2);
    await b.click('#moderation-panel button[data-kick-vote="yes"]');
    await watcher.waitForFunction(() => kicked === true);
    await a.waitForFunction((id) => !state.players.some((p) => p.id === id), ids[3]);
    assert.equal(await watcher.evaluate(() => joined), false);
    assert.equal(await watcher.evaluate(() => reconnectTimer), null);
    assert.equal(await watcher.isVisible('#screen-join'), true);
    assert.equal(await watcher.inputValue('#nickname-input'), 'Watcher');
    assert.equal(await watcher.evaluate(() => readToken()), null);
    await watcher.click('#join-btn');
    await watcher.waitForFunction((id) => state && state.you && state.you.id !== id, ids[3]);
    assert.equal(await watcher.evaluate(() => kicked), false);
    assert.notEqual(await watcher.evaluate(() => readToken()), tokens[3]);
    assert.equal(await watcher.evaluate(() => state.you.inRound), false);
    assert.equal(await watcher.isEnabled('#leave-btn'), true);
    assert.equal(await c.evaluate(() => state.phase), 'turn');
    await watcher.reload();
    await watcher.waitForFunction(() => state && state.you);
    assert.equal(await watcher.evaluate(() => kicked), false);
    console.log('PASS kick returns to login without auto-join; immediate manual re-entry and reload work');

    await new Promise((resolve, reject) => {
      const socket = new WebSocket('ws://127.0.0.1:4198', { origin: 'http://203.0.113.1:8080' });
      socket.once('open', () => { socket.close(); reject(new Error('Foreign origin accepted')); });
      socket.once('error', (error) => { try { assert.match(error.message, /Unexpected server response: 401/); resolve(); } catch (e) { reject(e); } });
    });
    assert.deepEqual(errors, []);
    console.log('PASS foreign origin is rejected by the real WebSocket handshake; no browser script errors');
  } finally {
    if (browser) await browser.close();
    await server.stop();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
