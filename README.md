[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/davidwara/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/davidwara/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

# Sokoban Solver

A push-optimal Sokoban solver for the [make.fun bounty](https://make.fun/bounty/sokoban-solver-01-run-20261121). One program, `main.ts`, answers all 5 instances of a set in a single run.

## How it works

The generator builds every level as a 1-wide hallway with 1–4 rooms off it, each room holding 3–4 boxes/goals behind a single door. A box pushed out of its room can never come back, so rooms are independent subproblems and the level optimum is the sum of the room optima. The solver:

1. **Decomposes** the level by cutting the hallway row out of the floor graph — each remaining component with boxes is one room, with its door and hallway entry cells identified.
2. **Solves each room with push-based A\***: states are sorted box cells plus the player's canonical reachable region; successors are pushes, with the player walking between pushes by BFS.
3. **Heuristic**: minimum-cost matching of boxes to goals, where a box–goal pair costs its single-box push distance (BFS over pushes, ignoring other boxes). Every real push moves one box one cell, so the matching sum is admissible — and in practice nearly exact, so A\* expands only dozens of states per room.
4. **Deadlock pruning**: dead squares (a box whose push distance to every goal is infinite) plus frozen 2×2 wall/box blocks holding a box off a goal.
5. **Fallbacks**: weighted A\* (f = g + 2h), then greedy best-first, then A\* with a larger budget — all under a global expansion cap that bounds the whole run's work, so a pathological room can never push the run past the 60-second wall budget. Budgets are counted in node expansions, never in wall time, so two runs write byte-identical output.

## Results (practice set)

| Instance | Pushes | Optimal | Points |
|----------|--------|---------|--------|
| i001 | 13 | 13 | 1000 |
| i002 | 16 | 16 | 1000 |
| i003 | 29 | 29 | 1000 |
| i004 | 47 | 47 | 1000 |
| i005 | 60 | 60 | 1000 |

**Practice score: 1,000,000 / 1,000,000** (verified with the kit's own `grade-local`, L1 regrade reproduced byte for byte). The solver also scores 1,000,000 on 10 freshly drawn sets from the published generator. For comparison, the house baseline `plain-astar 1.0.0` scores 200,000 on the practice set (it only solves i001). Full run: ~0.3 s for the whole set; deterministic (two runs byte-identical).

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` is plain TypeScript with erasable syntax only (Node 22 runs it as-is). It reads `/input/<id>/level.txt` (or `$MAKEFUN_INPUT_DIR`) and writes `/output/<id>/solution.txt` — one line of moves (`u/d/l/r`, uppercase = push) plus a trailing newline.

## License

MIT — see [LICENSE](LICENSE).
