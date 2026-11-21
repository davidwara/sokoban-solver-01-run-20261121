// Sokoban solver for make.fun bounty sokoban-solver-01-run-20261121.
//
// Strategy (written from scratch for this competition):
//  * The generator lays a 1-wide hallway across the board with 1-4 rooms off
//    it, each room holding 3-4 boxes/goals behind a single door. A box pushed
//    out of its room can never come back, so rooms are independent: the level
//    optimum is the sum of the room optima. We cut the hallway row out of the
//    floor graph, solve every room on its own, and stitch the walks together.
//  * Each room is solved with push-based A*: a state is the sorted box cells
//    plus the player's reachable region (canonicalised to its lowest cell),
//    successors are pushes, and the player walks between pushes by BFS.
//  * Heuristic: minimum-cost matching of boxes to goals, where the cost of
//    one box-to-goal pair is the single-box push distance (BFS over pushes,
//    ignoring other boxes). Every real push moves one box one cell, so the
//    matching sum is an admissible lower bound on the pushes still needed.
//  * Deadlock pruning: boxes that can never be pushed onto any goal (their
//    single-box push distance to every goal is infinite, i.e. dead squares),
//    plus frozen 2x2 blocks of walls/boxes holding a box off a goal.
//  * Determinism: budgets are counted in node expansions, never in wall
//    time; no clock reads, no randomness, fixed iteration orders.
//  * Fallbacks: if A* exhausts its expansion budget on a room, weighted
//    A* (f = g + 2h), then greedy best-first search (same heuristic, same
//    pruning), then A* again with a larger budget. A global expansion cap
//    bounds the whole run's work, so a pathological room can never push
//    the run past the 60s wall budget. A room that still fails leaves the
//    instance with the moves solved so far (a partial, format-valid
//    answer) instead of crashing the whole run.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Small fixed tables. Directions are tried in this exact order everywhere.
// ---------------------------------------------------------------------------
const DIRS = [
  { dx: 0, dy: -1, ch: "u" },
  { dx: 0, dy: 1, ch: "d" },
  { dx: -1, dy: 0, ch: "l" },
  { dx: 1, dy: 0, ch: "r" },
];

const ASTAR_BUDGET = 100000;
const WEIGHTED_BUDGET = 100000;
const GREEDY_BUDGET = 100000;
const ASTAR_BUDGET_2 = 150000;
// Global work cap for the whole run (all 5 instances): bounds the worst-case
// runtime deterministically. Observed totals are ~3,000 expansions per set;
// the cap is ~65x that, and at the measured ~60us per expansion it keeps
// even a pathological run far inside the 60s wall budget.
const WORK = { used: 0, cap: 200000 };

