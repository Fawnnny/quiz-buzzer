const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  });

const PHASE = {
  IDLE: 'idle',
  COUNTDOWN: 'countdown',
  OPEN: 'open',
  LOCKED: 'locked',
  TIMEOUT: 'timeout',
  REVEALED: 'revealed'
};

export async function onRequest(context) {
  const { request, env, params } = context;
  const path = '/' + (Array.isArray(params.path) ? params.path.join('/') : (params.path || ''));

  try {
    if (path === '/join' && request.method === 'POST') return await join(request, env);
    if (path === '/buzz' && request.method === 'POST') return await buzz(request, env);
    if (path === '/state' && request.method === 'GET') return await getPlayerState(request, env);
    if (path === '/display/state' && request.method === 'GET') return await getDisplayState(request, env);
    if (path === '/admin/state' && request.method === 'GET') return await getAdminState(request, env);
    if (path === '/admin/action' && request.method === 'POST') return await adminAction(request, env);
  } catch (e) {
    return json({ ok: false, error: '服务器错误: ' + e.message }, 500);
  }

  return json({ error: 'not found' }, 404);
}

// ============ 状态推进：任何读取都可以推进 countdown→open、open→timeout ============
async function advancePhase(env) {
  const game = await env.DB.prepare('SELECT * FROM game WHERE id = 1').first();
  if (!game) return null;
  const now = Date.now();

  if (game.phase === PHASE.COUNTDOWN && game.prepare_end && now > game.prepare_end) {
    await env.DB.prepare(
      "UPDATE game SET phase = 'open' WHERE id = 1 AND phase = 'countdown'"
    ).run();
    game.phase = PHASE.OPEN;
  }

  if (game.phase === PHASE.OPEN && game.countdown_end && now > game.countdown_end) {
    await env.DB.prepare(
      "UPDATE game SET phase = 'timeout', countdown_end = NULL WHERE id = 1 AND phase = 'open'"
    ).run();
    game.phase = PHASE.TIMEOUT;
  }

  return game;
}

function currentQuestion(game) {
  try {
    const pool = JSON.parse(game.questions_json || '[]');
    const idx = game.current_index ?? -1;
    if (idx >= 0 && idx < pool.length) return pool[idx];
  } catch {}
  return null;
}

function parseScores(game) {
  try { return JSON.parse(game.scores_json || '{}'); } catch { return {}; }
}

