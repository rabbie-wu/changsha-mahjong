// 长沙麻将多人服务器: HTTP静态页 + WebSocket
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('./wsmini.js');
const R = require('./rules.js');

const PORT = process.env.PORT || process.env.SERVER_PORT || 3000;

const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  const file = path.join(__dirname, p);
  if (!file.startsWith(__dirname)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'text/plain' });
    res.end(data);
  });
});
const wss = new WebSocketServer({ server });
server.listen(PORT, '0.0.0.0', () => console.log('mahjong server on ' + PORT));

// ---------------- 房间 ----------------
const rooms = new Map();
function newCode() {
  let c;
  do { c = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms.has(c));
  return c;
}
const BOT_NAMES = ['阿强', '小美', '老李', '花花', '大壮', '妞妞'];

class Room {
  constructor(code) {
    this.code = code;
    this.seats = [null, null, null, null]; // {name, bot, ws, connected}
    this.phase = 'lobby'; // lobby | playing | handEnd
    this.scores = [0, 0, 0, 0];
    this.dealer = 0;
    this.log = [];
    this.resetHand();
  }
  resetHand() {
    this.wall = [];
    this.hands = [[], [], [], []];
    this.melds = [[], [], [], []];
    this.discards = [[], [], [], []];
    this.turn = -1;
    this.lastDiscard = null; // {tile, from}
    this.pending = null;     // {kind:'discard'|'rob', tile, from, claimants:Map, responses:Map, timer}
    this.discardsMade = 0;
    this.lastDrawWasKong = false;
    this.result = null;
    this.turnTimer = null;
  }
  pushLog(s) { this.log.unshift(s); this.log = this.log.slice(0, 10); }
  humans() { return this.seats.filter(s => s && !s.bot); }
  full() { return this.seats.every(Boolean); }
}

function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(room) { room.seats.forEach((s, i) => { if (s && s.ws) send(s.ws, stateFor(room, i)); }); }

function stateFor(room, seat) {
  const st = {
    type: 'state', code: room.code, phase: room.phase, yourSeat: seat,
    dealer: room.dealer, turn: room.turn, wallLeft: room.wall.length,
    scores: room.scores, log: room.log, result: room.result,
    seats: room.seats.map((s, i) => s ? {
      name: s.name, bot: s.bot, connected: s.connected,
      handCount: room.hands[i].length, melds: room.melds[i], discards: room.discards[i],
    } : null),
    lastDiscard: room.lastDiscard,
    yourHand: room.hands[seat] || [],
    options: null, claim: null,
  };
  if (room.phase === 'playing') {
    if (room.turn === seat && !room.pending) st.options = turnOptions(room, seat);
    if (room.pending && room.pending.claimants.has(seat) && !room.pending.responses.has(seat)) {
      st.claim = { tile: room.pending.tile, from: room.pending.from, actions: room.pending.claimants.get(seat) };
    }
  }
  return st;
}

// 当前行动玩家可做的事
function turnOptions(room, seat) {
  const hand = room.hands[seat];
  const counts = R.toCounts(hand);
  const opts = { canHu: false, kongs: [] };
  const win = R.checkWin(counts, room.melds[seat]);
  if (win) opts.canHu = true;
  for (let t = 0; t < 27; t++) if (counts[t] === 4) opts.kongs.push({ tile: t, kind: 'an' });
  for (const m of room.melds[seat]) {
    if (m.kind === 'peng' && counts[m.tile] >= 1) opts.kongs.push({ tile: m.tile, kind: 'bu' });
  }
  return opts;
}

// 某玩家对一张打出牌可声明的动作
function claimOptions(room, seat, tile) {
  const counts = R.toCounts(room.hands[seat]);
  const acts = [];
  counts[tile]++;
  if (R.checkWin(counts, room.melds[seat])) acts.push('hu');
  counts[tile]--;
  if (counts[tile] >= 3) acts.push('gang');
  if (counts[tile] >= 2) acts.push('peng');
  return acts;
}