interface Level {
  w: number;
  h: number;
  wall: boolean[];
  boxes: number[];
  goals: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rawLines = text.replace(/\r/g, "").split("\n");
  while (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();
  const h = rawLines.length;
  let w = 0;
  for (const l of rawLines) w = Math.max(w, l.length);
  const wall = new Array<boolean>(w * h).fill(true);
  const boxes: number[] = [];
  const goals: number[] = [];
  let player = 0;
  for (let y = 0; y < h; y++) {
    const line = rawLines[y];
    for (let x = 0; x < w; x++) {
      const c = x < line.length ? line[x] : "#";
      const i = y * w + x;
      if (c === "#") continue;
      wall[i] = false;
      if (c === "$" || c === "*") boxes.push(i);
      if (c === "." || c === "*") goals.push(i);
      if (c === "@") player = i;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, boxes, goals, player };
}

// ---------------------------------------------------------------------------
// Decomposition: cut the hallway row (or column) out of the floor graph.
// ---------------------------------------------------------------------------
interface Room {
  cells: boolean[]; // room floor cells (includes the door cell)
  boxes: number[];
  goals: number[];
  doorCells: number[]; // room cells adjacent to the hallway
  entryCells: number[]; // hallway cells adjacent to the room
}

function decompose(lv: Level): Room[] | null {
  const py = Math.floor(lv.player / lv.w);
  const px = lv.player % lv.w;
  let hall: number[] = [];
  let rowFloor = 0;
  for (let x = 0; x < lv.w; x++) if (!lv.wall[py * lv.w + x]) rowFloor++;
  if (rowFloor >= Math.max(3, lv.w - 2)) {
    for (let x = 0; x < lv.w; x++) {
      const i = py * lv.w + x;
      if (!lv.wall[i]) hall.push(i);
    }
  } else {
    let colFloor = 0;
    for (let y = 0; y < lv.h; y++) if (!lv.wall[y * lv.w + px]) colFloor++;
    if (colFloor >= Math.max(3, lv.h - 2)) {
      for (let y = 0; y < lv.h; y++) {
        const i = y * lv.w + px;
        if (!lv.wall[i]) hall.push(i);
      }
    } else {
      return null;
    }
  }
  const hallSet = new Set(hall);
  const seen = new Set<number>();
  const rooms: Room[] = [];
  let roomBoxTotal = 0;
  for (let start = 0; start < lv.w * lv.h; start++) {
    if (lv.wall[start] || hallSet.has(start) || seen.has(start)) continue;
    // BFS one connected component of floor minus hallway.
    const comp: number[] = [];
    const q = [start];
    seen.add(start);
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi];
      comp.push(c);
      const cx = c % lv.w;
      const cy = Math.floor(c / lv.w);
      for (const d of DIRS) {
        const nx = cx + d.dx;
        const ny = cy + d.dy;
        if (nx < 0 || nx >= lv.w || ny < 0 || ny >= lv.h) continue;
        const n = ny * lv.w + nx;
        if (lv.wall[n] || hallSet.has(n) || seen.has(n)) continue;
        seen.add(n);
        q.push(n);
      }
    }
    const compSet = new Set(comp);
    const boxes = lv.boxes.filter((b) => compSet.has(b));
    if (boxes.length === 0) continue;
    const goals = lv.goals.filter((g) => compSet.has(g));
    if (goals.length !== boxes.length) return null;
    const cells = new Array<boolean>(lv.w * lv.h).fill(false);
    for (const c of comp) cells[c] = true;
    const doorCells: number[] = [];
    const entrySet = new Set<number>();
    for (const c of comp) {
      const cx = c % lv.w;
      const cy = Math.floor(c / lv.w);
      for (const d of DIRS) {
        const nx = cx + d.dx;
        const ny = cy + d.dy;
        if (nx < 0 || nx >= lv.w || ny < 0 || ny >= lv.h) continue;
        const n = ny * lv.w + nx;
        if (hallSet.has(n)) {
          if (!doorCells.includes(c)) doorCells.push(c);
          entrySet.add(n);
        }
      }
    }
    if (doorCells.length === 0 || entrySet.size === 0) return null;
    doorCells.sort((a, b) => a - b);
    const entryCells = [...entrySet].sort((a, b) => a - b);
    roomBoxTotal += boxes.length;
    rooms.push({ cells, boxes, goals, doorCells, entryCells });
  }
  if (roomBoxTotal !== lv.boxes.length) return null;
  rooms.sort((a, b) => {
    const am = Math.min(...a.boxes);
    const bm = Math.min(...b.boxes);
    return am - bm;
  });
  return rooms;
}

// Whole level as a single room (fallback when decomposition fails).
function wholeLevelRoom(lv: Level): Room {
  const cells = new Array<boolean>(lv.w * lv.h).fill(false);
  for (let i = 0; i < lv.w * lv.h; i++) if (!lv.wall[i]) cells[i] = true;
  return {
    cells,
    boxes: [...lv.boxes],
    goals: [...lv.goals],
    doorCells: [lv.player],
    entryCells: [lv.player],
  };
}

// ---------------------------------------------------------------------------
// Per-room search context: push distances, 2x2 freeze quads, permutations.
// ---------------------------------------------------------------------------
interface RoomCtx {
  lv: Level;
  room: Room;
  inRoom: boolean[];
  inEntry: boolean[];
  goalSet: Set<number>;
  distFrom: Map<number, Int32Array>;
  quads: number[][];
  perms: number[][];
}

