import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluateCommandPolicy } from '../src/policy.ts'
import { scannableCommand } from '../src/scannable-command.ts'
import { defaultDenylistPolicy } from '../src/default-policy.ts'
import type { CommandPolicy } from '@qm/types'

function orgFloor(): CommandPolicy {
  return {
    mode: 'denylist',
    rules: [
      { pattern: '\\brm\\b[^\\n]*(?:-[a-zA-Z]*r|--recursive)', decision: 'require_approval', reason: 'recursive delete' },
      { pattern: '\\bgit\\s+push\\b.*(?:--force\\b|(?:^|\\s)-[a-zA-Z]*f\\b)', decision: 'require_approval', reason: 'force push' },
      { pattern: '\\b(drop|truncate)\\s+table\\b', decision: 'require_approval', reason: 'destructive SQL' },
      { pattern: '\\bmkfs\\b|:\\(\\)\\s*\\{', decision: 'deny', reason: 'destructive / fork bomb' },
      { pattern: '\\bcurl\\b.*\\|\\s*(sh|bash)\\b', decision: 'require_approval', reason: 'pipe-to-shell' },
    ],
  }
}

const decision = (command: string, policy: CommandPolicy) => evaluateCommandPolicy(command, policy).decision

test('scannable: org floor requires approval for recursive delete and denies fork bomb', () => {
  const p = orgFloor()
  assert.equal(decision('rm -rf build', p), 'require_approval')
  assert.equal(decision('mkfs.ext4 /dev/sda', p), 'deny')
})

test('scannable: verdict surfaces the matched rule identity (its pattern) and the trigger substring', () => {
  const p: CommandPolicy = {
    mode: 'denylist',
    rules: [{ pattern: '\\bzz-tool\\b', decision: 'require_approval', reason: 'ZZ tool' }],
  }
  const r = evaluateCommandPolicy('run zz-tool now', p)
  assert.equal(r.decision, 'require_approval')
  assert.equal(r.ruleId, '\\bzz-tool\\b')
  assert.equal(r.matched, 'zz-tool')
})

test('scannable: recursive delete is gated in every flag form and order', () => {
  const p = orgFloor()
  const gated = [
    'rm -r build',
    'rm -rf build',
    'rm -fr build',
    'rm -f -r build',
    'rm -Rf build',
    'rm --recursive --force build',
    'rm --force --recursive build',
    'rm -v -rf build',
  ]
  for (const c of gated) {
    assert.equal(decision(c, p), 'require_approval', `expected gate: ${c}`)
  }
  assert.equal(decision('rm file.txt', p), 'allow')
  assert.equal(decision('rm -f file.txt', p), 'allow')
})

test('scannable: fork bomb is denied', () => {
  const p = orgFloor()
  assert.equal(decision(':(){ :|:& };:', p), 'deny')
  assert.equal(decision(':() { :|:& };:', p), 'deny')
})

test('scannable: benign command is allowed in denylist mode', () => {
  assert.equal(decision('echo hello', orgFloor()), 'allow')
})

test('scannable: first-match-wins — an allow carve-out before a broader require_approval still allows', () => {
  const policy: CommandPolicy = {
    mode: 'denylist',
    rules: [
      { pattern: 'git push origin staging', decision: 'allow' },
      { pattern: 'git push', decision: 'require_approval', reason: 'review pushes' },
    ],
  }
  assert.equal(decision('git push origin staging', policy), 'allow')
  assert.equal(decision('git push origin main', policy), 'require_approval')
})

test('scannable: bare-word unquoting widens allow carve-outs too', () => {
  const policy: CommandPolicy = {
    mode: 'denylist',
    rules: [
      { pattern: '\\bgit\\s+push\\s+origin\\s+staging\\b', decision: 'allow' },
      { pattern: '\\bgit\\s+push\\b', decision: 'require_approval', reason: 'review pushes' },
    ],
  }
  assert.equal(decision("git push origin 'staging'", policy), 'allow')
  assert.equal(decision('git push origin "staging"', policy), 'allow')
  assert.equal(decision("git push origin 'staging extra'", policy), 'require_approval')
})