// ============ 选手加入 / 抢答 ============
async function join(request, env) {
  const body = await request.json();
  const expectedCode = env.JOIN_CODE || '';
  if (expectedCode && body.code !== expectedCode) {
    return json({ ok: false, error: '邀请码错误' }, 403);
  }
  const group = Number(body.group);
  if (!(group >= 1 && group <= 10)) return json({ ok: false, error: '组号需在 1-10 之间' }, 400);
  const name = String(body.name || '').trim().slice(0, 20);
  if (!name) return json({ ok: false, error: '请输入昵称' }, 400);

  const existing = await env.DB
    .prepare('SELECT id FROM players WHERE group_num = ?')
    .bind(group).first();
  if (existing) return json({ ok: false, error: `第 ${group} 组已被占用` }, 409);

  const id = crypto.randomUUID();
  const token = crypto.randomUUID();
  try {
    await env.DB
      .prepare('INSERT INTO players (id, group_num, name, token, joined_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, group, name, token, Date.now()).run();
  } catch (e) {
    return json({ ok: false, error: '加入失败，该组可能已被占用' }, 409);
  }
  return json({ ok: true, playerId: id, token });
}

async function buzz(request, env) {
  const { playerId, token } = await request.json();
  const player = await env.DB
    .prepare('SELECT group_num, name FROM players WHERE id = ? AND token = ?')
    .bind(playerId, token).first();
  if (!player) return json({ ok: false, error: '身份无效' }, 401);

  const game = await advancePhase(env);
  if (game.phase !== PHASE.OPEN) {
    return json({ ok: false, error: '当前不可抢答', phase: game.phase });
  }
  if (game.countdown_end && Date.now() > game.countdown_end) {
    return json({ ok: false, error: '时间到' });
  }

  const now = Date.now();
  const result = await env.DB.prepare(
    "UPDATE game SET phase = 'locked', winner_group = ?, winner_name = ?, winner_time = ?, countdown_end = NULL WHERE id = 1 AND phase = 'open'"
  ).bind(player.group_num, player.name, now).run();

  if (result.meta.changes === 0) {
    const after = await env.DB.prepare('SELECT winner_group, winner_name FROM game WHERE id = 1').first();
    return json({ ok: false, error: '慢了一步', winner: after });
  }

  return json({ ok: true, winner: { group: player.group_num, name: player.name, time: now } });
}

// ============ 公共状态构建（答案只在揭晓后下发给非主持人端） ============
function buildPublicState(game, players, me, countRow) {
  const q = currentQuestion(game);
  const revealed = !!game.answer_revealed;
  const scores = parseScores(game);

  const base = {
    ok: true,
    phase: game.phase,
    questionNumber: (game.current_index ?? -1) >= 0 ? game.current_index + 1 : 0,
    totalQuestions: game.total_questions || 0,
    questionText: game.question_text || '',
    prepareEnd: game.prepare_end || null,
    countdownEnd: game.countdown_end || null,
    winner: game.winner_group ? { group: game.winner_group, name: game.winner_name, time: game.winner_time } : null,
    answerRevealed: revealed,
    scores,
    playerCount: countRow ? countRow.c : (players ? players.length : 0),
  };

  if (revealed && q) {
    base.revealedAnswer = q.answer || '';
    base.revealedExplanation = q.explanation || '';
  }

  if (me !== undefined) base.me = me;
  if (players) base.players = players;

  return base;
}

async function getPlayerState(request, env) {
  const url = new URL(request.url);
  const playerId = url.searchParams.get('playerId');
  const token = url.searchParams.get('token');

  const game = await advancePhase(env);

  let me = null;
  if (playerId && token) {
    const p = await env.DB
      .prepare('SELECT group_num, name FROM players WHERE id = ? AND token = ?')
      .bind(playerId, token).first();
    if (p) me = { group: p.group_num, name: p.name };
  }

  const countRow = await env.DB.prepare('SELECT COUNT(*) AS c FROM players').first();
  return json(buildPublicState(game, null, me, countRow));
}

async function getDisplayState(request, env) {
  const game = await advancePhase(env);
  const playersRes = await env.DB.prepare('SELECT group_num, name FROM players ORDER BY group_num').all();
  const players = (playersRes.results || []).map(p => ({ group: p.group_num, name: p.name }));
  return json(buildPublicState(game, players, undefined, { c: players.length }));
}

async function getAdminState(request, env) {
  const url = new URL(request.url);
  if (url.searchParams.get('password') !== (env.ADMIN_PASSWORD || 'admin123')) {
    return json({ ok: false, error: '密码错误' }, 401);
  }

  const game = await advancePhase(env);

  const playersRes = await env.DB
    .prepare('SELECT id, group_num, name FROM players ORDER BY group_num').all();
  const players = (playersRes.results || []).map(p => ({
    id: p.id, group: p.group_num, name: p.name
  }));

  const q = currentQuestion(game);
  const scores = parseScores(game);
  const pool = JSON.parse(game.questions_json || '[]');

  return json({
    ok: true,
    phase: game.phase,
    questionNumber: (game.current_index ?? -1) >= 0 ? game.current_index + 1 : 0,
    totalQuestions: game.total_questions || 0,
    currentIndex: game.current_index ?? -1,
    questionText: game.question_text || '',
    prepareEnd: game.prepare_end || null,
    countdownEnd: game.countdown_end || null,
    winner: game.winner_group ? { group: game.winner_group, name: game.winner_name, time: game.winner_time } : null,
    players,
    answerRevealed: !!game.answer_revealed,
    currentAnswer: q ? (q.answer || '') : '',
    currentExplanation: q ? (q.explanation || '') : '',
    scores,
    quizTitle: game.quiz_title || '',
    poolPreview: pool.map(x => x.text)
  });
}

// ============ 主持人操作 ============
async function adminAction(request, env) {
  const { password, action, payload = {} } = await request.json();
  if (password !== (env.ADMIN_PASSWORD || 'admin123')) {
    return json({ ok: false, error: '密码错误' }, 401);
  }

  if (action === 'importQuestions') {
    const raw = payload.questions;
    if (!Array.isArray(raw) || raw.length === 0) {
      return json({ ok: false, error: '题库为空或格式错误' });
    }
    const cleaned = [];
    for (let i = 0; i < raw.length; i++) {
      const q = raw[i] || {};
      const text = String(q.text || '').trim();
      const answer = String(q.answer || '').trim();
      if (!text || !answer) {
        return json({ ok: false, error: `第 ${i + 1} 题缺少题目或答案` });
      }
      cleaned.push({
        text,
        answer,
        explanation: String(q.explanation || '').trim(),
        type: String(q.type || 'single'),
      });
    }
    // Fisher-Yates 打乱，导入即固定顺序
    for (let i = cleaned.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cleaned[i], cleaned[j]] = [cleaned[j], cleaned[i]];
    }
    let picked = cleaned;
    const pickCount = Number(payload.pickCount) || 0;
    if (pickCount > 0 && pickCount < cleaned.length) {
      picked = cleaned.slice(0, pickCount);
    }
    await env.DB.prepare(
      "UPDATE game SET questions_json = ?, total_questions = ?, current_index = -1, quiz_title = ?, phase = 'idle', question_text = '', question_number = 0, winner_group = NULL, winner_name = NULL, winner_time = NULL, countdown_end = NULL, prepare_end = NULL, answer_revealed = 0, scores_json = '{}' WHERE id = 1"
    ).bind(JSON.stringify(picked), picked.length, String(payload.title || '')).run();
    return json({ ok: true, total: picked.length });
  }

  if (action === 'nextFromPool') {
    const game = await env.DB.prepare('SELECT * FROM game WHERE id = 1').first();
    const pool = JSON.parse(game.questions_json || '[]');
    if (pool.length === 0) return json({ ok: false, error: '请先导入题库' });
    const next = (game.current_index ?? -1) + 1;
    if (next >= pool.length) {
      return json({ ok: false, error: '题库已答完' });
    }
    const q = pool[next];
    await env.DB.prepare(
      "UPDATE game SET current_index = ?, question_number = ?, question_text = ?, phase = 'idle', winner_group = NULL, winner_name = NULL, winner_time = NULL, countdown_end = NULL, prepare_end = NULL, answer_revealed = 0 WHERE id = 1"
    ).bind(next, next + 1, q.text).run();
    return json({ ok: true });
  }

  if (action === 'setQuestion') {
    const text = String(payload.text || '');
    if (payload.next) {
      await env.DB.prepare(
        "UPDATE game SET question_number = question_number + 1, question_text = ?, phase = 'idle', winner_group = NULL, winner_name = NULL, winner_time = NULL, countdown_end = NULL, prepare_end = NULL, answer_revealed = 0 WHERE id = 1"
      ).bind(text).run();
    } else {
      await env.DB.prepare(
        "UPDATE game SET question_text = ?, phase = 'idle', winner_group = NULL, winner_name = NULL, winner_time = NULL, countdown_end = NULL, prepare_end = NULL, answer_revealed = 0 WHERE id = 1"
      ).bind(text).run();
    }
    return json({ ok: true });
  }

  // 开始抢答：先准备倒计时 N 秒，再开放抢答 M 秒
  if (action === 'open') {
    const game = await env.DB.prepare('SELECT question_text FROM game WHERE id = 1').first();
    if (!game.question_text || !game.question_text.trim()) {
      return json({ ok: false, error: '请先设置题目' });
    }
    const prepareSeconds = Math.max(0, Number(payload.prepareSeconds) || 0);
    const buzzSeconds = Math.max(1, Number(payload.seconds) || 10);
    const now = Date.now();
    const prepareEnd = now + prepareSeconds * 1000;
    const countdownEnd = prepareEnd + buzzSeconds * 1000;
    const phase = prepareSeconds > 0 ? PHASE.COUNTDOWN : PHASE.OPEN;
    await env.DB.prepare(
      "UPDATE game SET phase = ?, winner_group = NULL, winner_name = NULL, winner_time = NULL, prepare_end = ?, countdown_end = ? WHERE id = 1"
    ).bind(phase, prepareEnd, countdownEnd).run();
    return json({ ok: true });
  }

  if (action === 'lock') {
    await env.DB.prepare(
      "UPDATE game SET phase = 'locked', countdown_end = NULL WHERE id = 1 AND phase = 'open'"
    ).run();
    return json({ ok: true });
  }

  if (action === 'reset') {
    await env.DB.prepare(
      "UPDATE game SET phase = 'idle', winner_group = NULL, winner_name = NULL, winner_time = NULL, countdown_end = NULL, prepare_end = NULL, answer_revealed = 0 WHERE id = 1"
    ).run();
    return json({ ok: true });
  }

  if (action === 'judge') {
    const game = await env.DB.prepare('SELECT * FROM game WHERE id = 1').first();
    const scores = parseScores(game);
    if (game.winner_group) {
      const g = String(game.winner_group);
      const points = Number(payload.points) || 0;
      if (payload.correct) {
        scores[g] = (scores[g] || 0) + points;
      } else {
        const penalty = Number(payload.penalty) || 0;
        if (penalty > 0) scores[g] = (scores[g] || 0) - penalty;
      }
    }
    await env.DB.prepare(
      "UPDATE game SET scores_json = ? WHERE id = 1"
    ).bind(JSON.stringify(scores)).run();
    return json({ ok: true, scores });
  }

  if (action === 'adjustScore') {
    const game = await env.DB.prepare('SELECT * FROM game WHERE id = 1').first();
    const scores = parseScores(game);
    const g = String(payload.group);
    const delta = Number(payload.delta) || 0;
    scores[g] = (scores[g] || 0) + delta;
    await env.DB.prepare(
      "UPDATE game SET scores_json = ? WHERE id = 1"
    ).bind(JSON.stringify(scores)).run();
    return json({ ok: true, scores });
  }

  if (action === 'revealAnswer') {
    await env.DB.prepare(
      "UPDATE game SET answer_revealed = 1, phase = 'revealed' WHERE id = 1"
    ).run();
    return json({ ok: true });
  }

  if (action === 'kick') {
    await env.DB.prepare('DELETE FROM players WHERE id = ?').bind(payload.playerId).run();
    return json({ ok: true });
  }

  if (action === 'clearPlayers') {
    await env.DB.prepare('DELETE FROM players').run();
    return json({ ok: true });
  }

  if (action === 'resetScores') {
    await env.DB.prepare("UPDATE game SET scores_json = '{}' WHERE id = 1").run();
    return json({ ok: true });
  }

  if (action === 'resetAll') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM players'),
      env.DB.prepare(
        "UPDATE game SET phase = 'idle', question_number = 0, current_index = -1, question_text = '', questions_json = '[]', total_questions = 0, quiz_title = '', winner_group = NULL, winner_name = NULL, winner_time = NULL, countdown_end = NULL, prepare_end = NULL, answer_revealed = 0, scores_json = '{}' WHERE id = 1"
      )
    ]);
    return json({ ok: true });
  }

  return json({ ok: false, error: '未知操作' }, 400);
}
