# 15. A three-line coupler with fingers

A three-line coupler sends a sample of the signal on its centre line to both outer lines. On microstrip it has the same problem as a pair, more strongly: the modes travel at different speeds, so its directivity is poor. The plain 20 dB design below has symmetric modes at εeff 2.57 and 3.14, 20 % apart, and 7 dB directivity at 5 GHz in openEMS. Fingers between the lines bring the two modes that a centre-line signal excites to within 1.7 %, and the directivity to 28–39 dB from 2 to 5 GHz.

This example extends worked example 14 to three lines. It covers the match conditions for a centre-driven coupler, the 3-line extraction and design, and the `coupler3` layout. That layout is shaped by what openEMS showed about the coupling around the section's ends.

Netlists: [`examples/coupler3-20dB-ro4350b.cir`](../../examples/coupler3-20dB-ro4350b.cir) (plain) · [`examples/coupler3-20dB-fingers-ro4350b.cir`](../../examples/coupler3-20dB-fingers-ro4350b.cir) (finger-loaded) · results: [`examples/em/`](../../examples/em/) · issue #41. The design needs openEMS (`OPENEMS_PYTHON`) and numpy.

## 1. What a centre input needs

The lines are mirror-symmetric (outer, centre, outer). A signal on the centre line excites only the two mirror-symmetric modes:
- the **c mode**, with all three lines in phase;
- the **π mode**, with the centre line opposed to the outer pair.

The antisymmetric mode (the outer lines in antiphase) only affects the outer ports' match and the outer-to-outer leakage.

In the symmetric subspace the outer pair acts as one line terminated in Z0/2 (its two ports in parallel), and the centre line as one terminated in Z0. That is an asymmetric coupled pair. Normalised to its terminations, it is an ideal coupler when its two modes travel at the same speed and the characteristic impedance matrix Z meets:

- (Z11 + Z13) / Z22 = 1,
- ((Z11 + Z13)/2 · Z22 − Z12²) = Z0²/2.

The coupling to each outer port is then 20 log(k/√2), with k = Z12 / √((Z11 + Z13)/2 · Z22).

For ideal lines that meet these conditions, comb-over gives S23 and S33 below −190 dB.

Matching each line's own impedance to Z0 instead is not enough. It gives S33 −25 dB and S23 −41 dB even for ideal lines with equal velocities. The first finger design here used that target, and its first coupler had a centre-port match of −12 dB.

## 2. Extraction and design

`tools/fingerlibN.mjs` generalises the pair's extraction (worked example 14, section 2) to N lines:
- **Cases:** each case is a 2N-port. Only the lower half of the lines and the centre line are driven, and the mirror gives the rest.
- **Velocities:** de-embedded from two lengths (`tools/fingerbloch.py`). Each mode is labelled symmetric or antisymmetric from its eigenvector.
- **C and L:** the section's 3×3 C and L, mirror-symmetric with 4 + 4 parameters, are fitted to both lengths, with the feeds from the 2-D field solver. The fit's rms is 0.003–0.004.

`tools/fingerdesign3.mjs` searches the outer width Wo, centre width Wc, gap G and finger length lf. It also searches lfo, the length of fingers on the outer lines' outer edges. Its targets are coupling, centre-input match and equal symmetric-mode speeds. Each point is two openEMS sections of 6 and 10 cells, about 10 minutes.

| | plain (field solver) | finger-loaded (openEMS) |
|---|---|---|
| Wo / Wc / G | 1.1259 / 1.0765 / 0.6133 mm | 0.8844 / 0.8607 / 0.9113 mm |
| fingers: width / length / pitch / outer-edge length | — | 0.13 / 0.5423 / 1.0 / 0.4761 mm |
| section | 8.869 mm | 8 cells, 8.0 mm |
| symmetric modes, εeff | 2.57 / 3.14 | 3.595 / 3.656 (1.7 %) |
| match conditions; coupling | met; −20.0 dB | within 2.4 %; −19.9 dB |

The search was stopped at the best point, not driven to the tolerance. Near it the velocity residual moves by ±1 % from point to point, which is about the extraction's noise. Whether the outer-edge fingers are needed is open: the search shortened them steadily (0.6 → 0.48 mm), and longer ones moved the modes apart.

## 3. The layout: what openEMS showed about the ends

