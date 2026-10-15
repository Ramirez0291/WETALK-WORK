// 极简 JSON 持久化。只有 server.mjs 这一个进程写盘，MCP 端通过 HTTP 访问，避免并发写冲突。
import fs from 'node:fs';
import path from 'node:path';

export function createStore(file) {
  let db = {
    nextThreadId: 1, nextPostId: 1, nextProposalId: 1, nextSpaceId: 1, nextRunId: 1,
    threads: [], posts: [], memories: {}, proposals: [], spaces: [], runs: [],
  };
  if (fs.existsSync(file)) db = { ...db, ...JSON.parse(fs.readFileSync(file, 'utf8')) };

  // 记忆空间：记忆按「空间 / 参与者」归属。shared 是跨议题共享的长期记忆，其它空间互相隔离，可以从某个空间分支出来。
  // 旧数据里的记忆键没有空间前缀，统一归入 shared。
  if (!db.spaces.some((s) => s.id === 'shared')) {
    db.spaces.unshift({ id: 'shared', name: '全局共享（长期记忆）', parent: null, createdAt: new Date().toISOString() });
  }
  for (const key of Object.keys(db.memories)) {
    if (!key.includes('/')) {
      db.memories[`shared/${key}`] = db.memories[key];
      delete db.memories[key];
    }
  }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, file);
  }

  const postsOf = (threadId) => db.posts.filter((p) => p.threadId === threadId);

  return {
    listThreads() {
      return db.threads
        .map((t) => {
          const posts = postsOf(t.id);
          const last = posts[posts.length - 1];
          return { ...t, postCount: posts.length, lastAt: last?.createdAt ?? t.createdAt, lastAuthor: last?.author };
        })
        .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
    },

    getThread(id) {
      const thread = db.threads.find((t) => t.id === id);
      return thread ? { ...thread, posts: postsOf(id) } : null;
    },

    createThread({ title, author, kind, via, content, memoryMode = 'rw', memorySpace = 'shared' }) {
      const thread = { id: db.nextThreadId++, title, createdBy: author, createdAt: new Date().toISOString(), memoryMode, memorySpace };
      db.threads.push(thread);
      const post = content ? this.addPost({ threadId: thread.id, author, kind, via, content }, false) : null;
      save();
      return { thread, post };
    },

    updateThread(id, patch) {
      const thread = db.threads.find((t) => t.id === id);
      if (!thread) return null;
      Object.assign(thread, patch);
      save();
      return thread;
    },

    // extra：agent / memory，以及表决相关的 type / proposalId / version / round / vote / result / rationale
    addPost({ threadId, author, kind, via, content, ...extra }, persist = true) {
      if (!db.threads.some((t) => t.id === threadId)) throw new Error(`议题 #${threadId} 不存在`);
      const post = { id: db.nextPostId++, threadId, author, kind, via, content, createdAt: new Date().toISOString() };
      for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null) post[k] = v;
      db.posts.push(post);
      if (persist) save();
      return post;
    },

    getPost(id) {
      return db.posts.find((p) => p.id === id) ?? null;
    },

    patchPost(id, patch) {
      const post = db.posts.find((p) => p.id === id);
      if (!post) return null;
      Object.assign(post, patch);
      save();
      return post;
    },

    deletePost(id) {
      const i = db.posts.findIndex((p) => p.id === id);
      if (i < 0) return null;
      const [post] = db.posts.splice(i, 1);
      save();
      return post;
    },

    deleteThread(id) {
      const before = db.threads.length;
      db.threads = db.threads.filter((t) => t.id !== id);
      db.posts = db.posts.filter((p) => p.threadId !== id);
      db.proposals = db.proposals.filter((p) => p.threadId !== id);
      save();
      return db.threads.length !== before;
    },

    // 参与者改名：历史发言的作者和记忆本里的名字一起更新，返回改动的条数
    renameAuthor(from, to) {
      let n = 0;
      for (const p of db.posts) if (p.kind === 'ai' && p.author === from) (p.author = to), n++;
      for (const revs of Object.values(db.memories)) for (const r of revs) if (r.name === from) (r.name = to), n++;
      if (n) save();
      return n;
    },

    // ---------- 表决 ----------
    // 提案只存流程状态（版本、轮次、结果）；提案正文、每一张票、结果说明都作为发言存在 posts 里

    createProposal(data) {
      const proposal = {
        id: db.nextProposalId++,
        status: 'open', // open / passed / deadlock / withdrawn
        stage: 'vote', // 下一步：vote / discuss / draft
        waiting: null, // 'draft'：等主持人起草
        versions: [],
        rounds: [],
        createdAt: new Date().toISOString(),
        ...data,
      };
      db.proposals.push(proposal);
      save();
      return proposal;
    },

    getProposal(id) {
      return db.proposals.find((p) => p.id === id) ?? null;
    },

    proposalsOf(threadId) {
      return db.proposals.filter((p) => p.threadId === threadId);
    },

    mutateProposal(id, fn) {
      const p = db.proposals.find((x) => x.id === id);
      if (!p) return null;
      fn(p);
      save();
      return p;
    },

    votesOf(proposalId, round) {
      return db.posts.filter((p) => p.type === 'vote' && p.proposalId === proposalId && p.round === round);
    },

    // ---------- 调度记录：每次讨论 / 唱票实际排出的顺序和随机种子 ----------

    createRun(data) {
      const run = { id: db.nextRunId++, createdAt: new Date().toISOString(), ...data };
      db.runs.push(run);
      save();
      return run;
    },

    runsOf(threadId) {
      return db.runs.filter((r) => r.threadId === threadId);
    },

    // ---------- 记忆空间 ----------

    listSpaces() {
      return db.spaces;
    },

    getSpace(id) {
      return db.spaces.find((s) => s.id === id) ?? null;
    },

    // parent 不为空时，把父空间里每本记忆的当前版本复制过来作为起点，并记下来源版本
    createSpace({ name, parent = null }) {
      const id = `sp${db.nextSpaceId++}`;
      const from = parent ? db.spaces.find((s) => s.id === parent) : null;
      const snapshot = {};
      if (from) {
        for (const [key, revs] of Object.entries(db.memories)) {
          if (!key.startsWith(`${from.id}/`) || !revs.length) continue;
          const cur = revs[revs.length - 1];
          const owner = key.slice(from.id.length + 1);
          snapshot[owner] = cur.version;
          db.memories[`${id}/${owner}`] = [
            { version: 1, name: cur.name, content: cur.content, source: 'fork', base: 0, from: { space: from.id, version: cur.version }, threadId: null, postId: null, createdAt: new Date().toISOString() },
          ];
        }
      }
      const space = { id, name, parent: from ? { space: from.id, versions: snapshot } : null, createdAt: new Date().toISOString() };
      db.spaces.push(space);
      save();
      return space;
    },

    // ---------- 记忆本：按「空间/参与者」存，每次修改都存为新版本 ----------

    memoryKeys(space) {
      return Object.keys(db.memories).filter((k) => !space || k.startsWith(`${space}/`));
    },

    memoryHistory(key) {
      return db.memories[key] ?? [];
    },

    getMemory(key) {
      const revs = db.memories[key];
      return revs?.length ? revs[revs.length - 1] : null;
    },

    // base：写入者读到的是第几版（0 表示读到的是空的），用于发现写入冲突
    addMemory(key, { name, content, source, threadId = null, postId = null, base = null }) {
      const revs = (db.memories[key] ??= []);
      const rev = { version: revs.length + 1, name, content, source, base, threadId, postId, createdAt: new Date().toISOString() };
      revs.push(rev);
      save();
      return rev;
    },
  };
}
