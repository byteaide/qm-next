/**
 * Egress policy + private-network classifier tests (parity 16.0):
 * host normalization, suffix matching, allow/deny decision order,
 * parseEgressPolicy rejects bad input, and isPrivateNetworkIp
 * catches loopback / private / link-local / ULA / multicast.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  egressDecision,
  hostMatches,
  isBlockedDestinationIp,
  isHostDenied,
  isPrivateNetworkIp,
  parseEgressPolicy,
} from '../src/index.ts'

test('egress-policy: hostMatches treats suffix and exact matches as equal', () => {
  assert.equal(hostMatches('api.example.com', 'example.com'), true)
  assert.equal(hostMatches('example.com', 'example.com'), true)
  assert.equal(hostMatches('notexample.com', 'example.com'), false)
  assert.equal(hostMatches('API.Example.COM', 'EXAMPLE.com.'), true)
})

test('egress-policy: isHostDenied walks the deny list', () => {
  assert.equal(isHostDenied('a.attacker.com', ['attacker.com']), true)
  assert.equal(isHostDenied('attacker.com', ['attacker.com']), true)
  assert.equal(isHostDenied('attacker.com', ['other.com']), false)
  assert.equal(isHostDenied('attacker.com', undefined), false)
})

test('egress-policy: egressDecision applies denied first, then allowlist', () => {
  assert.deepEqual(egressDecision('a.attacker.com', { allowedHosts: ['attacker.com'], deniedHosts: [] }), {
    allow: true,
    verdict: 'ok',
  })
  assert.deepEqual(
    egressDecision('a.attacker.com', { allowedHosts: ['attacker.com'], deniedHosts: ['attacker.com'] }),
    { allow: false, verdict: 'denied' },
  )
  assert.deepEqual(
    egressDecision('random.org', { allowedHosts: ['example.com'], deniedHosts: [] }),
    { allow: false, verdict: 'not_allowlisted' },
  )
  assert.deepEqual(egressDecision('anywhere', undefined), { allow: true, verdict: 'ok' })
})

test('egress-policy: parseEgressPolicy rejects malformed inputs', () => {
  assert.deepEqual(parseEgressPolicy({ allowedHosts: 'not-array' }), {
    error: 'allowedHosts must be an array of host names',
  })
  assert.deepEqual(parseEgressPolicy({ allowedHosts: ['evil:80'] }), {
    error: 'evil:80 includes a port; enter a host name only',
  })
  assert.deepEqual(parseEgressPolicy({ allowedHosts: ['*wild.example'] }), {
    error: '*wild.example is not a host name; omit schemes, wildcards, ports, paths, and credentials',
  })
  assert.deepEqual(parseEgressPolicy({ allowedHosts: ['example.com'], deniedHosts: ['example.com'] }), {
    error: 'example.com cannot appear in both allowedHosts and deniedHosts',
  })
})

test('egress-policy: parseEgressPolicy accepts a clean pair', () => {
  const r = parseEgressPolicy({ allowedHosts: ['Example.COM.'], deniedHosts: ['Attacker.com'] })
  assert.deepEqual(r, {
    policy: { allowedHosts: ['example.com'], deniedHosts: ['attacker.com'] },
  })
})

test('isPrivateNetworkIp: loopback / RFC1918 / link-local / CGNAT / multicast', () => {
  assert.equal(isPrivateNetworkIp('127.0.0.1'), true)
  assert.equal(isPrivateNetworkIp('10.0.0.1'), true)
  assert.equal(isPrivateNetworkIp('172.16.5.1'), true)
  assert.equal(isPrivateNetworkIp('192.168.0.1'), true)
  assert.equal(isPrivateNetworkIp('169.254.1.1'), true)
  assert.equal(isPrivateNetworkIp('100.64.0.1'), true)
  assert.equal(isPrivateNetworkIp('224.0.0.1'), true)
  assert.equal(isPrivateNetworkIp('8.8.8.8'), false)
  assert.equal(isPrivateNetworkIp('::1'), true)
  assert.equal(isPrivateNetworkIp('fc00::1'), true)
  assert.equal(isPrivateNetworkIp('fe80::1'), true)
  assert.equal(isPrivateNetworkIp('ff02::1'), true)
  assert.equal(isPrivateNetworkIp('2001:db8::1'), false)
})

test('isBlockedDestinationIp: drops loopback / link-local / metadata dual-stack', () => {
  assert.equal(isBlockedDestinationIp('127.0.0.1'), true)
  assert.equal(isBlockedDestinationIp('169.254.169.254'), true)
  assert.equal(isBlockedDestinationIp('::1'), true)
  assert.equal(isBlockedDestinationIp('8.8.8.8'), false)
  assert.equal(isBlockedDestinationIp('not-an-ip'), false)
})