function buildCtx(lv: Level, room: Room): RoomCtx {
  const inRoom = room.cells;
  const inEntry = new Array<boolean>(lv.w * lv.h).fill(false);
  for (const e of room.entryCells) inEntry[e] = true;
  const goalSet = new Set(room.goals);
  // Single-box push distances: BFS over box cells from every room cell.
  // A push from b to dest is allowed when dest is a room cell and the cell
  // behind b (where the player must stand) is any non-wall cell.
  const distFrom = new Map<number, Int32Array>();
  const roomCells: number[] = [];
  for (let i = 0; i < lv.w * lv.h; i++) if (inRoom[i]) roomCells.push(i);
  for (const s of roomCells) {
    const dist = new Int32Array(lv.w * lv.h).fill(-1);
    dist[s] = 0;
    const q = [s];
    for (let qi = 0; qi < q.length; qi++) {
      const b = q[qi];
      const bx = b % lv.w;
      const by = Math.floor(b / lv.w);
      for (const d of DIRS) {
        const dx = bx + d.dx;
        const dy = by + d.dy;
        const hx = bx - d.dx;
        const hy = by - d.dy;
        if (dx < 0 || dx >= lv.w || dy < 0 || dy >= lv.h) continue;
        if (hx < 0 || hx >= lv.w || hy < 0 || hy >= lv.h) continue;
        const dest = dy * lv.w + dx;
        const behind = hy * lv.w + hx;
        if (!inRoom[dest] || lv.wall[behind] || dist[dest] !== -1) continue;
        dist[dest] = dist[b] + 1;
        q.push(dest);
      }
    }
    distFrom.set(s, dist);
  }
  // 2x2 blocks whose cells are all wall or room floor (freeze candidates).
  const quads: number[][] = [];
  for (let y = 0; y + 1 < lv.h; y++) {
    for (let x = 0; x + 1 < lv.w; x++) {
      const c = [y * lv.w + x, y * lv.w + x + 1, (y + 1) * lv.w + x, (y + 1) * lv.w + x + 1];
      if (c.every((i) => lv.wall[i] || inRoom[i])) quads.push(c);
    }
  }
  // All permutations of goal indices (n <= 4, so at most 24).
  const n = room.goals.length;
  const perms: number[][] = [];
  const base = Array.from({ length: n }, (_, i) => i);
  const gen = (arr: number[], k: number): void => {
    if (k === 1) {
      perms.push([...arr]);
      return;
    }
    for (let i = 0; i < k; i++) {
      gen(arr, k - 1);
      const j = k % 2 === 0 ? i : 0;
      const t = arr[j];
      arr[j] = arr[k - 1];
      arr[k - 1] = t;
    }
  };
  gen(base, n);
  perms.sort((a, b) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  });
  return { lv, room, inRoom, inEntry, goalSet, distFrom, quads, perms };
}

// Minimum-cost matching of boxes to goals using single-box push distances.
// Infinity when no perfect matching with finite distances exists.
function heuristic(ctx: RoomCtx, boxes: number[]): number {
  let best = Infinity;
  const goals = ctx.room.goals;
  for (const perm of ctx.perms) {
    let s = 0;
    for (let i = 0; i < boxes.length; i++) {
      const d = ctx.distFrom.get(boxes[i])![goals[perm[i]]];
      if (d < 0) {
        s = Infinity;
        break;
      }
      s += d;
      if (s >= best) break;
    }
    if (s < best) best = s;
  }
  return best;
}

// Player flood fill over room + entry cells (boxes are obstacles). Entry
// cells are mutually reachable through the hallway, so stepping onto any
// entry cell reaches all of them. Returns the reachability mask and the
// lowest reachable cell (the canonical player position for the state key).
function flood(ctx: RoomCtx, player: number, boxSet: Set<number>): { reach: Uint8Array; minCell: number } {
  const { lv, inRoom, inEntry } = ctx;
  const reach = new Uint8Array(lv.w * lv.h);
  const q = [player];
  reach[player] = 1;
  let minCell = player;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    if (inEntry[c]) {
      for (const e of ctx.room.entryCells) {
        if (!reach[e] && !boxSet.has(e)) {
          reach[e] = 1;
          if (e < minCell) minCell = e;
          q.push(e);
        }
      }
    }
    const cx = c % lv.w;
    const cy = Math.floor(c / lv.w);
    for (const d of DIRS) {
      const nx = cx + d.dx;
      const ny = cy + d.dy;
      if (nx < 0 || nx >= lv.w || ny < 0 || ny >= lv.h) continue;
      const n = ny * lv.w + nx;
      if (reach[n] || boxSet.has(n)) continue;
      if (!inRoom[n] && !inEntry[n]) continue;
      reach[n] = 1;
      if (n < minCell) minCell = n;
      q.push(n);
    }
  }
  return { reach, minCell };
}