// ---------------- 对局流程 ----------------
function startHand(room) {
room.resetHand();
// 建墙 108 张
const wall = [];
for (let t = 0; t < 27; t++) for (let k = 0; k < 4; k++) wall.push(t);
for (let i = wall.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [wall[i], wall[j]] = [wall[j], wall[i]];}
room.wall = wall;
for (let n = 0; n < 13; n++) for (let s = 0; s < 4; s++) room.hands[s].push(room.wall.shift());
room.hands.forEach(h => h.sort((a, b) => a - b));
room.phase = 'playing';
// 起手胡: 自动判定, 即时计分, 然后继续打
room.hands.forEach((h, s) => {
const ohs = R.checkOpeningHu(h);
for (const oh of ohs) {
for (let o = 0; o < 4; o++) if (o!== s) { room.scores[o] -= oh.score; room.scores[s] += oh.score;}
room.pushLog(`🎉 ${room.seats[s].name} 起手胡, 每家赔 ${oh.score} 分`);
}
});
room.pushLog(`🀄 新的一局开始, 庄家: ${room.seats[room.dealer].name}`);
doDraw(room, room.dealer, false);
}

function doDraw(room, seat, kongReplacement) {
if (room.wall.length === 0) return endHandDraw(room);
const tile = room.wall.shift();
room.hands[seat].push(tile);
room.hands[seat].sort((a, b) => a - b);
room.turn = seat;
room.lastDrawWasKong =!!kongReplacement;
room.lastDrawnTile = tile;
room.lastDrawWasLast = room.wall.length === 0;
broadcast(room);
scheduleTurn(room, seat);
}

function scheduleTurn(room, seat) {
clearTimeout(room.turnTimer);
const s = room.seats[seat];
if (!s) return;
if (s.bot ||!s.connected) {
room.turnTimer = setTimeout(() => botTurn(room, seat), 350 + Math.random() * 400);
} else {
// 真人 60 秒无操作 -> 自动打出一张
room.turnTimer = setTimeout(() => {
if (room.phase === 'playing' && room.turn === seat &&!room.pending) {
room.pushLog(`⏰ ${s.name} 超时, 自动出牌`);
botDiscard(room, seat);
}
}, 60000);
}
}

function doDiscard(room, seat, tile) {
const idx = room.hands[seat].indexOf(tile);
if (idx < 0) return;
room.hands[seat].splice(idx, 1);
room.discards[seat].push(tile);
room.lastDiscard = { tile, from: seat};
room.discardsMade++;
room.lastDrawWasKong = false;
// 开声明窗口
const claimants = new Map();
for (let k = 1; k <= 3; k++) {
const s = (seat + k) % 4;
const acts = claimOptions(room, s, tile);
if (acts.length) claimants.set(s, acts);
}
if (claimants.size === 0) {
room.lastDiscard = null;
return doDraw(room, (seat + 1) % 4, false);
}
room.pending = { kind: 'discard', tile, from: seat, claimants, responses: new Map()};
room.pending.timer = setTimeout(() => resolveClaims(room), 25000);
broadcast(room);
// 机器人立即响应
for (const s of claimants.keys()) {
const st = room.seats[s];
if (st.bot ||!st.connected) setTimeout(() => botClaim(room, s), 250 + Math.random() * 300);
}
}

function onClaimResponse(room, seat, action) {
const p = room.pending;
if (!p ||!p.claimants.has(seat) || p.responses.has(seat)) return;
if (action!== 'pass' &&!p.claimants.get(seat).includes(action)) action = 'pass';
p.responses.set(seat, action);
if (p.responses.size >= p.claimants.size) resolveClaims(room);
else broadcast(room);
}

