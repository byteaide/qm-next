/**
 * mrkdwn conversion: canonical markdown → Slack mrkdwn, ported from qm's
 * format pipeline. Focus on the transformations the delivery path hits.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeSlackEntities, neutralizeMassMentions, stripMention, toSlackMrkdwn } from '../src/index.ts'

test('bold, italic, strikethrough and headers convert to mrkdwn markers', () => {
  assert.equal(toSlackMrkdwn('**bold** text'), '*bold* text')
  assert.equal(toSlackMrkdwn('__bold__ text'), '*bold* text')
  assert.equal(toSlackMrkdwn('~~struck~~'), '~struck~')
  assert.equal(toSlackMrkdwn('# Title'), '*Title*')
  assert.equal(toSlackMrkdwn('### Deep head'), '*Deep head*')
})

test('italics: single asterisks become underscores', () => {
  assert.equal(toSlackMrkdwn('a *soft* word'), 'a _soft_ word')
})

test('bullets and horizontal rules rewrite to slack-native shapes', () => {
  assert.equal(toSlackMrkdwn('- one\n- two'), '• one\n• two')
  assert.equal(toSlackMrkdwn('above\n\n---\n\nbelow'), 'above\n\n──────────\n\nbelow')
})

test('links and bare urls become slack <url|label> links, tails preserved', () => {
  assert.equal(toSlackMrkdwn('[docs](https://example.com/a)'), '<https://example.com/a|docs>')
  assert.equal(toSlackMrkdwn('see https://example.com/x.'), 'see <https://example.com/x>.')
})

test('code spans survive untouched', () => {
  assert.equal(toSlackMrkdwn('run `npm test **now**`'), 'run `npm test **now**`')
  assert.equal(toSlackMrkdwn('```\n**keep**\n```'), '```\n**keep**\n```')
})

test('tables reformat into aligned code blocks', () => {
  const md = '| a | b |\n| - | - |\n| 1 | 2 |'
  const out = toSlackMrkdwn(md)
  assert.match(out, /```/)
  assert.match(out, /a \| b/)
  assert.match(out, /--\+--/)
})

test('mass mentions are neutralized so replies cannot ping @here', () => {
  assert.equal(neutralizeMassMentions('<!here> check <!channel>'), '@\u200bhere check @\u200bchannel')
  assert.equal(toSlackMrkdwn('hey <!everyone>'), 'hey @\u200beveryone')
})

test('stripMention removes the bot token and decodes entities', () => {
  assert.equal(stripMention('<@U_BOT> deploy &amp; go', 'U_BOT'), 'deploy & go')
  assert.equal(stripMention('<@U_BOT|bot> hello', 'U_BOT'), 'hello')
  assert.equal(decodeSlackEntities('a &lt; b &gt; c &amp; d'), 'a < b > c & d')
})