test('scannable: force push requires approval in long AND short flag forms (org floor)', () => {
  const p = orgFloor()
  assert.equal(decision('git push --force origin main', p), 'require_approval')
  assert.equal(decision('git push -f origin feature', p), 'require_approval')
  assert.equal(decision('git push --force-with-lease', p), 'require_approval')
  assert.equal(decision('git push origin main', p), 'allow')
  assert.equal(decision('git push -u origin feature', p), 'allow')
})

test('scannable: a tool-specific deny rule catches every wrapper/quoting/substitution spelling', () => {
  assert.equal(decision('acmecli login', orgFloor()), 'allow', 'org floor has no vendor policy')
  const vendor: CommandPolicy = {
    mode: 'denylist',
    rules: [
      {
        pattern: '\\bacmecli\\b[^;|&]*\\blogin\\b',
        decision: 'deny',
        reason: 'this deployment authenticates acmecli ambiently',
      },
    ],
  }
  const denied = [
    'acmecli login',
    'acmecli login --use-device-code',
    "echo ready && acmecli 'login'",
    'echo ready | acmecli login',
    'echo "$(acmecli login)"',
    'sudo acmecli login',
    'sudo -u root acmecli login',
    'env DEBUG=1 acmecli login',
    'FOO=1 acmecli login',
    'FOO= acmecli login',
    'time acmecli login',
    'nice acmecli login',
    'timeout 5 acmecli login',
    'if acmecli login; then echo impossible; fi',
    '/usr/local/bin/acmecli login',
    '  acmecli login',
    'echo `acmecli login`',
    'echo "`acmecli login`"',
    'acmecli \\\n login',
    'command -- acmecli login',
    'exec -- acmecli login',
    'exec -l acmecli login',
    'env -- acmecli login',
    '/usr/bin/env acmecli login',
    '/usr/bin/nice acmecli login',
    'nice -n5 acmecli login',
    'timeout --signal TERM 5 acmecli login',
    "bash -c 'acmecli login'",
    "sh -c 'acmecli login'",
    "eval 'acmecli login'",
    "acme''cli login",
    'coproc acmecli login',
    'xargs acmecli login',
    'acmecli --env production login',
    'acmecli --verbose login',
    'acmecli --refresh-cache login',
    '2>/dev/null acmecli login',
    '>out acmecli login',
    'nohup acmecli login',
    "env -S 'acmecli login'",
    "env --split-string='acmecli login'",
    'command acmecli login -v',
    'command -- acmecli login -V',
    "$'acmecli' login",
    ['bash <<EOF >login.log', 'acmecli login', 'EOF'].join('\n'),
    ['cat <<EOF | bash >login.log', 'acmecli login', 'EOF'].join('\n'),
    '2>&1 acmecli login',
    "env -S'acmecli login'",
    "bash -O extglob -c 'acmecli login'",
    "bash --rcfile /dev/null -c 'acmecli login'",
    "$'acme\\x63li' login",
  ]
  for (const c of denied) {
    const r = evaluateCommandPolicy(c, vendor)
    assert.equal(r.decision, 'deny', `expected deny: ${c}`)
    assert.match(r.reason ?? '', /authenticates acmecli ambiently/)
  }
  for (const c of ['gh auth login', 'gcloud auth login --no-launch-browser', 'acmecli status', "echo 'acmecli login'"]) {
    assert.notEqual(decision(c, vendor), 'deny', `must not deny: ${c}`)
  }
})

test('scannable: a dangerous-looking pattern inside data is NOT gated', () => {
  const p = orgFloor()
  const writeHeredoc = [
    'cat > test/x.ts <<EOF',
    'const c = "!run git push --force origin main";',
    'rm -rf node_modules // in a comment',
    'EOF',
  ].join('\n')
  assert.equal(decision(writeHeredoc, p), 'allow')
  assert.equal(decision("echo 'rm -rf /'", p), 'allow')
  assert.equal(decision('git commit -m "drop table users"', p), 'allow')
})

