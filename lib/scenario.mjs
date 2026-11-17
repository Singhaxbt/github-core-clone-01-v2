// The one seeded scenario every check's data derives from. All values come from the
// competition's fixed seed; the generation order below is the contract, so the viewer,
// repository names, paths, blobs, commits, issues and pull requests land exactly where
// the suite expects them. Written from the spec, in this module's own shape.

const MASK = 0xffffffffffffffffn;
const SEED = 0x6a09e667f3bcc909n;
const EPOCH = 1735689600;

const FIRST = ['ada','bram','cora','dmitri','elena','felix','greta','hugo','iris','jonas','kira','lars','mira','nico','olga','pavel','quinn','rosa','sven','tess','ulla','vito','wren','yara','zane'];
const LAST = ['anders','bauer','costa','dahl','eriksen','fischer','garcia','holm','iversen','jansen','keller','lind','moreau','novak','olsen','peters','quist','rossi','sato','turi','ulrich','vega','weber','xu','yilmaz','zimmer'];
const ADJ = ['amber','brisk','calm','crisp','eager','faint','gentle','happy','idle','jolly','keen','lively','mellow','nimble','open','plain','quick','quiet','rapid','soft','steady','tidy','upbeat','vivid','warm','witty','young','zesty'];
const NOUN = ['acorn','badger','canyon','cedar','comet','coral','delta','ember','falcon','glade','harbor','indigo','juniper','kettle','lantern','meadow','nebula','orchid','pebble','quartz','raven','saffron','thistle','umber','violet','willow','yarrow','zephyr'];
const DESC = ['a small service with a sharp edge','notes and experiments, kept until they are not','the tooling behind the thing','a reference implementation, for reading','what the prototype became','fixtures, generators and the odd benchmark','the parts that must not break','a sandbox for the next idea'];
const SEGS = ['src','lib','docs','test','scripts','api','core','util','config','data','web','cli','pkg','internal','examples','assets','build','tools','server','client'];
const STEMS = ['index','request','response','server','client','schema','parser','router','config','store','clock','queue','render','format','validate','session','token','event','stream','cache'];
const EXTS = ['ts','js','json','md','txt','yml','toml','css','html','sql'];
const WORDS = ['alpha','bravo','charlie','delta','echo','foxtrot','golf','hotel','india','juliet','kilo','lima','mike','november','oscar','papa','quebec','romeo','sierra','tango','uniform','victor','whiskey','xray','yankee','zulu','amber','basalt','cobalt','drift','ember','frost','granite','hollow','ivory','jasper','kelp','lichen','moss','nickel'];
const VERBS = ['Add','Fix','Refactor','Document','Test','Tidy','Speed up','Simplify','Handle','Extract','Inline','Rename','Guard','Wire','Drop'];
const OBJECTS = ['the request parser','repo lookup','issue pagination','the merge path','token checks','the clone endpoint','packfile handling','error bodies','branch listing','the GraphQL node query','MCP tool dispatch','rate limit headers','the upload pack','the ref advertisement','commit ancestry'];
const ISSUE_ADJ = ['Broken','Slow','Missing','Confusing','Unexpected','Flaky','Incorrect','Unclear','Stale','Noisy'];
const ISSUE_SUBJ = ['clone over HTTP','push report-status','issue pagination','merge button','GraphQL node ids','MCP tool list','shallow fetch','tag listing','repo creation','content update','branch deletion','commit listing'];
const PULL_VERBS = ['Add','Fix','Improve','Simplify','Document','Refactor','Speed up','Harden'];
const PULL_SUBJ = ['shallow fetch support','push report status checks','issue label validation','merge conflict detection','GraphQL cursor pagination','MCP tool schemas','packfile delta reuse','conditional requests','repo pagination','branch protection stubs'];
const SENT_A = ['Steps to reproduce are below','This showed up after the last change','The expected behaviour is clear','A minimal case is attached','It works on a fresh repository','The same flow works over the API'];
const SENT_B = ['and the server answers with a JSON error','but the second request fails','and nothing is written to the log','while the reply body stays empty','and the status is wrong for the method','so the client gives up'];
const LABELS = ['bug','enhancement','documentation','question','good first issue','help wanted'];
const KINDS = ['feature','fix','perf','docs','chore'];
const BASE_BRANCHES = ['main','develop','release/1.0'];

function fnv(text) {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) { h ^= BigInt(text.charCodeAt(i)); h = (h * 0x100000001b3n) & MASK; }
  return h;
}

function mix(v) {
  let z = (v + 0x9e3779b97f4a7c15n) & MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
  return (z ^ (z >> 31n)) & MASK;
}

class Stream {
  constructor(seed) { const m = seed & MASK; this.s = m === 0n ? SEED : m; }
  static labelled(label) { return new Stream(mix(SEED ^ fnv(label))); }
  next64() {
    let x = this.s;
    x = (x ^ (x >> 12n)) & MASK;
    x = (x ^ (x << 25n)) & MASK;
    x = (x ^ (x >> 27n)) & MASK;
    this.s = x;
    return (x * 0x2545f4914f6cdd1dn) & MASK;
  }
  next32() { return Number(this.next64() >> 32n); }
  int(max) {
    if (max === 1) return 0;
    const range = 4294967296, limit = range - (range % max);
    for (;;) { const v = this.next32(); if (v < limit) return v % max; }
  }
  frac() { return this.next32() / 4294967296; }
  chance(p) { return this.frac() < p; }
  pick(list) { return list[this.int(list.length)]; }
  shuffle(list) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) { const j = this.int(i + 1); const t = out[i]; out[i] = out[j]; out[j] = t; }
    return out;
  }
}

