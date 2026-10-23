const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  });

export async function onRequest(context) {
  const { request, env, params } = context;
  const path = '/' + (Array.isArray(params.path) ? params.path.join('/') : (params.path || ''));

  try {
    if (path === '/join' && request.method === 'POST') return await join(request, env);
    if (path === '/buzz' && request.method === 'POST') return await buzz(request, env);
    if (path === '/state' && request.method === 'GET') return await getPlayerState(request, env);
    if (path === '/admin/state' && request.method === 'GET') return await getAdminState(request, env);
    if (path === '/admin/action' && request.method === 'POST') return await adminAction(request, env);
  } catch (e) {
    return json({ ok: false, error: '服务器错误: ' + e.message }, 500);
  }

  return json({ error: 'not found' }, 404);
}

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

  const game = await env.DB.prepare('SELECT phase, countdown_end FROM game WHERE id = 1').first();
  if (game.phase !== 'open') {
    return json({ ok: false, error: '当前不可抢答', phase: game.phase });
  }
  if (game.countdown_end && Date.now() > game.countdown_end) {
    await env.DB.prepare(
      "UPDATE game SET phase = 'timeout', countdown_end = NULL WHERE id = 1 AND phase = 'open'"
    ).run();
    return json({ ok: false, error: '时间到' });
  }

  // 原子操作：只有 phase 仍是 'open' 时更新才成功，先到者胜
  const now = Date.now();
  const result = await env.DB.prepare(
    "UPDATE game SET phase = 'locked', winner_group = ?, winner_name = ?, winner_time = ? WHERE id = 1 AND phase = 'open'"
  ).bind(player.group_num, player.name, now).run();

  if (result.meta.changes === 0) {
    const after = await env.DB.prepare('SELECT winner_group, winner_name FROM game WHERE id = 1').first();
    return json({ ok: false, error: '慢了一步', winner: after });
  }

  return json({ ok: true, winner: { group: player.group_num, name: player.name, time: now } });
}

async function getPlayerState(request, env) {
  const url = new URL(request.url);
  const playerId = url.searchParams.get('playerId');
  const token = url.searchParams.get('token');

  const game = await env.DB.prepare('SELECT * FROM game WHERE id = 1').first();

  if (game.phase === 'open' && game.countdown_end && Date.now() > game.countdown_end) {
    await env.DB.prepare(
      "UPDATE game SET phase = 'timeout', countdown_end = NULL WHERE id = 1 AND phase = 'open'"
    ).run();
    game.phase = 'timeout';
  }

  let me = null;
  if (playerId && token) {
    const p = await env.DB
      .prepare('SELECT group_num, name FROM players WHERE id = ? AND token = ?')
      .bind(playerId, token).first();
    if (p) me = { group: p.group_num, name: p.name };
  }

  const countRow = await env.DB.prepare('SELECT COUNT(*) AS c FROM players').first();

  return json({
    ok: true,
    phase: game.phase,
    questionNumber: game.question_number,
    questionText: game.question_text,
    countdownEnd: game.countdown_end,
    winner: game.winner_group ? { group: game.winner_group, name: game.winner_name, time: game.winner_time } : null,
    me,
    playerCount: countRow.c
  });
}

async function getAdminState(request, env) {
  const url = new URL(request.url);
  if (url.searchParams.get('password') !== (env.ADMIN_PASSWORD || 'admin123')) {
    return json({ ok: false, error: '密码错误' }, 401);
  }

  const game = await env.DB.prepare('SELECT * FROM game WHERE id = 1').first();
  if (game.phase === 'open' && game.countdown_end && Date.now() > game.countdown_end) {
    await env.DB.prepare(
      "UPDATE game SET phase = 'timeout', countdown_end = NULL WHERE id = 1 AND phase = 'open'"
    ).run();
    game.phase = 'timeout';
  }

  const playersRes = await env.DB
    .prepare('SELECT id, group_num, name FROM players ORDER BY group_num').all();
  const players = (playersRes.results || []).map(p => ({
    id: p.id, group: p.group_num, name: p.name
  }));

  return json({
    ok: true,
    phase: game.phase,
    questionNumber: game.question_number,
    questionText: game.question_text,
    countdownEnd: game.countdown_end,
    winner: game.winner_group ? { group: game.winner_group, name: game.winner_name, time: game.winner_time } : null,
    players
  });
}

async function adminAction(request, env) {
  const { password, action, payload = {} } = await request.json();
  if (password !== (env.ADMIN_PASSWORD || 'admin123')) {
    return json({ ok: false, error: '密码错误' }, 401);
  }

  if (action === 'setQuestion') {
    const text = String(payload.text || '');
    if (payload.next) {
      await env.DB.prepare(
        "UPDATE game SET question_number = question_number + 1, question_text = ?, phase = 'idle', winner_group = NULL, winner_name = NULL, winner_time = NULL, countdown_end = NULL WHERE id = 1"
      ).bind(text).run();
    } else {
      await env.DB.prepare(
        "UPDATE game SET question_text = ?, phase = 'idle', winner_group = NULL, winner_name = NULL, winner_time = NULL, countdown_end = NULL WHERE id = 1"
      ).bind(text).run();
    }
    return json({ ok: true });
  }

  if (action === 'open') {
    const game = await env.DB.prepare('SELECT question_text FROM game WHERE id = 1').first();
    if (!game.question_text.trim()) return json({ ok: false, error: '请先设置题目' });
    const seconds = Number(payload.seconds) || 10;
    const end = Date.now() + seconds * 1000;
    await env.DB.prepare(
      "UPDATE game SET phase = 'open', winner_group = NULL, winner_name = NULL, winner_time = NULL, countdown_end = ? WHERE id = 1"
    ).bind(end).run();
    return json({ ok: true });
  }

  if (action === 'lock') {
    await env.DB.prepare("UPDATE game SET phase = 'locked' WHERE id = 1 AND phase = 'open'").run();
    return json({ ok: true });
  }

  if (action === 'reset') {
    await env.DB.prepare(
      "UPDATE game SET phase = 'idle', winner_group = NULL, winner_name = NULL, winner_time = NULL, countdown_end = NULL WHERE id = 1"
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

  if (action === 'resetAll') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM players'),
      env.DB.prepare(
        "UPDATE game SET phase = 'idle', question_number = 0, question_text = '', winner_group = NULL, winner_name = NULL, winner_time = NULL, countdown_end = NULL WHERE id = 1"
      )
    ]);
    return json({ ok: true });
  }

  return json({ ok: false, error: '未知操作' }, 400);
}