function resolveClaims(room) {
const p = room.pending;
if (!p) return;
clearTimeout(p.timer);
room.pending = null;
const order = [1, 2, 3].map(k => (p.from + k) % 4); // 按离放牌者远近
// 胡优先
for (const s of order) {
if (p.responses.get(s) === 'hu') {
room.lastDiscard = null;
if (p.kind === 'rob') {
removeTiles(room.hands[p.kongSeat], p.tile, 1);
room.hands[s].push(p.tile);
return settleWin(room, s, { ronFrom: p.from, robKong: true });
}
room.discards[p.from].pop();
room.hands[s].push(p.tile);
return settleWin(room, s, { ronFrom: p.from });
}
}
if (p.kind === 'rob') {
// 没人抢杠, 补杠成立
return completeAddedKong(room, p.kongSeat, p.tile);
}
for (const s of order) {
if (p.responses.get(s) === 'gang') return doOpenKong(room, s, p.tile, p.from);
}
for (const s of order) {
if (p.responses.get(s) === 'peng') return doPeng(room, s, p.tile, p.from);
}
room.lastDiscard = null;
doDraw(room, (p.from + 1) % 4, false);
}

function doPeng(room, seat, tile, from) {
removeTiles(room.hands[seat], tile, 2);
room.discards[from].pop();
room.melds[seat].push({ kind: 'peng', tile, from});
room.lastDiscard = null;
room.turn = seat;
room.pushLog(`${room.seats[seat].name} 碰 ${R.tileName(tile)}`);
broadcast(room);
scheduleTurn(room, seat);
}

function doOpenKong(room, seat, tile, from) {
removeTiles(room.hands[seat], tile, 3);
room.discards[from].pop();
room.melds[seat].push({ kind: 'gang', tile, from});
room.lastDiscard = null;
// 直杠: 放杠者付 2 分
room.scores[from] -= R.SCORE.gangFromDiscard;
room.scores[seat] += R.SCORE.gangFromDiscard;
room.pushLog(`${room.seats[seat].name} 明杠 ${R.tileName(tile)}, ${room.seats[from].name} 赔 ${R.SCORE.gangFromDiscard} 分`);
doDraw(room, seat, true);
}

// 自己回合的杠 (暗杠/补杠)
function doSelfKong(room, seat, tile, kind) {
if (kind === 'an') {
removeTiles(room.hands[seat], tile, 4);
room.melds[seat].push({ kind: 'gang', tile, concealed: true});
for (let o = 0; o < 4; o++) if (o!== seat) { room.scores[o] -= R.SCORE.gangConcealed; room.scores[seat] += R.SCORE.gangConcealed;}
room.pushLog(`${room.seats[seat].name} 暗杠 ${R.tileName(tile)}, 每家赔 ${R.SCORE.gangConcealed} 分`);
return doDraw(room, seat, true);
}
// 补杠: 先开抢杠窗口
const claimants = new Map();
for (let k = 1; k <= 3; k++) {
const s = (seat + k) % 4;
const counts = R.toCounts(room.hands[s]);
counts[tile]++;
if (R.checkWin(counts, room.melds[s])) claimants.set(s, ['hu']);
}
if (claimants.size === 0) return completeAddedKong(room, seat, tile);
room.pending = { kind: 'rob', tile, from: seat, kongSeat: seat, claimants, responses: new Map()};
room.pending.timer = setTimeout(() => resolveClaims(room), 25000);
broadcast(room);
for (const s of claimants.keys()) {
const st = room.seats[s];
if (st.bot ||!st.connected) setTimeout(() => botClaim(room, s), 600);
}
}

function completeAddedKong(room, seat, tile) {
removeTiles(room.hands[seat], tile, 1);
const m = room.melds[seat].find(m => m.kind === 'peng' && m.tile === tile);
if (m) m.kind = 'gang';
for (let o = 0; o < 4; o++) if (o!== seat) { room.scores[o] -= R.SCORE.gangAdded; room.scores[seat] += R.SCORE.gangAdded;}
room.pushLog(`${room.seats[seat].name} 补杠 ${R.tileName(tile)}, 每家赔 ${R.SCORE.gangAdded} 分`);
doDraw(room, seat, true);
}

function removeTiles(hand, tile, n) {
for (let i = 0; i < n; i++) { const idx = hand.indexOf(tile); if (idx >= 0) hand.splice(idx, 1);}
}