function usersOf(rng, count) {
  const used = new Set(), out = [];
  for (let i = 0; i < count; i++) {
    const first = rng.pick(FIRST), last = rng.pick(LAST);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base, n = 2;
    while (used.has(login)) { login = `${base}-${n}`; n++; }
    used.add(login);
    out.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return out;
}

function reposOf(rng, owner, count, firstId) {
  const used = new Set(), out = [];
  for (let i = 0; i < count; i++) {
    const base = `${rng.pick(ADJ)}-${rng.pick(NOUN)}`;
    let name = base, n = 2;
    while (used.has(name)) { name = `${base}-${n}`; n++; }
    used.add(name);
    out.push({ id: firstId + i, owner, name, fullName: `${owner}/${name}`, description: rng.pick(DESC), private: i % 7 === 3, defaultBranch: 'main' });
  }
  return out;
}

function pathsOf(rng, count) {
  const used = new Set(), out = [];
  for (let i = 0; i < count; i++) {
    const depth = rng.int(3) === 0 ? 0 : 1 + rng.int(2);
    const dirs = depth === 0 ? [] : rng.shuffle(SEGS).slice(0, depth);
    const base = [...dirs, `${rng.pick(STEMS)}.${rng.pick(EXTS)}`].join('/');
    let path = base, n = 2;
    while (used.has(path)) { path = [...dirs, `${n}-${base.split('/').pop()}`].join('/'); n++; }
    used.add(path);
    out.push(path);
  }
  return out;
}

function blobText(rng, size) {
  let out = '';
  while (out.length < size) {
    out += rng.pick(WORDS);
    if (out.length < size) out += rng.chance(0.14) ? '\n' : ' ';
  }
  return out.slice(0, size);
}

function blobOf(rng, path, size) {
  const content = blobText(rng, size);
  return { path, content, base64: Buffer.from(content, 'utf8').toString('base64') };
}

function sentenceOf(rng) { return `${rng.pick(SENT_A)} ${rng.pick(SENT_B)}.`; }

function bodyOf(rng) {
  const n = 1 + rng.int(3), parts = [];
  for (let i = 0; i < n; i++) parts.push(sentenceOf(rng));
  return parts.join(' ');
}

function commitMsg(rng) {
  const head = `${rng.pick(VERBS)} ${rng.pick(OBJECTS)}`;
  return rng.chance(0.35) ? `${head}\n\n${sentenceOf(rng)}` : head;
}

function commitOf(rng, author) {
  const epochSec = EPOCH + rng.int(90 * 24 * 60 * 60);
  return { message: commitMsg(rng), author, epochSec, iso: new Date(epochSec * 1000).toISOString() };
}

function issueOf(rng) {
  return { title: `${rng.pick(ISSUE_ADJ)} ${rng.pick(ISSUE_SUBJ)}`, body: bodyOf(rng), labels: rng.chance(0.5) ? [rng.pick(LABELS)] : [] };
}

function branchName(rng) {
  const kind = rng.pick(KINDS);
  const subject = rng.pick(PULL_SUBJ).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${kind}/${subject}`;
}

function pullOf(rng) {
  return { title: `${rng.pick(PULL_VERBS)} ${rng.pick(PULL_SUBJ)}`, body: bodyOf(rng), head: branchName(rng), base: 'main' };
}

function uniqueBranch(rng, used) {
  let branch = branchName(rng), n = 2;
  while (used.has(branch)) { branch = `${branchName(rng)}-${n}`; n++; }
  used.add(branch);
  return branch;
}

let cached = null;

export function buildScenario() {
  if (cached) return cached;
  const users = usersOf(Stream.labelled('users'), 12);
  const viewer = users[0], teammate = users[1], stranger = users[2];
  const orgRng = Stream.labelled('org');
  const org = `${orgRng.pick(ADJ)}-${orgRng.pick(NOUN)}-org`;
  const branchRng = Stream.labelled('branches');
  const branchSet = new Set(BASE_BRANCHES);
  for (let i = 0; i < 8; i++) uniqueBranch(branchRng, branchSet);
  const filePaths = pathsOf(Stream.labelled('paths'), 60);
  const blobRng = Stream.labelled('blobs');
  const blobs = filePaths.slice(0, 24).map((path) => blobOf(blobRng, path, 64 + blobRng.int(4033)));
  const commitRng = Stream.labelled('commits');
  const commits = Array.from({ length: 60 }, () => commitOf(commitRng, commitRng.pick(users)));
  const issueRng = Stream.labelled('issues');
  const issues = Array.from({ length: 60 }, () => issueOf(issueRng));
  const pullRng = Stream.labelled('pulls');
  const pulls = Array.from({ length: 30 }, () => pullOf(pullRng));
  const repos = reposOf(Stream.labelled('repos.viewer'), viewer.login, 30, 5000);
  const orgRepos = reposOf(Stream.labelled('repos.org'), org, 6, 6000);
  const strangerRepos = reposOf(Stream.labelled('repos.stranger'), stranger.login, 3, 7000);
  cached = {
    seed: '6a09e667f3bcc909', viewer, teammate, stranger, users, org, repos, orgRepos, strangerRepos,
    labels: LABELS, branches: [...branchSet], filePaths, blobs, commits, issues, pulls,
  };
  return cached;
}

export const SCENARIO_EPOCH_SEC = EPOCH;
export const DEFAULT_BRANCH = 'main';
