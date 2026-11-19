// 长沙麻将规则引擎
// 牌编码: 0-26, suit = floor(t/9) (0=万 1=筒 2=条), rank = t%9+1
// 一副 108 张: 每种 4 张, 无字牌、无红中

const SUITS = ['万', '筒', '条'];
const RANK_CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];

function tileName(t) {
  return RANK_CN[t % 9] + SUITS[Math.floor(t / 9)];
}
function rankOf(t) { return (t % 9) + 1; }
function suitOf(t) { return Math.floor(t / 9); }
function is258(t) { const r = rankOf(t); return r === 2 || r === 5 || r === 8; }

function toCounts(hand) {
  const c = new Array(27).fill(0);
  for (const t of hand) c[t]++;
  return c;
}

// 剩余牌能否全部组成顺子/刻子
function canFormSets(counts) {
  let i = 0;
  while (i < 27 && counts[i] === 0) i++;
  if (i === 27) return true;
  // 刻子
  if (counts[i] >= 3) {
    counts[i] -= 3;
    if (canFormSets(counts)) { counts[i] += 3; return true; }
    counts[i] += 3;
  }
  // 顺子
  const r = rankOf(i);
  if (r <= 7 && counts[i + 1] > 0 && counts[i + 2] > 0) {
    counts[i]--; counts[i + 1]--; counts[i + 2]--;
    if (canFormSets(counts)) { counts[i]++; counts[i + 1]++; counts[i + 2]++; return true; }
    counts[i]++; counts[i + 1]++; counts[i + 2]++;
  }
  return false;
}

// 仅刻子分解 (碰碰胡判定用)
function canFormTriplets(counts) {
  let i = 0;
  while (i < 27 && counts[i] === 0) i++;
  if (i === 27) return true;
  if (counts[i] >= 3) {
    counts[i] -= 3;
    if (canFormTriplets(counts)) { counts[i] += 3; return true; }
    counts[i] += 3;
  }
  return false;
}

// 判胡. handCounts: 27数组(手里未亮出的牌)
// melds: [{kind:'shun'|'peng'|'gang', tile}] 已亮出的副露
// 返回 null 或 {tier:'xiao'|'da', types:[...]}
function checkWin(handCounts, melds) {
  const handSum = handCounts.reduce((a, b) => a + b, 0);
  const total = handSum + melds.length * 3;
  if (total % 3 !== 2) return null;

  const allTiles = [];
  for (let t = 0; t < 27; t++) for (let k = 0; k < handCounts[t]; k++) allTiles.push(t);
  for (const m of melds) {
    if (m.kind === 'shun') allTiles.push(m.tile, m.tile + 1, m.tile + 2);
    else allTiles.push(m.tile, m.tile, m.tile);
  }
  const suits = new Set(allTiles.map(suitOf));
  const isQingYiSe = suits.size === 1;
  const isJiangJiang = allTiles.every(is258);
  const meldsAllTriplet = melds.every(m => m.kind !== 'shun');

  // 七对 (必须门清, 手牌14张)
  if (melds.length === 0 && handSum === 14) {
    let pairs = 0, quads = 0, ok = true;
    for (let t = 0; t < 27; t++) {
      if (handCounts[t] === 2) pairs++;
      else if (handCounts[t] === 4) { pairs += 2; quads++; }
      else if (handCounts[t] !== 0) { ok = false; break; }
    }
    if (ok && pairs === 7) {
      const types = [];
      if (quads >= 2) types.push('双豪华七对');
      else if (quads === 1) types.push('豪华七对');
      else types.push('七对');
      if (isQingYiSe) types.push('清一色');
      if (isJiangJiang) types.push('将将胡');
      return { tier: 'da', types };
    }
  }

  // 标准型: 逐一试将
  let xiaoWin = false;
  let pengPeng = false;
  let anyWin = false;
  for (let p = 0; p < 27; p++) {
    if (handCounts[p] < 2) continue;
    const c = handCounts.slice();
    c[p] -= 2;
    if (canFormSets(c.slice())) {
      anyWin = true;
      if (is258(p)) xiaoWin = true;
      if (meldsAllTriplet && canFormTriplets(c.slice())) pengPeng = true;
    }
  }
  if (!anyWin) return null;

  const types = [];
  let da = false;
  if (pengPeng) { types.push('碰碰胡'); da = true; }
  if (isJiangJiang) { types.push('将将胡'); da = true; }
  if (isQingYiSe) { types.push('清一色'); da = true; }
  // 全求人: 4副露 + 手里只剩将牌对子, 靠点炮胡 (由对局层确认胡牌方式后追加)
  if (melds.length === 4 && handSum === 2) { types.push('全求人'); da = true; }

  if (da) return { tier: 'da', types };
  if (xiaoWin) return { tier: 'xiao', types: ['小胡'] };
  return null; // 有型但将不是258, 长沙麻将不算胡
}

// 起手胡判定 (发完牌13张时)
// 返回 [{type, score}] score=每家赔付分
function checkOpeningHu(hand) {
  const c = toCounts(hand);
  const out = [];
  let hasQuad = false, triplets = 0;
  for (let t = 0; t < 27; t++) {
    if (c[t] === 4) hasQuad = true;
    if (c[t] >= 3) triplets++;
  }
  if (hasQuad) out.push({ type: '大四喜', score: 4 });
  if (!hand.some(is258)) out.push({ type: '板板胡', score: 2 });
  const suits = new Set(hand.map(suitOf));
  if (suits.size <= 2) out.push({ type: '缺一色', score: 2 });
  if (triplets >= 2) out.push({ type: '六六顺', score: 2 });
  return out;
}

// 扎鸟: 鸟牌点数定座位. 以胡牌者为起点: 1/5/9->本人, 2/6->下家, 3/7->对家, 4/8->上家
// 返回被扎中的座位号
function birdHitSeat(birdTile, winnerSeat) {
  const offset = (rankOf(birdTile) - 1) % 4;
  return (winnerSeat + offset) % 4;
}

// 计分参数 (纯积分)
const SCORE = {
  xiao: { ron: 3, tsumo: 2 },   // 点炮: 放炮者付; 自摸: 每家付
  da: { ron: 6, tsumo: 4 },
  gangFromDiscard: 2,           // 直杠: 放杠者付
  gangAdded: 1,                 // 补杠: 每家付
  gangConcealed: 2,             // 暗杠: 每家付
};

module.exports = { tileName, rankOf, suitOf, is258, toCounts, checkWin, checkOpeningHu, birdHitSeat, SCORE };
