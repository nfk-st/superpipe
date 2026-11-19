#!/usr/bin/env node
// Fake `paradev` CLI. Agents act synchronously inside `agents create`, scripted per stage/role/visit.
import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
const ROOT = process.env.FAKE_ROOT; const db = path.join(ROOT, 'db.json');
const D = fs.existsSync(db) ? JSON.parse(fs.readFileSync(db)) : { ws: {}, count: {}, term: 0 };
const persist = () => { const t = db + '.' + process.pid; fs.writeFileSync(t, JSON.stringify(D)); fs.renameSync(t, db); };
const a = process.argv.slice(2); const flag = (n) => { const i = a.indexOf('--' + n); return i < 0 ? undefined : a[i + 1]; };
const out = (o, save = false) => { process.stdout.write(typeof o === 'string' ? o : JSON.stringify(o)); if (save) persist(); process.exit(0); };
const [c1, c2] = a;
const termFile = (id) => path.join(ROOT, `term-${id}.json`);
if (c1 === 'agents' && c2 === '--help') out(process.env.FAKE_NO_WAIT ? 'Commands:\n  create\n  list\n  read\n' : 'Commands:\n  create\n  list\n  read\n  wait\n  explain\n');
if (c1 === 'terminals' && c2 === 'list') {
  const sessions = fs.readdirSync(ROOT).filter((f) => f.startsWith('term-')).map((f) => {
    const t = JSON.parse(fs.readFileSync(path.join(ROOT, f))); return { terminalId: t.id, exited: t.exited, exitCode: t.code, title: null };
  }).filter((t) => !fs.existsSync(path.join(ROOT, `closed-${t.terminalId}`)));
  out({ sessions });
}
if (c1 === 'terminals' && c2 === 'read') out({ text: JSON.parse(fs.readFileSync(termFile(flag('terminal')))).text });
if (c1 === 'terminals' && c2 === 'close') { fs.writeFileSync(path.join(ROOT, `closed-${flag('terminal')}`), ''); out(''); }
if (c1 === 'projects') out([{ id: 'prj1', name: 'demo', repoPath: process.env.REPO }]);
if (c1 === 'workspaces' && c2 === 'create') {
  const dir = path.join(ROOT, 'wt-' + flag('name'));
  execFileSync('git', ['-C', process.env.REPO, 'worktree', 'add', '-b', flag('branch'), dir, flag('base-branch')], { stdio: 'ignore' });
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true }); fs.writeFileSync(path.join(dir, 'node_modules/.setup-done'), '');
  D.ws.ws1 = { dir, branch: flag('branch') }; out({ workspace: { id: 'ws1' }, alreadyExists: false }, true);
}
if (c1 === 'workspaces' && c2 === 'get') out({ id: a[2], branch: D.ws[a[2]].branch, worktreePath: D.ws[a[2]].dir });
if (c1 === 'agents' && c2 === 'create') {
  const dir = D.ws[flag('workspace')].dir; const prompt = flag('prompt');
  const vrel = prompt.match(/verdict file is (\S+)\./)[1];
  const [, stage, role, n] = vrel.match(/verdict-(\w+)-(author|reviewer)(?:-(\d))?\.json/);
  const key = `${stage}-${role}-${n ?? 0}`; const cf = path.join(ROOT, 'count-' + key); const k = (fs.existsSync(cf) ? +fs.readFileSync(cf, 'utf8') : 0) + 1; fs.writeFileSync(cf, String(k));
  const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };
  // FAKE_MODE=ship: one well-formed commit subject and one the driver must reject, on every visit.
  const subject = process.env.FAKE_MODE === 'ship' ? { 'spec-author-0': 'docs: spec add.sh', 'tests-author-0': 'Added tests' }[key] : undefined;
  const verdict = (verdict, extra = {}) => w(vrel, JSON.stringify({ stage, verdict, summary: `${key} visit ${k}`, reason: extra.reason ?? 'ok', ...(subject ? { subject } : {}), ...extra }));
  const ctx = fs.readFileSync(path.join(dir, '.pipeline/run/context.md'), 'utf8');
  fs.appendFileSync(path.join(ROOT, 'contexts.log'), `\n===== ${key} #${k}\n${prompt}\n-----\n${ctx}`);
  // The Claude Code settings each launch would have read, for the deny-rule asserts.
  const claudeLocal = path.join(dir, '.claude/settings.local.json');
  if (fs.existsSync(claudeLocal)) fs.copyFileSync(claudeLocal, path.join(ROOT, `claude-local-${key}-${k}.json`));
  // What each visit found in the worktree before acting, for the keep-work asserts.
  for (const [f, tag] of [['src/add.sh', 'add.sh'], ['tests/add.test.sh', 'test.sh'], ['src/old.sh', 'old.sh']]) if (fs.existsSync(path.join(dir, f))) fs.copyFileSync(path.join(dir, f), path.join(ROOT, `found-${key}-${k}.${tag}`));
  const M = process.env.FAKE_MODE; const OS = M?.startsWith('openspec');
  const doc = ctx.match(/^- Spec document: `([^`]+)`/m)[1]; // an OpenSpec change directory ends in '/'
  const S = {
    'spec-author-0': () => {
      if (OS) {
        const scenario = M === 'openspec-bad' && k === 1 ? '' : '\n#### Scenario: Two numbers\n- **WHEN** add.sh 2 3 runs\n- **THEN** it prints 5\n';
        w(doc + 'proposal.md', '# Proposal: demo\n\n## Why\n\nAdd numbers.\n');
        w(doc + 'specs/add/spec.md', `# add\n\n## ADDED Requirements\n\n### Requirement: Add two numbers\nadd.sh SHALL print the sum of its two arguments.\n${scenario}`);
        return verdict('advance');
      }
      const f = path.join(dir, doc);
      if (M?.startsWith('specrevise') && fs.existsSync(f)) fs.appendFileSync(f, `revision ${k}\n`);
      else w(doc, `# add\nAC-1 add.sh a b prints a+b (v${k})\n`);
      verdict('advance');
    },
    'spec-reviewer-1': () => {
      if ((M === 'specrevise' && k <= 3) || M === 'specrevise-forever') return verdict('revert', { target: 'spec', reason: `Round ${k}: AC-1 contradicts section 3.` });
      verdict('advance');
    },
    'tests-author-0': () => {
      const cases = ['2 3 5']; if (k >= 2) cases.push('-1 1 0'); if (k >= 3) cases.push('0 0 0');
      w('tests/add.test.sh', cases.map((c) => { const [x, y, z] = c.split(' '); return `[ "$(sh src/add.sh ${x} ${y})" = "${z}" ] || exit 1`; }).join('\n') + '\n');
      w(`tests/caf${String.fromCodePoint(0xe9)}.test.sh`, 'true\n'); // é as one code point: git quotes a non-ASCII path unless asked not to
      verdict('advance');
    },
    'tests-reviewer-1': () => {
      if (k === 1) return verdict('revert', { target: 'tests', reason: 'No negative-number case.' });
      // reviewfail: blocks on the visit after review's revert, once the tests author has committed new work.
      if (M === 'reviewfail' && k === 3) return verdict('blocked', { reason: 'Needs a human decision on the zero case.' });
      if (M === 'reviewfail' && k === 4) { // commits behind the driver's back, which leaves a clean tree
        w('tests/reviewer-was-here.test.sh', 'true\n');
        execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });
        execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'reviewer edit'], { stdio: 'ignore' });
      }
      // route: an advance with no "reason" key at all, as GLM once wrote.
      verdict('advance', M === 'route' && k === 3 ? { reason: undefined } : {});
    },
    'implement-author-0': () => {
      // keepwork: visit 4 follows the goto and breaks the write policy; visit 5 revises the kept draft.
      if (M === 'keepwork' && k === 4) { w('tests/add.test.sh', 'exit 0\n'); return verdict('advance'); }
      if (M === 'keepwork' && k === 5) { fs.appendFileSync(path.join(dir, 'src/add.sh'), '# revised after the ship gate\n'); return verdict('advance'); }
      if (M === 'openspec-livespec' && k === 1) { w('openspec/specs/x/spec.md', 'edited by implement\n'); w('src/add.sh', 'echo $(($1 + $2))\n'); return verdict('advance'); }
      if (k === 1) { w('tests/add.test.sh', 'exit 0\n'); w('src/add.sh', 'echo nope\n'); return verdict('advance'); } // cheat: edits tests
      if (M === 'restore' && k === 2) fs.rmSync(path.join(dir, 'src/old.sh')); // a deletion the restore must bring back
      w('src/add.sh', 'echo $(($1 + $2))\n');
      if (OS && !(M === 'openspec-bad' && k === 2)) w(doc + 'tasks.md', '## 1. Implementation\n\n- [x] 1.1 add.sh prints the sum\n');
      verdict('advance');
    },
    'review-reviewer-1': () => k === 1 ? verdict('revert', { target: 'tests', reason: 'Zero case untested; add a test first.' }) : verdict('advance'),
    // route: the second reviewer disagrees with the first about where the defect goes.
    'review-reviewer-2': () => M === 'route' && k === 1 ? verdict('revert', { target: 'implement', reason: 'No test can reach the zero case; fix add.sh directly.' }) : verdict('advance'),
    'ship-author-0': () => { if (M !== 'ship') w('CHANGELOG.md', '- add.sh\n'); w('.pipeline/run/pr.md', '# Add add.sh\n\nAdds it.\n'); verdict('advance'); },
  };
  if (M === 'greentests' && key === 'tests-author-0') { w('tests/add.test.sh', 'exit 0\n'); verdict('advance'); }
  else if (M === 'noverdict' && key === 'spec-author-0') { /* goes idle, never writes a verdict */ }
  else if (M === 'badrevert' && key === 'implement-author-0') verdict('revert', { target: 'spec', reason: 'AC-1 is ambiguous about overflow.' });
  else if (M === 'quota' && key === 'implement-author-0') { /* dies on a quota error below */ }
  else if (M?.startsWith('keepwork-') && key === 'tests-author-0' && k === 3) verdict('blocked', { reason: 'No test can reach this defect.' }); // after review's revert
  else if (M === 'restore' && key === 'implement-author-0' && k === 3) verdict('blocked', { reason: 'Needs a human.' }); // on its restored draft
  else if (M === 'route' && key === 'tests-author-0' && k === 3) verdict('advance', { summary: 'Tests cover AC-1; left the zero case to implement, since no test can reach it.' }); // changes nothing
  else S[key]();
  const id = `t${process.pid}`;
  const quota = M === 'quota' && key === 'implement-author-0';
  // A repo's own output, full of billing, 401 and quota words, which must not read as a quota or account failure.
  const idle = M === 'noverdict' && key === 'spec-author-0';
  fs.writeFileSync(termFile(id), JSON.stringify({ id, exited: quota, code: quota ? 1 : 0,
    text: quota ? '> pipeline · glm-5.3\nError: Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-23'
      : idle ? 'M src/billing/invoice.ts\n✓ returns 401 Unauthorized without a token\n✓ rate_limit_exceeded after 5 tries\n✓ quota.ts usage limit for metered plans\n✓ Your sign-in has expired. Sign in again to continue.'
      : `${key} done` }));
  out({ kind: 'terminal', sessionId: id, label: key });
}
// FAKE_HOOKLESS: a row Paradev installs no state hooks for, so the driver must never wait on it.
if (c1 === 'agents' && c2 === 'wait' && process.env.FAKE_HOOKLESS) { process.stderr.write('fake: agents wait on a hookless terminal'); process.exit(1); }
if (c1 === 'agents' && c2 === 'wait') out({ terminalId: flag('terminal'), state: 'idle', lastEventType: 'Stop' });
if (c1 === 'agents' && c2 === 'explain') out({ state: process.env.FAKE_HOOKLESS ? 'none' : 'idle', because: 'fake', details: [], lastEventType: null, lastEventAt: null });
out('');