// ---------------- 结算 ----------------
function settleWin(room, winner, opts) {
const counts = R.toCounts(room.hands[winner]);
const win = R.checkWin(counts, room.melds[winner]);
if (!win) return;
const types = win.types.slice();
const tsumo = opts.ronFrom === undefined;
if (tsumo) {
types.push('自摸');
if (room.lastDrawWasKong) types.push('杠上花');
if (room.lastDrawWasLast) types.push('海底捞月');
if (winner === room.dealer && room.discardsMade === 0) types.push('天胡');
} else {
if (opts.robKong) types.push('抢杠胡');
if (room.discardsMade === 1 && winner!== room.dealer) types.push('地胡');
}
const tier = (types.some(t => ['杠上花', '海底捞月', '天胡', '地胡', '抢杠胡'].includes(t)))? 'da': win.tier;
const base = R.SCORE[tier];

// 扎鸟: 从牌墙尾翻 2 张
const birds = [];
for (let i = 0; i < 2 && room.wall.length > 0; i++) birds.push(room.wall.pop());
const hitCount = seat => birds.filter(b => R.birdHitSeat(b, winner) === seat).length;

const deltas = [0, 0, 0, 0];
const detail = [];
if (tsumo) {
for (let o = 0; o < 4; o++) {
if (o === winner) continue;
const mult = Math.pow(2, hitCount(winner)) * Math.pow(2, hitCount(o));
const pay = base.tsumo * mult;
deltas[o] -= pay; deltas[winner] += pay;
detail.push(`${room.seats[o].name} 赔 ${pay} 分${mult > 1? `(扎鸟×${mult})`: ''}`);
}
} else {
const from = opts.ronFrom;
const mult = Math.pow(2, hitCount(winner)) * Math.pow(2, hitCount(from));
const pay = base.ron * mult;
deltas[from] -= pay; deltas[winner] += pay;
detail.push(`${room.seats[from].name} 点炮赔 ${pay} 分${mult > 1? `(扎鸟×${mult})`: ''}`);
}
for (let o = 0; o < 4; o++) room.scores[o] += deltas[o];

room.phase = 'handEnd';
room.result = {
winner, winnerName: room.seats[winner].name, types, tier,
winHand: room.hands[winner].slice(), winMelds: room.melds[winner],
birds, birdHits: birds.map(b => R.birdHitSeat(b, winner)),
detail, deltas, tsumo, scores: room.scores.slice(),
};
room.dealer = winner;
room.pushLog(`🏆 ${room.seats[winner].name} 胡牌`);
if (birds.length) room.pushLog(`🐦 扎鸟: ${birds.map(b => R.tileName(b)).join('、')}`);
broadcast(room);
}

function endHandDraw(room) {
room.phase = 'handEnd';
room.result = { draw: true, detail: ['牌墙摸完, 本局流局'], scores: room.scores.slice()};
room.pushLog('🤝 流局');
broadcast(room);
}

// ---------------- 机器人 ----------------
function tileUsefulness(hand, t) {
const counts = R.toCounts(hand);
let u = 0;
if (counts[t] >= 2) u += 6; // 对/刻
if (R.is258(t)) u += 1; // 将位价值
const s = R.suitOf(t), r = R.rankOf(t);
for (const d of [-2, -1, 1, 2]) {
const nr = r + d;
if (nr >= 1 && nr <= 9 && counts[s * 9 + nr - 1] > 0) u += (Math.abs(d) === 1? 2: 1);
}
if (r === 1 || r === 9) u -= 1; // 边张价值低
return u;
}
function botDiscard(room, seat) {
const hand = room.hands[seat];
let worst = hand[0], worstU = Infinity;
for (const t of hand) { const u = tileUsefulness(hand, t); if (u < worstU) { worstU = u; worst = t;}}
doDiscard(room, seat, worst);
}
function botTurn(room, seat) {
if (room.phase!== 'playing' || room.turn!== seat || room.pending) return;
const opts = turnOptions(room, seat);
if (opts.canHu) return settleWin(room, seat, {});
if (opts.kongs.length && Math.random() < 0.7) {
const k = opts.kongs[0];
return doSelfKong(room, seat, k.tile, k.kind);
}
botDiscard(room, seat);
}
function botClaim(room, seat) {
const p = room.pending;
if (!p ||!p.claimants.has(seat)) return;
const acts = p.claimants.get(seat);
let action = 'pass';
if (acts.includes('hu')) action = 'hu';
else if (acts.includes('gang')) action = 'gang';
else if (acts.includes('peng') && Math.random() < 0.65) action = 'peng';
onClaimResponse(room, seat, action);
}