// Frozen 2x2 block: every cell is a wall or a box, and at least one of the
// boxes sits off a goal. No box in such a block can ever move.
function frozen2x2(ctx: RoomCtx, boxSet: Set<number>): boolean {
  for (const q of ctx.quads) {
    let allBlocked = true;
    let badBox = false;
    for (const c of q) {
      if (ctx.lv.wall[c]) continue;
      if (boxSet.has(c)) {
        if (!ctx.goalSet.has(c)) badBox = true;
      } else {
        allBlocked = false;
        break;
      }
    }
    if (allBlocked && badBox) return true;
  }
  return false;
}

interface Push {
  box: number;
  dir: number; // index into DIRS
}

interface SolveResult {
  pushes: Push[];
  expansions: number;
  mode: string;
}

// Push-based search over one room. Modes: "astar" (f = g + h, optimal),
// "weighted" (f = g + 2h, near-optimal, much greedier) or "greedy"
// (priority = h). Returns null when the expansion budget runs out or the
// global work cap is hit.
function solveRoom(ctx: RoomCtx, boxes0: number[], entryStart: number, budget: number, mode: string): SolveResult | null {
  const { lv } = ctx;
  const startBoxes = [...boxes0].sort((a, b) => a - b);
  const startH = heuristic(ctx, startBoxes);
  if (!Number.isFinite(startH)) return null;

  const nodeBoxes: number[][] = [];
  const nodePlayer: number[] = [];
  const nodeParent: number[] = [];
  const nodePushBox: number[] = [];
  const nodePushDir: number[] = [];
  const nodeG: number[] = [];
  const nodeH: number[] = [];
  const nodeKey: string[] = [];

  const keyOf = (boxes: number[], canon: number): string => boxes.join(",") + "|" + canon;

  const heap: number[] = [];
  const better = (a: number, b: number): boolean => {
    if (mode === "greedy") {
      if (nodeH[a] !== nodeH[b]) return nodeH[a] < nodeH[b];
      if (nodeG[a] !== nodeG[b]) return nodeG[a] > nodeG[b];
      return a < b;
    }
    const w = mode === "weighted" ? 2 : 1;
    const fa = nodeG[a] + w * nodeH[a];
    const fb = nodeG[b] + w * nodeH[b];
    if (fa !== fb) return fa < fb;
    if (nodeH[a] !== nodeH[b]) return nodeH[a] < nodeH[b];
    return a < b;
  };
  const heapPush = (id: number): void => {
    heap.push(id);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!better(heap[i], heap[p])) break;
      const t = heap[i];
      heap[i] = heap[p];
      heap[p] = t;
      i = p;
    }
  };
  const heapPop = (): number => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && better(heap[l], heap[m])) m = l;
        if (r < heap.length && better(heap[r], heap[m])) m = r;
        if (m === i) break;
        const t = heap[i];
        heap[i] = heap[m];
        heap[m] = t;
        i = m;
      }
    }
    return top;
  };

  const best = new Map<string, number>();
  const addNode = (boxes: number[], player: number, parent: number, pushBox: number, pushDir: number, g: number, h: number): number => {
    const id = nodeBoxes.length;
    const canon = flood(ctx, player, new Set(boxes)).minCell;
    nodeBoxes.push(boxes);
    nodePlayer.push(player);
    nodeParent.push(parent);
    nodePushBox.push(pushBox);
    nodePushDir.push(pushDir);
    nodeG.push(g);
    nodeH.push(h);
    const key = keyOf(boxes, canon);
    nodeKey.push(key);
    best.set(key, g);
    heapPush(id);
    return id;
  };

  addNode(startBoxes, entryStart, -1, -1, -1, 0, startH);

  let expansions = 0;
  while (heap.length > 0) {
    const id = heapPop();
    if (nodeG[id] !== best.get(nodeKey[id])) continue; // stale entry
    expansions++;
    WORK.used++;
    if (expansions > budget || WORK.used > WORK.cap) return null;
    const boxes = nodeBoxes[id];
    const player = nodePlayer[id];
    const boxSet = new Set(boxes);
    // Goal: every box on a goal and the player can still reach the door.
    let solved = true;
    for (const b of boxes) if (!ctx.goalSet.has(b)) { solved = false; break; }
    if (solved) {
      const fl = flood(ctx, player, boxSet);
      let canExit = false;
      for (const d of ctx.room.doorCells) if (fl.reach[d]) { canExit = true; break; }
      if (!canExit) for (const e of ctx.room.entryCells) if (fl.reach[e]) { canExit = true; break; }
      if (canExit) {
        const pushes: Push[] = [];
        let cur = id;
        while (nodeParent[cur] !== -1) {
          pushes.push({ box: nodePushBox[cur], dir: nodePushDir[cur] });
          cur = nodeParent[cur];
        }
        pushes.reverse();
        return { pushes, expansions, mode };
      }
      continue;
    }
    const fl = flood(ctx, player, boxSet);
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi];
      const bx = b % lv.w;
      const by = Math.floor(b / lv.w);
      for (let di = 0; di < DIRS.length; di++) {
        const d = DIRS[di];
        const hx = bx - d.dx;
        const hy = by - d.dy;
        const dx = bx + d.dx;
        const dy = by + d.dy;
        if (hx < 0 || hx >= lv.w || hy < 0 || hy >= lv.h) continue;
        if (dx < 0 || dx >= lv.w || dy < 0 || dy >= lv.h) continue;
        const behind = hy * lv.w + hx;
        const dest = dy * lv.w + dx;
        if (!fl.reach[behind]) continue;
        if (!ctx.inRoom[dest] || boxSet.has(dest)) continue;
        const nb = [...boxes];
        nb[bi] = dest;
        nb.sort((x, y) => x - y);
        const nbSet = new Set(nb);
        if (frozen2x2(ctx, nbSet)) continue;
        const h = heuristic(ctx, nb);
        if (!Number.isFinite(h)) continue;
        const g = nodeG[id] + 1;
        const canon = flood(ctx, b, nbSet).minCell;
        const key = keyOf(nb, canon);
        const prev = best.get(key);
        if (prev !== undefined && prev <= g) continue;
        // addNode recomputes the flood for the canon; reuse it by inlining
        // the bookkeeping here instead.
        const nid = nodeBoxes.length;
        nodeBoxes.push(nb);
        nodePlayer.push(b);
        nodeParent.push(id);
        nodePushBox.push(b);
        nodePushDir.push(di);
        nodeG.push(g);
        nodeH.push(h);
        nodeKey.push(key);
        best.set(key, g);
        heapPush(nid);
      }
    }
  }
  return null;
}

