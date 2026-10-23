const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json' }
});

export class QuizRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.loaded = false;
    this.data = {
      phase: 'idle',            // idle | open | locked | timeout
      questionNumber: 0,
      questionText: '',
      countdownEnd: null,
      winner: null,
      players: {},              // id -> { group, name, token, lastSeen }
    };
  }

  async load() {
    const saved = await this.state.storage.get('data');
    if (saved) this.data = saved;
  }

  save() {
    this.state.storage.put('data', this.data); // fire-and-forget
  }

  async fetch(request) {
    if (!this.loaded) { await this.load(); this.loaded = true; }
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/join' && request.method === 'POST') {
      return this.join(await request.json());
    }
    if (path === '/api/buzz' && request.method === 'POST') {
      return this.buzz(await request.json());
    }
    if (path === '/api/state' && request.method === 'GET') {
      return this.getPlayerState(url);
    }
    if (path === '/api/admin/state' && request.method === 'GET') {
      return this.getAdminState(url);
    }
    if (path === '/api/admin/action' && request.method === 'POST') {
      return this.adminAction(await request.json());
    }
    return json({ error: 'not found' }, 404);
  }

  join({ group, name, code }) {
    const expectedCode = this.env.JOIN_CODE || '';
    if (expectedCode && code !== expectedCode) {
      return json({ ok: false, error: '邀请码错误' }, 403);
    }
    group = Number(group);
    if (!(group >= 1 && group <= 10)) {
      return json({ ok: false, error: '组号需在 1-10 之间' }, 400);
    }
    name = String(name || '').trim().slice(0, 20);
    if (!name) return json({ ok: false, error: '请输入昵称' }, 400);

    const occupied = Object.values(this.data.players).find(p => p.group === group);
    if (occupied) {
      return json({ ok: false, error: `第 ${group} 组已被占用` }, 409);
    }

    const id = crypto.randomUUID();
    const token = crypto.randomUUID();
    this.data.players[id] = { group, name, token, lastSeen: Date.now() };
    this.save();
    return json({ ok: true, playerId: id, token });
  }

  buzz({ playerId, token }) {
    const p = this.data.players[playerId];
    if (!p || p.token !== token) return json({ ok: false, error: '身份无效' }, 401);
    p.lastSeen = Date.now();

    if (this.data.phase !== 'open') {
      return json({ ok: false, error: '当前不可抢答', phase: this.data.phase });
    }
    if (this.data.countdownEnd && Date.now() > this.data.countdownEnd) {
      this.data.phase = 'timeout';
      this.save();
      return json({ ok: false, error: '时间到' });
    }

    // 同步原子操作：DO 串行处理请求，这里没有 await，先到先得
    this.data.phase = 'locked';
    this.data.winner = {
      group: p.group,
      name: p.name,
      playerId,
      time: Date.now(),
    };
    this.save();
    return json({ ok: true, winner: this.data.winner });
  }

  getPlayerState(url) {
    const playerId = url.searchParams.get('playerId');
    const token = url.searchParams.get('token');
    const p = this.data.players[playerId];
    if (p && p.token === token) p.lastSeen = Date.now();

    if (this.data.phase === 'open' && this.data.countdownEnd && Date.now() > this.data.countdownEnd) {
      this.data.phase = 'timeout';
      this.save();
    }

    const me = p && p.token === token ? { group: p.group, name: p.name } : null;
    return json({
      ok: true,
      phase: this.data.phase,
      questionNumber: this.data.questionNumber,
      questionText: this.data.questionText,
      countdownEnd: this.data.countdownEnd,
      winner: this.data.winner,
      me,
      playerCount: Object.keys(this.data.players).length,
    });
  }

  getAdminState(url) {
    if (url.searchParams.get('password') !== (this.env.ADMIN_PASSWORD || 'admin123')) {
      return json({ ok: false, error: '密码错误' }, 401);
    }
    if (this.data.phase === 'open' && this.data.countdownEnd && Date.now() > this.data.countdownEnd) {
      this.data.phase = 'timeout';
      this.save();
    }
    const players = Object.entries(this.data.players).map(([id, p]) => ({
      id, group: p.group, name: p.name, lastSeen: p.lastSeen,
      online: Date.now() - p.lastSeen < 15000,
    }));
    return json({
      ok: true,
      phase: this.data.phase,
      questionNumber: this.data.questionNumber,
      questionText: this.data.questionText,
      countdownEnd: this.data.countdownEnd,
      winner: this.data.winner,
      players,
    });
  }

  adminAction(body) {
    const { password, action, payload = {} } = body;
    if (password !== (this.env.ADMIN_PASSWORD || 'admin123')) {
      return json({ ok: false, error: '密码错误' }, 401);
    }
    switch (action) {
      case 'setQuestion':
        this.data.questionText = String(payload.text || '');
        if (payload.next) this.data.questionNumber += 1;
        this.data.phase = 'idle';
        this.data.winner = null;
        this.data.countdownEnd = null;
        break;
      case 'open': {
        if (!this.data.questionText.trim()) return json({ ok: false, error: '请先设置题目' });
        this.data.phase = 'open';
        this.data.winner = null;
        const seconds = Number(payload.seconds) || 10;
        this.data.countdownEnd = Date.now() + seconds * 1000;
        break;
      }
      case 'lock':
        this.data.phase = 'locked';
        break;
      case 'reset':
        this.data.phase = 'idle';
        this.data.winner = null;
        this.data.countdownEnd = null;
        break;
      case 'kick':
        delete this.data.players[payload.playerId];
        break;
      case 'clearPlayers':
        this.data.players = {};
        break;
      case 'resetAll':
        this.data = {
          phase: 'idle', questionNumber: 0, questionText: '',
          countdownEnd: null, winner: null, players: {},
        };
        break;
      default:
        return json({ ok: false, error: '未知操作' }, 400);
    }
    this.save();
    return json({ ok: true });
  }
}