A first 3-line test structure took the outer lines away at 45° and ran their 50 Ω feeds beside the centre feed, about 2 mm apart. In openEMS it coupled 3–4 dB more strongly at 1 GHz than its netlist, and its coupling peaked near 3 GHz instead of 5. The extraction was not at fault: on a straight 3-line run, the 2-D solver's C and L reproduce openEMS's centre-to-outer coupling within 0.3–0.7 dB.

The extra coupling came from the ends, in two ways:
- **The feeds.** Moving the outer feeds 4 mm out halved the discrepancy.
- **The side-by-side run where the lines leave the section.** Only the outer line turns away; the centre line runs straight on. So the gap opens at half the rate of a pair's, where both lines diverge. With about 1.5 mm at each end counted as coupled 3-line, the netlist reproduces openEMS within 0.1 dB to 4 GHz.

So `.layout coupler3` (manual §8.1):
- **Ends:** tapers each line to its feed width right at the section's end. A centre-driven coupler's match conditions hold for Z0 terminations at the section itself: with the lines' own ~56 Ω widths carried to the feeds, S33 was −12 dB.
- **Outer lines:** turn straight away, 90°, to ports a pitch above and below.
- **As-built netlist:** models the short side-by-side run before the turn as a coupled 3-line (`K_ea`, `K_eb`).

![The coupler3 layout around the finger-loaded section](../img/ex15-layout.png)

```sh
node tools/kicad.mjs examples/coupler3-20dB-fingers-ro4350b.cir --out kicad/ --board
```

The KiCad core is six pads in three net-tie pairs, and carries all 48 fingers. CI exports both boards and checks them with KiCad's DRC.

## 4. The result

Exported from the netlists through `.layout coupler3`, with no connectors and a centre input (port 3):

![Directivity of the plain and finger-loaded 3-line couplers](../img/ex15-directivity.png)

| openEMS, centre input | 1 GHz | 2 GHz | 3 GHz | 4 GHz | 5 GHz | 6 GHz | 7 GHz |
|---|---|---|---|---|---|---|---|
| directivity: plain (dB) | 14.1 | 12.6 | 11.2 | 9.8 | 7.1 | 3.0 | −2.3 |
| directivity: fingers (dB) | 15.7* | **27.8** | **32.0** | **39.4** | **38.0** | **25.2** | 16.1 |
| coupling S13, fingers: comb-over / openEMS (dB) | −28.8 / −28.4 | −23.4 / −23.3 | −21.0 / −21.0 | −20.0 / −20.2 | −20.3 / −20.7 | −21.8 / −22.4 | −25.1 / −26.0 |
| centre match S33, fingers (dB) | −44.6 | | −38.9 | | −33.1 | | −27.3 |

\* At 1 GHz the finger coupler's isolation is below −44 dB and moves with the mesh. Halving the edge cell took the directivity from 25 to 16 dB. The other figures moved by up to 5 dB, and the coupling by less than 0.1 dB.

- **Coupling.** comb-over agrees with openEMS within 0.4 dB to 5 GHz on the finger coupler and within 0.7 dB on the plain one. Both are as built, through `coupler3`.
- **Directivity.** The fingers lift it from 7 to 38 dB at 5 GHz, and to at least 25 dB from 2 to 6 GHz. comb-over predicts less (16–20 dB). Its as-built netlist treats the side-by-side runs at the ends as bare coupled lines, and their mode mismatch then dominates its isolation figure. So comb-over's directivity for this layout is a lower bound, not an upper one as in example 14.
- **Match.** The centre port is −33 dB at 5 GHz in openEMS (comb-over −36 dB), and −27 dB at 7 GHz.
- **Mesh.** The plain coupler's default edge cell, a third of its 0.61 mm gap, is not converged: at 0.1 mm its coupling moved by 0.5–0.7 dB. Its committed result uses `--fine 0.1`. The finger coupler's committed result uses half its default edge cell.

## 5. Limits

- **The design was not driven to tolerance.** The coupling peaks near 4 GHz rather than 5, and is −20.7 dB at 5 GHz. A redesign that includes the side-by-side runs in its model would recentre it.
- **Per design.** Each design point is two 6-port openEMS runs, about 10 minutes. A design takes a few hours.
- **Outer ports.** Driving an outer line also excites the antisymmetric mode, whose speed and impedance are not designed here. Only the centre input is characterised.
- **The 90° turns are not modelled** in the netlist. The 45° and 90° turns tried gave similar coupling within about 1 dB in openEMS.