// BFS walk over the whole level (boxes are obstacles). Returns the move
// string (lowercase steps) or null when unreachable.
function bfsWalk(lv: Level, from: number, to: number, blocked: Set<number>): string | null {
  if (from === to) return "";
  const prev = new Int32Array(lv.w * lv.h).fill(-1);
  const prevDir = new Int8Array(lv.w * lv.h).fill(-1);
  const q = [from];
  prev[from] = from;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    if (c === to) break;
    const cx = c % lv.w;
    const cy = Math.floor(c / lv.w);
    for (let di = 0; di < DIRS.length; di++) {
      const d = DIRS[di];
      const nx = cx + d.dx;
      const ny = cy + d.dy;
      if (nx < 0 || nx >= lv.w || ny < 0 || ny >= lv.h) continue;
      const n = ny * lv.w + nx;
      if (lv.wall[n] || blocked.has(n) || prev[n] !== -1) continue;
      prev[n] = c;
      prevDir[n] = di;
      q.push(n);
    }
  }
  if (prev[to] === -1) return null;
  let out = "";
  let cur = to;
  while (cur !== from) {
    out = DIRS[prevDir[cur]].ch + out;
    cur = prev[cur];
  }
  return out;
}

// Solve one level: decompose, solve rooms in order, stitch walks together.
function solveLevel(lv: Level): { moves: string; roomsSolved: number; roomsTotal: number; stats: string[] } {
  const rooms = decompose(lv) ?? [wholeLevelRoom(lv)];
  const stats: string[] = [];
  let moves = "";
  let player = lv.player;
  const curBoxes: number[][] = rooms.map((r) => [...r.boxes]);
  let solvedCount = 0;
  for (let ri = 0; ri < rooms.length; ri++) {
    const room = rooms[ri];
    const ctx = buildCtx(lv, room);
    const allBlocked = (): Set<number> => {
      const s = new Set<number>();
      for (const bs of curBoxes) for (const b of bs) s.add(b);
      return s;
    };
    // Pick the entry cell the player can actually walk to.
    let entryStart = room.entryCells[0];
    let walkIn: string | null = null;
    for (const e of room.entryCells) {
      const w = bfsWalk(lv, player, e, allBlocked());
      if (w !== null) {
        entryStart = e;
        walkIn = w;
        break;
      }
    }
    if (walkIn === null) {
      stats.push(`room${ri}: no walk to entry`);
      break;
    }
    let res = solveRoom(ctx, room.boxes, room.entryCells[0], ASTAR_BUDGET, "astar");
    let mode = "astar";
    if (res === null && WORK.used <= WORK.cap) {
      res = solveRoom(ctx, room.boxes, room.entryCells[0], WEIGHTED_BUDGET, "weighted");
      mode = "weighted";
    }
    if (res === null && WORK.used <= WORK.cap) {
      res = solveRoom(ctx, room.boxes, room.entryCells[0], GREEDY_BUDGET, "greedy");
      mode = "greedy";
    }
    if (res === null && WORK.used <= WORK.cap) {
      res = solveRoom(ctx, room.boxes, room.entryCells[0], ASTAR_BUDGET_2, "astar");
      mode = "astar2";
    }
    if (res === null) {
      stats.push(`room${ri}: FAILED (boxes=${room.boxes.length})`);
      break;
    }
    // Turn the push list into steps: walk to each push position, push,
    // then walk back out to the entry cell.
    let roomMoves = walkIn;
    let curPlayer = entryStart;
    const boxesNow = [...room.boxes].sort((a, b) => a - b);
    let ok = true;
    for (const p of res.pushes) {
      const d = DIRS[p.dir];
      const behind = (Math.floor(p.box / lv.w) - d.dy) * lv.w + (p.box % lv.w - d.dx);
      const others = new Set<number>();
      for (let j = 0; j < curBoxes.length; j++) {
        if (j === ri) for (const b of boxesNow) others.add(b);
        else for (const b of curBoxes[j]) others.add(b);
      }
      const w = bfsWalk(lv, curPlayer, behind, others);
      if (w === null) {
        ok = false;
        break;
      }
      roomMoves += w;
      roomMoves += d.ch.toUpperCase();
      curPlayer = p.box;
      const bi = boxesNow.indexOf(p.box);
      boxesNow[bi] = (Math.floor(p.box / lv.w) + d.dy) * lv.w + (p.box % lv.w + d.dx);
      boxesNow.sort((a, b) => a - b);
    }
    if (!ok) {
      stats.push(`room${ri}: walk reconstruction failed`);
      break;
    }
    const othersFinal = new Set<number>();
    for (let j = 0; j < curBoxes.length; j++) {
      if (j === ri) for (const b of boxesNow) othersFinal.add(b);
      else for (const b of curBoxes[j]) othersFinal.add(b);
    }
    const walkOut = bfsWalk(lv, curPlayer, entryStart, othersFinal);
    if (walkOut === null) {
      stats.push(`room${ri}: no walk out`);
      break;
    }
    roomMoves += walkOut;
    moves += roomMoves;
    player = entryStart;
    curBoxes[ri] = [...room.goals].sort((a, b) => a - b);
    solvedCount++;
    stats.push(`room${ri}: ${res.pushes.length} pushes (${mode}, ${res.expansions} exp)`);
  }
  return { moves, roomsSolved: solvedCount, roomsTotal: rooms.length, stats };
}

// ---------------------------------------------------------------------------
// Entry point: read every instance, write one solution.txt per instance.
// ---------------------------------------------------------------------------
const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

for (const id of readdirSync(IN_DIR).sort()) {
  const levelText = readFileSync(join(IN_DIR, id, "level.txt"), "utf8");
  const lv = parseLevel(levelText);
  const { moves } = solveLevel(lv);
  mkdirSync(join(OUT_DIR, id), { recursive: true });
  writeFileSync(join(OUT_DIR, id, "solution.txt"), `${moves}\n`);
}