// ---------------- 连接与消息 ----------------
wss.on('connection', ws => {
let myRoom = null, mySeat = -1;
ws.on('message', raw => {
let m;
try { m = JSON.parse(raw);} catch { return;}
if (m.type === 'create') {
const code = newCode();
const room = new Room(code);
rooms.set(code, room);
room.seats[0] = { name: (m.name || '玩家').slice(0, 10), bot: false, ws, connected: true};
myRoom = room; mySeat = 0;
return broadcast(room);
}
if (m.type === 'join') {
const room = rooms.get(String(m.code));
if (!room) return send(ws, { type: 'error', msg: '桌号不存在'});
// 同名重连
const name = (m.name || '玩家').slice(0, 10);
const exist = room.seats.findIndex(s => s &&!s.bot && s.name === name);
if (exist >= 0) {
room.seats[exist].ws = ws; room.seats[exist].connected = true;
myRoom = room; mySeat = exist;
return broadcast(room);
}
const empty = room.seats.findIndex(s =>!s);
if (empty < 0) return send(ws, { type: 'error', msg: '这桌满了'});
room.seats[empty] = { name, bot: false, ws, connected: true};
myRoom = room; mySeat = empty;
return broadcast(room);
}
if (!myRoom) return;
const room = myRoom;
if (m.type === 'addBot') {
const empty = room.seats.findIndex(s =>!s);
if (empty >= 0 && room.phase!== 'playing') {
const used = room.seats.filter(Boolean).map(s => s.name);
const name = BOT_NAMES.find(n =>!used.includes(n)) || '机器人';
room.seats[empty] = { name, bot: true, ws: null, connected: true};
room.scores[empty] = room.scores[empty] || 0;
broadcast(room);
}
return;
}
if (m.type === 'removeSeat') {
const s = room.seats[m.seat];
if (s && s.bot && room.phase!== 'playing') { room.seats[m.seat] = null; broadcast(room);}
return;
}
if (m.type === 'start') {
if (room.phase!== 'playing' && room.full()) startHand(room);
return;
}
if (m.type === 'discard') {
if (room.phase === 'playing' && room.turn === mySeat &&!room.pending) {
clearTimeout(room.turnTimer);
doDiscard(room, mySeat, m.tile);
}
return;
}
if (m.type === 'selfKong') {
if (room.phase === 'playing' && room.turn === mySeat &&!room.pending) {
const opts = turnOptions(room, mySeat);
const k = opts.kongs.find(k => k.tile === m.tile && k.kind === m.kind);
if (k) { clearTimeout(room.turnTimer); doSelfKong(room, mySeat, k.tile, k.kind);}
}
return;
}
if (m.type === 'hu') {
if (room.phase === 'playing' && room.turn === mySeat &&!room.pending) {
if (turnOptions(room, mySeat).canHu) { clearTimeout(room.turnTimer); settleWin(room, mySeat, {});}
}
return;
}
if (m.type === 'claim') {
onClaimResponse(room, mySeat, m.action);
return;
}
});
ws.on('close', () => {
if (myRoom && mySeat >= 0) {
const s = myRoom.seats[mySeat];
if (s) {
s.connected = false; s.ws = null;
// 对局中真人掉线 -> 机器人托管
if (myRoom.phase === 'playing') {
if (myRoom.turn === mySeat &&!myRoom.pending) scheduleTurn(myRoom, mySeat);
if (myRoom.pending && myRoom.pending.claimants.has(mySeat) &&!myRoom.pending.responses.has(mySeat)) {
setTimeout(() => botClaim(myRoom, mySeat), 800);
}
}
if (myRoom.humans().every(h =>!h.connected)) rooms.delete(myRoom.code);
else broadcast(myRoom);
}
}
});
});
