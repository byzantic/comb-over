# 12. A compact Wilkinson and a branch-line hybrid, to Gerbers

Two workhorse parts at 2.4 GHz on 1.524 mm RO4350B:
- an equal-split Wilkinson divider, laid out compactly with its arms side by side;
- a 90° branch-line hybrid.

The Wilkinson shows the issue that compact layouts raise: the two arms couple across the gap between them, and a design that ignores this does not do what it says.

Netlists: [`examples/wilkinson-2g4-ro4350b-1524.cir`](../../examples/wilkinson-2g4-ro4350b-1524.cir) (arms modelled as coupled), [`examples/wilkinson-2g4-ro4350b-1524-uncoupled.cir`](../../examples/wilkinson-2g4-ro4350b-1524-uncoupled.cir) (arms modelled as independent lines, for comparison), [`examples/branchline-2g4-ro4350b-1524.cir`](../../examples/branchline-2g4-ro4350b-1524.cir) · specifications: the `.json` files.

```sh
node tools/divider.mjs examples/wilkinson-2g4-ro4350b-1524.json --substrate jlc-ro4350b-1.524 --out wilkinson.cir
node tools/divider.mjs examples/wilkinson-2g4-ro4350b-1524.json --substrate jlc-ro4350b-1.524 --coupled false --out wilkinson-uncoupled.cir
node tools/divider.mjs examples/branchline-2g4-ro4350b-1524.json --substrate jlc-ro4350b-1.524 --out branchline.cir
```

Each takes a few seconds. Without `--substrate` the tool gives the ideal TEM design instead (manual §7.9).

## 1. The compact Wilkinson

![Compact Wilkinson](../img/ex12-wilkinson.png)

**The layout:**
- **Arms.** The two quarter-wave arms leave the input line together and run side by side, 1 mm apart.
- **Resistor.** A 0603 resistor stands across that gap at the arms' far ends. Its pads land on both arms, so no extra copper is needed to reach it.
- **Outputs.** Each output then turns away through two mitred bends to a 12 mm pitch, enough for two edge-launch SMAs.

The board is 46.8 × 28.4 mm.

**Does the coupling matter?** A 1 mm gap on a 1.524 mm board is a strongly coupled pair. The divided power travels in the even mode, so the even-mode impedance of the pair, not the impedance of an isolated arm, must be √2·50 Ω. The isolation works in the odd mode, which now has a different impedance and velocity. Three designs, all lossless, all over 2.16–2.64 GHz (±10 %):

| arms | how they were designed | modelled | input return loss | isolation | split |
|---|---|---|---|---|---|
| 2.05 mm × 20.40 mm, R 78.3 Ω | as independent lines | as independent lines | 20.3 dB | 20.4 dB | −3.05 … −3.02 dB |
| the same copper | as independent lines | **as coupled (what is built)** | **12.7 dB** | **17.6 dB** | −3.25 … −3.15 dB |
| 2.78 mm × 19.52 mm, R 73.3 Ω | **as coupled** | as coupled | **20.4 dB** | **21.1 dB** | −3.05 … −3.01 dB |

**What this shows:**
- The usual simplification promises 20 dB of match and isolation. The board it draws gives 12.7 dB at the input and 17.6 dB isolation.
- Designed with the coupling, the arms come out wider (2.78 against 2.05 mm), to bring the pair's even-mode impedance back up to the arm impedance.
- The resistor polishes to 73 Ω rather than the ideal 100 Ω. It absorbs the odd mode's different velocity and the resistor's own pads, ESL and body capacitance, which the `res` model includes (manual §8.5).

**As built**, with the feeds and connector pads, the coupled design keeps 20.5 dB input match and 21.1 dB isolation. With the substrate's loss the split is −3.065 dB at f0, so 0.055 dB is lost in the arms.

**Not modelled:**
- The junction where the 3.3 mm input line meets both arms.
- The resistor body over the gap. Its pads are modelled.

## 2. The branch-line hybrid

![Branch-line hybrid](../img/ex12-branchline.png)

**The layout:**
- **Arms.** Series arms (35.4 Ω, 5.46 mm wide) form the top and bottom; shunt arms (50 Ω, 3.35 mm) form the sides.
- **Corners.** Each corner is a Hammerstad tee. The port line and the series arm are its main arms, the shunt arm its side arm.
- **Lengths.** These are measured between the tees' reference planes, so the polish absorbs the junctions: series 15.97 mm, shunt 16.48 mm.

The board is 37.8 × 40.5 mm.

| over 2.28–2.52 GHz (±5 %) | lossless | with loss |
|---|---|---|
| return loss | ≥ 20.0 dB | ≥ 20.1 dB |
| isolation | ≥ 20.3 dB | ≥ 20.4 dB |
| through / coupled | −3.29 … −2.91 dB | −3.35 … −2.97 dB (−3.075 dB each at f0) |
| phase difference | −90.0 … −89.6° | −90.0 … −89.5° |

As built, nothing changes beyond the second decimal.

## 3. KiCad and Gerbers

```sh
node tools/kicad.mjs examples/wilkinson-2g4-ro4350b-1524.cir --out wilkinson-board/ --board
```

**The Wilkinson project:**
- **Part.** The arms, input stub and output routes are one copper piece, so `in`, `o1` and `o2` share a net tie.
- **Resistor.** RI1 is a `RES_0603` footprint with pad 1 on `o1` and pad 2 on `o2`.
- **Design rules.** A rule lets the resistor's courtyard sit on the part.
- **Board.** Three SMAs and a via fence.

The branch-line part is one piece of copper with its four ports in one tie. CI exports both boards, runs KiCad's DRC and writes the Gerbers.

**Before ordering:**
- Pick the resistor value you can buy: 75 Ω is the nearest E24.
- Check its datasheet for ESL and body capacitance. The model assumes 0.6 nH and 0.03 pF; set `esl=` and `cp=` on the `res` line from your part and re-run the polish.
- An EM check of the input junction is worth having: `node tools/openems.mjs examples/wilkinson-2g4-ro4350b-1524.cir --out oems/` (manual §8.6).
