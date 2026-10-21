# 13. Checking a coupler in openEMS

comb-over's models are closed forms and 2-D field solutions joined by circuit theory. A full-wave simulation solves Maxwell's equations on the actual copper and includes everything those models leave out. This example exports the 10 dB coupler on 0.508 mm RO4350B to [openEMS](https://openems.de) (an open-source FDTD solver), runs it, and compares the two.

Netlist: [`examples/coupler-10dB-ro4350b.cir`](../../examples/coupler-10dB-ro4350b.cir) (from [worked example 2](02-couplers.md)) · results: [`examples/em/`](../../examples/em/) (the openEMS Touchstone files and comparison netlists). Section 5 runs the same check on the compact Wilkinson of example 12, and finds a real problem.

```sh
node tools/openems.mjs examples/coupler-10dB-ro4350b.cir --out oems/ --excite 1
cd oems && python3 10_dB_coupled-line_coupler_*.py        # openEMS's Python modules must be importable
cd .. && node tools/openems.mjs --compare oems/
```

The run takes 1 min 40 s on two cores: 540 k cells, 20 400 timesteps to −41 dB of the peak field energy. `--excite all` drives each port in turn and fills the whole S-matrix (four runs).

## 1. What is exported

- **Copper.** The layout's core, feeds and part pads as polygons on the substrate: zero-thickness conducting sheets with the copper's conductivity and thickness (for loss), or PEC with `--lossless`. Vias are PEC cylinders; chip resistors and capacitors are lumped elements across their pads.
- **Substrate.** εr and tan δ of the `.substrate`, the loss as a conductivity matched at the sweep centre.
- **Ports.** The feeds are rebuilt as straight lines to the board edge (no edge connectors). Each has an openEMS microstrip port terminated in its impedance, with its measurement plane max(3 mm, 2W) in from the edge.
- **Boundaries.** PEC ground; PML on every other side, 5h (at least 3 mm) beyond the copper, except at the port ends, where the feeds run into it.
- **Comparison netlist.** The as-built netlist with each feed shortened to the measurement plane, so both sides have the same reference planes. It overlays the openEMS result as `.data em … overlay`, so it can be opened in the designer with **Data…**.

## 2. The result

![openEMS against comb-over](../img/ex13-coupler.png)

Port 1 driven, comb-over's as-built model against openEMS:

| | 1 GHz | 3 GHz | 5 GHz | 7 GHz | 9 GHz |
|---|---|---|---|---|---|
| S31, coupling (dB) | −19.80 / −19.71 | −11.79 / −11.78 | −10.20 / −10.37 | −12.06 / −12.53 | −20.12 / −21.84 |
| S41, isolation (dB) | −36.2 / −38.4 | −28.4 / −30.4 | −24.9 / −28.7 | −20.7 / −23.9 | −17.2 / −19.6 |
| S11, match (dB) | −38.4 / −38.2 | −33.7 / −32.4 | −34.2 / −35.1 | −24.3 / −26.4 | −19.4 / −23.3 |
| ∠S21, openEMS − comb-over | −1.1° | −3.3° | −6.0° | −9.3° | −13.4° |
| power lost (%) | 0.6 / 1.9 | 1.6 / 1.9 | 2.6 / 1.8 | 3.7 / 2.1 | 4.8 / 2.0 |

**Coupling** agrees to 0.2 dB from 1 to 5 GHz (0.17 dB at the 5 GHz centre, 0.29 dB at 6 GHz). Above that openEMS falls off faster, because its coupler is electrically a little longer (next point).

**Phase.** openEMS's transmission lags by 6° at 5 GHz, over a 26 mm path. The parts of that, found by simulating a straight 50 Ω line of the same width on its own:
- **Copper thickness, about 2°.** The openEMS strips are zero-thickness sheets; comb-over includes the 35 µm copper, which lowers εeff. With `.substrate … t=0` in the comparison netlist, the lag at 5 GHz is 4.8°.
- **Dispersion, 0° at 5 GHz, about 2° at 9 GHz.** comb-over evaluates each line once, at the `.ref` frequency (5 GHz here), and keeps that εeff across the sweep (manual §4.6). Below 5 GHz its εeff is slightly too high and above it slightly too low. For this line Kirschning–Jansen gives εeff 2.852 at 1 GHz, 2.870 at 5 GHz and 2.894 at 9 GHz. That is why the lag grows faster than in proportion to frequency.
- **The layout's corners, about 4°.** The 45° bends where the feeds meet the diverging arms, and the corners where the arms meet the coupled section, are not in comb-over's netlist. They act as about 0.4 mm of extra line.

**Isolation** is 2–4 dB better in openEMS. In comb-over's model, the coupled section's directivity is set by the difference between the even- and odd-mode velocities. The full-wave model also includes the coupling between the diverging arms at each end of the section, which is not in comb-over's netlist; it may partly compensate. The cause is not separated here. Isolation is also the most mesh-sensitive quantity: it moves by 1–2 dB when the mesh is refined (section 3).

**Match** agrees within 2 dB up to 6 GHz. Above that openEMS is better matched. Both are below −19 dB everywhere.

**Radiation.** With `--lossless`, openEMS's power balance is within the port's accuracy (0 to −1 %) across the band, so this coupler radiates less than about 1 % of the power up to 9 GHz. On 0.508 mm material this is expected: the substrate is thin compared with the wavelength.

**Loss.** comb-over's loss grows with frequency as it should (dielectric ∝ f, conductor ∝ √f). openEMS's stays near 2 %, because its dielectric loss is a conductivity, which gives the right tan δ only at the sweep centre. To check loss, export a narrow band (`--fmin`, `--fmax`).

## 3. Is the mesh fine enough?

The `fine` cell (default: a third of the narrowest strip or gap, here 0.034 mm) sets the mesh at copper edges. Halving it (`--fine 0.017`: 690 k cells, 4.5 min):

| at 5 GHz | fine 0.034 mm | fine 0.017 mm |
|---|---|---|
| S31 | −10.37 dB | −10.13 dB |
| S41 | −28.7 dB | −29.6 dB |
| ∠S21 − comb-over | −6.0° | −6.0° |

Coupling moves by 0.24 dB and phase not at all, so the default mesh is adequate for coupling and phase. Isolation and match, 30–40 dB down, move by 1–2 dB; treat them as ±2 dB.

## 4. Lessons from setting this up

These are built into the export now, but they matter if you edit the script or write your own.

- **Edges by the thirds rule.** A zero-thickness strip's edge should sit a third of the way into its mesh cell: one line fine/3 inside the metal and one 2·fine/3 outside. With a line on each side at ±fine/2 instead, a straight 50 Ω line's εeff came out 4 % high and the coupler's coupling 0.9 dB too strong.
- **The port's feed outside the PML.** openEMS silently drops a port's terminating resistor inside the absorber (the log says "Unused primitive … port_resist"). The export meshes each port end uniformly so the feed sits on the 10th line, beyond the 8 PML cells.
- **No DC in the excitation.** The coupler's two strips are not connected at DC. A Gaussian pulse with a DC component leaves charge on them, and the field energy never falls to the end criterion. The export subtracts the DC from openEMS's pulse.
- **Port orientation.** An openEMS microstrip port's `start` is at the strip and `stop` at the ground; the port draws its own strip at `start`.
- **No series lumped elements.** A series R–L lumped element (a chip resistor with its ESL) gave NaN fields from the first timestep in some runs of openEMS v0.37 (development), depending on the script's memory layout, not on the model. The export uses a plain R.

## 5. A second board: the compact Wilkinson

The same export on the compact Wilkinson of [worked example 12](12-wilkinson-and-branch-line.md) (`--excite all`: three runs, 16 s each, 112 k cells) finds a real problem. Result: [`examples/em/wilkinson-2g4-ro4350b-1524-openems.s3p`](../../examples/em/), with its comparison netlist.

The export gives the isolation resistor to openEMS as a plain 73.3 Ω, without the ESL and body capacitance in comb-over's `res` model. The comparison netlist drops them too (`esl=0 cp=0`), so the two sides have the same circuit.

| at 2.4 GHz | comb-over | openEMS |
|---|---|---|
| S11, input match | −38.2 dB | −13.3 dB |
| S22, output match | −25.6 dB | −14.4 dB |
| S32, isolation | −26.7 dB | −20.7 dB |
| S21 | −3.07 dB | −3.27 dB |

Halving the mesh cell (`--fine 0.15`) changes S11 by 0.2 dB, so this is not mesh error.

**Isolation: explained.** After the resistor, the two outputs run side by side for 4.9 mm, still 1 mm apart, before they turn away. The layout's netlist models these two runs as independent lines. Modelled as a coupled pair (a `cline` with W 3.29 mm and S 1 mm), comb-over's isolation becomes −32.9, −20.3 and −15.6 dB at 2.16, 2.4 and 2.64 GHz, against openEMS's −33.4, −20.7 and −15.9 dB.

**Match: only partly explained.** With the output pair coupled, comb-over's input match drops to −26 dB, still well short of openEMS's −13 dB. The rest probably comes from the input junction. There, the 3.29 mm input line overlaps each 2.78 mm arm by only 1.15 mm, and the closed-form width step does not describe that shape. S21 also carries an almost frequency-independent phase offset of about −10°, which points to a lumped reactance rather than extra line length.

**What this means for the design.** The compact Wilkinson's layout needs changing before it is built: model the output pair as coupled lines (or turn the outputs away at once), and design the input junction rather than butt the line against the arms. Worked example 12 now carries a warning.

**Loss.** In both boards openEMS shows less loss than comb-over (0.3 % against 1.4 % here at 2.4 GHz, port 1 driven). This has not been investigated.