test('scannable: a real dangerous command is still gated even when the turn also writes a heredoc', () => {
  const p = orgFloor()
  const cmd = ['cat > note.txt <<EOF', 'harmless body', 'EOF', 'git push --force origin main'].join('\n')
  const r = evaluateCommandPolicy(cmd, p)
  assert.equal(r.decision, 'require_approval')
  assert.equal(r.reason, 'force push')
})

test('scannable: command substitution that runs a dangerous command is gated, even inside quotes', () => {
  const p = orgFloor()
  assert.equal(decision('echo "$(rm -rf /tmp/x)"', p), 'require_approval')
})

test('scannable: a heredoc body fed to a shell stays gated (executed, not a file write)', () => {
  const p = orgFloor()
  assert.equal(decision('bash <<EOF\nrm -rf /\nEOF', p), 'require_approval')
  assert.equal(decision('cat <<EOF | bash\nrm -rf /\nEOF', p), 'require_approval')
  assert.equal(decision('cat > /tmp/s.sh <<EOF\nrm -rf /\nEOF', p), 'allow')
})

test('scannable: verdict surfaces the exact substring that tripped the rule', () => {
  const r = evaluateCommandPolicy('git push --force origin main', orgFloor())
  assert.equal(r.decision, 'require_approval')
  assert.ok(r.matched?.includes('--force'), `expected matched to include the trigger, got ${r.matched}`)
})

test('scannableCommand strips inert data but preserves executable command substitution', () => {
  assert.ok(
    !/git push --force/.test(scannableCommand(['cat > x <<EOF', 'git push --force', 'EOF'].join('\n'))),
    'heredoc body stripped',
  )
  assert.ok(!/rm -rf/.test(scannableCommand("echo 'rm -rf /'")), 'single-quoted literal stripped')
  assert.ok(
    !/drop table/i.test(scannableCommand('git commit -m "drop table users"')),
    'double-quoted literal stripped',
  )
  assert.ok(
    /rm -rf/.test(scannableCommand('echo "$(rm -rf /)"')),
    'command substitution inside double quotes preserved',
  )
})

test('scannableCommand unquotes bare words so quoting cannot evade word-boundary rules', () => {
  assert.equal(scannableCommand("acmecli 'tool' query_database"), 'acmecli tool query_database')
  assert.equal(scannableCommand('acmecli "tool" query_database'), 'acmecli tool query_database')
  assert.equal(scannableCommand("git commit -m 'fix stuff'"), "git commit -m ''", 'multi-word strings stay stripped')
  assert.equal(scannableCommand("echo 'a;b'"), "echo ''", 'shell metachars stay stripped')
  const rule: CommandPolicy = {
    mode: 'denylist',
    rules: [{ pattern: '\\bacmecli\\b[^;|&]*\\btool\\s+\\S+', decision: 'require_approval' }],
  }
  assert.equal(decision("acmecli 'tool' analytics", rule), 'require_approval')
  assert.equal(decision('acmecli me && othercli tool list', rule), 'allow', 'the bridge stops at command separators')
})

test('scannable: rules cannot be bypassed with shell escapes or empty quote concatenation', () => {
  const policy: CommandPolicy = {
    mode: 'denylist',
    rules: [{ pattern: '\\bacmecli\\s+tool\\s+query_database\\b', decision: 'require_approval' }],
  }
  for (const command of [
    'acmecli tool query_database',
    'acme\\cli tool query_database',
    'acmecli to\\ol query_database',
    "acme''cli tool query_database",
  ]) {
    assert.equal(decision(command, policy), 'require_approval', command)
  }
  assert.equal(decision("echo 'acme\\cli tool query_database'", policy), 'allow')
  assert.equal(decision("printf '%s' 'acme''cli tool query_database'", policy), 'allow')
})

