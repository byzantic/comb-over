# 12. A compact Wilkinson and a branch-line hybrid, to Gerbers

Two workhorse parts at 2.4 GHz on 1.524 mm RO4350B:
- an equal-split Wilkinson divider, laid out compactly with its arms side by side;
- a 90° branch-line hybrid.

The Wilkinson shows two things. First, compact layouts couple: the arms couple across the gap between them, and a design that ignores this does not do what it says. Second, comb-over's closed-form discontinuity models are not enough on their own for this board. The final dimensions were trimmed against openEMS ([worked example 13](13-openems-coupler.md), section 5).

Netlists:
- [`examples/wilkinson-2g4-ro4350b-1524.cir`](../../examples/wilkinson-2g4-ro4350b-1524.cir): the board, trimmed against openEMS.
- [`examples/wilkinson-2g4-ro4350b-1524-model.cir`](../../examples/wilkinson-2g4-ro4350b-1524-model.cir): comb-over's own design, arms modelled as coupled.
- [`examples/wilkinson-2g4-ro4350b-1524-uncoupled.cir`](../../examples/wilkinson-2g4-ro4350b-1524-uncoupled.cir): arms modelled as independent lines, for comparison.
- [`examples/branchline-2g4-ro4350b-1524.cir`](../../examples/branchline-2g4-ro4350b-1524.cir).

Specifications: the `.json` files.

```sh
node tools/divider.mjs examples/wilkinson-2g4-ro4350b-1524.json --substrate jlc-ro4350b-1.524 --out wilkinson-model.cir
node tools/divider.mjs examples/wilkinson-2g4-ro4350b-1524.json --substrate jlc-ro4350b-1.524 --coupled false --out wilkinson-uncoupled.cir
node tools/divider.mjs examples/branchline-2g4-ro4350b-1524.json --substrate jlc-ro4350b-1.524 --out branchline.cir
# the trim needs openEMS (about 4 min):
node tools/emtrim.mjs examples/wilkinson-2g4-ro4350b-1524.json --substrate jlc-ro4350b-1.524 --out trim/ --e24
```

Each synthesis takes a few seconds. Without `--substrate` the tool gives the ideal TEM design instead (manual §7.9).

## 1. The compact Wilkinson

![Compact Wilkinson](../img/ex12-wilkinson.png)

**The layout:**
- **Input.** The 50 Ω input line tapers out over 2.03 mm to the arms' outer edges. The netlist models the taper as four stepped lines.
- **Arms.** The two quarter-wave arms run side by side, 1 mm apart.
- **Resistor.** A 0603 resistor stands across that gap at the arms' far ends. Its pads land on both arms, so no extra copper is needed to reach it.
- **Outputs.** After the resistor the 50 Ω outputs run on side by side for 6.6 mm, still 1 mm apart. The netlist models this run as a coupled pair. They then turn away through two mitred bends each, to a 20 mm pitch, which keeps the bends well apart and clear of the resistor.

The board is 47.2 × 36.4 mm.

**Does the coupling matter?** A 1 mm gap on a 1.524 mm board is a strongly coupled pair. The divided power travels in the even mode, so the even-mode impedance of the pair, not the impedance of an isolated arm, must be √2·50 Ω. The isolation works in the odd mode, which now has a different impedance and velocity. Three designs, all lossless, in comb-over's model, over 2.16–2.64 GHz (±10 %):

| arms | how they were designed | modelled | input return loss | output return loss | isolation |
|---|---|---|---|---|---|
| 1.96 mm × 17.71 mm, R 88.0 Ω | as independent lines | as independent lines | 21.4 dB | 30.9 dB | 20.8 dB |
| the same copper | as independent lines | **as coupled (what is built)** | **15.5 dB** | **20.7 dB** | 20.9 dB |
| 2.43 mm × 16.70 mm, R 105.3 Ω | **as coupled** | as coupled | **20.3 dB** | **22.2 dB** | 22.0 dB |

Ignoring the coupling costs about 6 dB of input match and 10 dB of output match. Designed with the coupling, the arms come out wider, to bring the pair's even-mode impedance back up to the arm impedance.

**Full wave.** In openEMS the third design gives 18.1 dB input match, 23.8 dB output match and 21.7 dB isolation over the band, against comb-over's 20.3, 22.2 and 22.0 dB (as built). The isolation and output match agree; the input match is about 2 dB short.

Before #49 comb-over put only half of each bend's inductance in the model. The same design flow then gave 14.4 dB in openEMS against 20.1 dB in comb-over. Worked example 13 (section 5) traces the difference:
- The taper, the coupled arms, the step to the output width and the coupled output run each agree with openEMS on their own.
- The rest was the mitred bends: half the inductance in the model, and the two bends interacting where the outputs split. With the bend model corrected (manual §4.7), what remains is about 2 dB of input match. That is consistent with bends just above W/h 2, where the model's phase error starts to grow, and with the bends' interaction.

**The trim.** `tools/emtrim.mjs` corrects for this by output space mapping:
1. Simulate the design in openEMS.
2. Take the complex difference between openEMS and comb-over at the same reference planes.
3. Re-optimise the arm width, arm length, resistor and taper so that comb-over plus that difference meets the goals.
4. Repeat until openEMS itself meets them.

Here it took one correction, then a final check with the resistor rounded to E24 (102.3 → 100 Ω): three openEMS runs of about 70 s each. The log is in [`examples/em/`](../../examples/em/).

| over 2.16–2.64 GHz, as built (worst) | comb-over alone | openEMS | openEMS, mesh halved |
|---|---|---|---|
| input return loss | 20.6 dB | **21.0 dB** | 20.9 dB |
| output return loss | 21.8 dB | **24.9 dB** | 25.9 dB |
| isolation | 24.1 dB | **23.7 dB** | 23.9 dB |
| split | −3.10 … −3.14 dB | −3.11 … −3.12 dB | −3.04 … −3.05 dB |

The trimmed arms are 2.18 mm × 16.88 mm, with 100 Ω across them. comb-over alone now agrees with openEMS on this board within 0.5 dB on input match and isolation. The board netlist still has no `.goal` lines, because its dimensions come from the trim. The input match has the least margin, 0.9 dB at 2.64 GHz on the finer mesh.

**Not modelled in comb-over:** the bends' interaction where the outputs split, the start of the gap at the end of the taper, and the resistor body over the gap (its pads, ESL and body capacitance are). The openEMS model has the resistor as a plain 100 Ω, without its ESL.

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
- The resistor is already an E24 value (100 Ω). Check its datasheet for ESL and body capacitance: comb-over assumes 0.6 nH and 0.03 pF (set `esl=` and `cp=` on the `res` line), and the openEMS check has none. In comb-over the ESL is worth about 4 dB of isolation, so a part with much more than 0.6 nH deserves a second look.
- The full-wave check is committed in [`examples/em/`](../../examples/em/). After changing anything, rerun it (`node tools/openems.mjs examples/wilkinson-2g4-ro4350b-1524.cir --out oems/`, manual §8.6) or the trim.