test('scannable: shell-evaluated payloads and ANSI-C words cannot bypass command rules', () => {
  const org = orgFloor()
  for (const command of [
    "bash -c 'rm -rf /tmp/x'",
    "eval 'git push --force origin main'",
    "sudo bash -lc 'rm -rf /tmp/x'",
    `echo "$(bash -c 'rm -rf /tmp/x')"`,
  ]) {
    assert.equal(decision(command, org), 'require_approval', command)
  }
  assert.equal(decision(`bash -c 'echo "rm -rf /tmp/x"'`, org), 'allow')
  assert.equal(decision("printf '%s' 'bash -c rm -rf /tmp/x'", org), 'allow')

  const policy: CommandPolicy = {
    mode: 'denylist',
    rules: [{ pattern: '\\bacmecli\\s+tool\\s+query_database\\b', decision: 'require_approval' }],
  }
  for (const command of [
    "bash -c 'acmecli tool query_database'",
    "eval 'acmecli tool query_database'",
    "acmecli $'tool' query_database",
    "acmecli $'to\\x6fl' query_database",
  ]) {
    assert.equal(decision(command, policy), 'require_approval', command)
  }
})

test('scannable: literal stdin executed by a shell and simple command variables stay inside the gate', () => {
  const org = orgFloor()
  for (const command of [
    `printf 'rm -rf /tmp/x\\n' | bash`,
    `printf 'rm %s\\n' '-rf /tmp/x' | bash -`,
    `echo 'rm -rf /tmp/x' | env bash /dev/stdin`,
    `printf '%s\\n' 'rm -rf /tmp/x' | sudo sh /proc/self/fd/0`,
    `command printf 'rm -rf /tmp/x\\n' | bash`,
    `env printf 'rm -rf /tmp/x\\n' | sh`,
    `builtin printf 'rm -rf /tmp/x\\n' | bash`,
    `env -S "printf 'rm -rf /tmp/x\\n'" | bash`,
    `printf 'rm -rf /tmp/x\\n' | env -S "bash /dev/stdin"`,
    `echo -e 'rm\\x20-rf /tmp/x\\n' | bash`,
    `printf 'rm -rf /tmp/x\\n' | stdbuf -oL bash`,
    `bash <<< 'rm -rf /tmp/x'`,
    `bash<<<'rm -rf /tmp/x'`,
    `env sh <<< 'rm -rf /tmp/x'`,
    `r=rm; "$r" -rf /tmp/x`,
    `r=rm; command $r -rf /tmp/x`,
    `r=rm; env $r -rf /tmp/x`,
  ]) {
    assert.equal(decision(command, org), 'require_approval', command)
  }
  assert.equal(decision(`printf 'rm -rf /tmp/x\\n' | cat`, org), 'allow')
  assert.equal(decision(`printf '%s' 'rm -rf /tmp/x' | bash -c 'cat >/tmp/x'`, org), 'allow')
  assert.equal(decision(`printf 'rm -rf /tmp/x\\n' || bash`, org), 'allow')
  assert.equal(decision(`printf 'rm -rf /tmp/x\\n' && bash`, org), 'allow')

  const policy: CommandPolicy = {
    mode: 'denylist',
    rules: [{ pattern: '\\bacmecli\\s+tool\\s+query_database\\b', decision: 'require_approval' }],
  }
  assert.equal(decision(`printf '%s\\n' 'acmecli tool query_database' | bash`, policy), 'require_approval')
})

test('scannable: allowlist mode denies anything not explicitly allowed', () => {
  const p: CommandPolicy = {
    mode: 'allowlist',
    rules: [{ pattern: '^ls\\b', decision: 'allow' }],
  }
  assert.equal(decision('ls -la', p), 'allow')
  assert.equal(decision('cat secrets', p), 'deny')
})

test('scannable: an invalid stored rule is skipped (any decision) — one stale pattern never locks a scope', () => {
  const p: CommandPolicy = {
    mode: 'denylist',
    rules: [
      { pattern: '(', decision: 'deny', reason: 'broken' },
      { pattern: '\\bcurl\\b', decision: 'deny', reason: 'still enforced' },
    ],
  }
  assert.equal(decision('echo hello', p), 'allow', 'unrelated commands keep working')
  assert.equal(decision('curl http://x', p), 'deny', 'valid sibling rules still bind')

  const approval: CommandPolicy = {
    mode: 'denylist',
    rules: [{ pattern: '(', decision: 'require_approval' }],
  }
  assert.equal(decision('echo hello', approval), 'allow')
})

test('scannable: a heredoc fed to a non-interpreter command (cat, gh) is data, not gated', () => {
  const policy = orgFloor()
  const prBody = [
    `gh pr create --title x --body "$(cat <<'EOF'`,
    'Extract SQL payloads safely; previously DROP TABLE users in payloads broke parsing.',
    'EOF',
    ')"',
  ].join('\n')
  assert.equal(decision(prBody, policy), 'allow')
  const piped = ["cat <<'EOF' | gh pr create --body-file -", 'fixes DROP TABLE handling', 'EOF'].join('\n')
  assert.equal(decision(piped, policy), 'allow')
})

test('scannable: a heredoc fed to a SQL client stays gated', () => {
  const policy = orgFloor()
  const sql = ['psql mydb <<EOF', 'drop table users;', 'EOF'].join('\n')
  assert.equal(decision(sql, policy), 'require_approval')
})

test('scannable: an unquoted heredoc command substitutions still execute and stay gated', () => {
  const policy = orgFloor()
  const sneaky = ['cat <<EOF | gh pr create --body-file -', 'hello $(rm -rf /tmp/x)', 'EOF'].join('\n')
  assert.equal(decision(sneaky, policy), 'require_approval')
})

test('scannable: destructive SQL handed to a SQL client fires the floor rule (public #49)', () => {
  const p = orgFloor()
  for (const cmd of [
    'psql -c "DROP TABLE users"',
    "psql --command='drop table users'",
    'psql -d app -c "TRUNCATE TABLE events"',
    'mysql -u root -e "DROP TABLE users"',
    "mariadb --execute='truncate table logs'",
    'sqlite3 app.db "DROP TABLE users"',
    'duckdb data.db -c "drop table t"',
    '/usr/bin/psql -c "DROP TABLE users"',
    'echo "DROP TABLE users" | psql app',
    'printf "TRUNCATE TABLE x" | mysql app',
  ]) {
    const r = evaluateCommandPolicy(cmd, p)
    assert.equal(r.decision, 'require_approval', `expected gate on: ${cmd}`)
    assert.equal(r.reason, 'destructive SQL', `wrong reason on: ${cmd}`)
  }
})

test('scannable: SQL-looking text that is only data still passes (no false positives)', () => {
  const p = orgFloor()
  for (const cmd of [
    'git commit -m "drop table users"',
    'echo "DROP TABLE users"',
    'grep -r "TRUNCATE TABLE" src/',
    'psql -c "SELECT * FROM users"',
    "sqlite3 app.db '.tables'",
    'rg "drop table" --type sql',
  ]) {
    assert.equal(decision(cmd, p), 'allow', `false positive on: ${cmd}`)
  }
})

test('sandbox gate integration: shell-wrapped catastrophic commands now reach the default denylist', () => {
  const policy = defaultDenylistPolicy()
  assert.equal(decision("sh -c 'rm -rf /etc'", policy), 'deny', "quoted rm behind sh -c is no longer invisible")
  assert.equal(decision('eval "mkfs.ext4 /dev/sda"', policy), 'deny')
  assert.equal(decision("echo 'rm -rf /etc'", policy), 'allow', 'inert data still passes')
})
