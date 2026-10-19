# comb-over

Browser-based analysis of N-port networks built from **coupled multiconductor TEM / quasi-TEM line sections**: comb-line and interdigital filters, couplers (including Lange), Marchand baluns, Schiffman sections, and anything else you can wire from coupled lines, single lines, and lumped R/L/C.

No build step and no dependencies: plain ES modules plus canvas.

## Documentation

The documentation is published as web pages next to the designer: `docs/manual.html` and `docs/examples/index.html`, linked from its toolbar. The Markdown sources below are what you edit; run `npm run docs` to regenerate the HTML.

- **[Manual](docs/manual.md):** the interface, the full netlist language, plots, tuning and optimisation, synthesis, and the model and its limits.
- **[Worked examples](docs/examples/README.md):**
  1. transformers;
  2. couplers, including microstrip directivity compensation;
  3. comb-line from specification to loss budget;
  4. interdigital by hand;
  5. Marchand balun;
  6. Schiffman;
  7. a three-line section from field-solver C/L matrices;
  8. from a coupler netlist to a KiCad board.

## Run it

Serve the folder (ES modules don't load from `file://`):

```sh
python3 -m http.server 8000      # then open http://localhost:8000
```

or enable **GitHub Pages** (Settings → Pages → Deploy from branch → `main` / root).

Tests (Node ≥ 18):

```sh
npm test          # engine + synthesis tests
```

## What it does

- Write a netlist in the editor (press **Syntax** for the full reference). It re-solves as you type.
- **Plots:** rectangular and Smith plots of arbitrary trace expressions, e.g. `db(S31/S41)` for directivity or `ang(S21/S43)` for a phase difference. Hover to read values at a frequency.
- **Tuning:** `.param x = … tune lo hi` gives you a slider for `x`.
- **Optimiser:** `.goal` statements drive a Nelder–Mead optimiser over the tuned parameters. When it finishes, the results are written back into the netlist.
- **Section info:** the modal velocities (ε_eff), modal impedances and voltage eigenvectors are shown for each section.
- **Touchstone export:** `.sNp` in RI, MA or dB format. Mixed port impedances are written as Touchstone 2.0 with `[Reference]`.
- **Layout and KiCad:** the layout panel turns a coupler, Schiffman or Marchand netlist into a microstrip layout on a chosen substrate, with edge-launch SMAs. It checks the layout against the fab's rules, can overlay the as-built response on the plots, and exports a KiCad 9 component library or a complete KiCad project (manual §8, worked example 8).
- **Sharing:** **Link** copies a URL with the netlist embedded in it. The editor content is also kept in localStorage.

### Example

```
.freq 1G 3G 401
.ref 2G
port in
port thru
port cpl
port iso
cline K
  Zeo 120.7 20.7
  er 2.2
  len 90deg
  A in   cpl
  B thru iso
end
.plot db(S11) db(S21) db(S31) db(S41)
```

More examples are in `examples/` and in the **Examples** menu: comb-line, interdigital, 3 dB stripline coupler, 10 dB microstrip coupler, Lange, Marchand, and Schiffman.

## Synthesis

**Synthesise…** designs a tapped **comb-line** or **interdigital** band-pass filter from a Chebyshev or Butterworth prototype. It writes the result as an ordinary netlist, which you can then inspect, tune or optimise.

1. **Prototype → couplings.** The g-values give k<sub>i,i+1</sub> = FBW/√(g<sub>i</sub>g<sub>i+1</sub>) and Q<sub>e</sub> = g₀g₁/FBW.
2. **Closed form.** Each resonator's open end is treated as a node, with all other resonator nodes grounded. Y<sub>a</sub> = 1/Z<sub>r</sub> is a line's admittance with its neighbours grounded.
   - comb-line:
     - resonator slope b = (Y<sub>a</sub>/2)(cot θ₀ + θ₀ csc² θ₀)
     - inverter J = Y<sub>m</sub> cot θ₀
     - end capacitor C<sub>l</sub> = Y<sub>a</sub> cot θ₀/ω₀
   - interdigital (θ₀ = 90°):
     - resonator slope b = πY<sub>a</sub>/4
     - inverter J = Y<sub>m</sub>
   - Then Y<sub>m</sub> = k·b/(J/Y<sub>m</sub>), and the normalised capacitances are Cg = (Y<sub>a</sub> − ΣY<sub>m</sub>)η and Cm = Y<sub>m</sub>η.
   - Tap position: sin θ<sub>t</sub> = sin θ₀ √(b R₀/Q<sub>e</sub>), from the resonator voltage being ∝ sin βz measured from the short.
3. **Refinement** (optional):
   - Each Y<sub>m</sub> is corrected so the isolated pair's split-mode coupling (f<sub>o</sub>² − f<sub>e</sub>²)/(f<sub>o</sub>² + f<sub>e</sub>²) equals the target. This is exact within the model and solved by root finding.
   - The tap position and end-resonator capacitor are corrected using the full multiconductor model of the singly loaded first resonator. Q<sub>e</sub> = ω<sub>r</sub>τ<sub>max</sub>/4 is taken from the S11 group delay.
   - Finally the design f₀ and FBW are pre-distorted so the realised centre and −3 dB bandwidth land on target.
4. **Polish** (optional): the generated netlist includes tune ranges and a return-loss `.goal`, so the optimiser can remove the remaining ripple error.

Measured on n = 5, 0.0432 dB ripple designs (`npm test` checks a subset):

| | closed form | refined | refined + polish |
|---|---|---|---|
| centre / −3 dB BW error | up to −2.7 % / +5 % at 20 % BW (comb) | < 0.05 % / < 0.5 % | same |
| in-band return loss (target 20 dB), 2–20 % BW | 6.5–14 dB | 12–19 dB | ≥ 20 dB |

The remaining ripple error after refinement comes mostly from couplings the nodal model ignores. The main one is direct tap-to-resonator-2 coupling through the coupled segment, which is why the optimiser is needed for the last step.

The trace functions `cheby(n,ripple,f0,fbw)` and `butter(n,f0,fbw)` plot the ideal |S21| for comparison.

## Model

For each section with per-unit-length Maxwell capacitance **C** and inductance **L**:

- **Modes:** M = C^½ L C^½ = P Λ Pᵀ, and W = C^½ P. The modal velocities are vᵢ = 1/√λᵢ.
- **Admittance matrix:** with terminals ordered A₁…A_N, B₁…B_N,
  - Y₁₁ = Y₂₂ = W diag(vᵢ coth γᵢℓ) Wᵀ
  - Y₁₂ = Y₂₁ = −W diag(vᵢ csch γᵢℓ) Wᵀ
- **Homogeneous case:** this reduces to Y₁₁ = vC coth γℓ.
- **Assembly:** sections and lumped elements are stamped into a nodal admittance matrix. Each port node is terminated in its reference conductance G, and S = 2√G·X<sub>pp</sub>·√G − I, where (Y + G)X = E<sub>ports</sub>.
- **Loss (optional):** a constant unloaded Q per section, with αᵢ = βᵢ/2Q. Characteristic admittances stay real, so this is a low-loss approximation.
- **Singular points:** exact half-wave frequencies of lossless lines are evaluated 1 ppb away, which gives the limiting value.

**Not modelled** by the line model itself: end and junction parasitics, and bond wires. Microstrip sections given by W and S do include dispersion and frequency-dependent loss (manual §4.6). Open ends, grounding vias (`via` element) and connector launches are added by the layout templates (manual §4.7); anything else can be added as lumped elements or extra line sections.

### Line-constant inputs

| keyword | meaning |
|---|---|
| `Zeo Z0e Z0o [εe εo]` | symmetric pair; inhomogeneous if εe ≠ εo |
| `Y0 [...]` / `Z0 [...]` | characteristic admittance / impedance matrix (homogeneous, `er`) |
| `Cn [...]` | normalised Maxwell matrix C/ε (Matthaei / Getsinger convention) |
| `Cg …` + `Cm …` / `Cm(i,j) …` | normalised ground and mutual capacitances |
| `C [...]` + `L [...]` | general per-unit-length matrices (F/m, H/m) |

## Verification

`tests/run.mjs` checks the engine against:

- the quarter-wave transformer;
- the ideal 3 dB coupler (match, isolation, quadrature);
- the even/odd closed form for an inhomogeneous pair with unequal velocities;
- reciprocity and losslessness (SᴴS = I) of a general 3-line section;
- agreement between the Cg/Cm, Cn and Y0 parameterisations;
- a cascade of two sections against one;
- the Q loss model.

## Tools

- `node tools/layout.mjs FILE.cir --svg out.svg`: build the `.layout` of a netlist (coupler, Schiffman or Marchand template), check it against the fab rules, and write the SVG preview or the as-built netlist.

- `node tools/kicad.mjs FILE.cir --out DIR [--board]`: export the layout's core as a self-contained KiCad 9 library (footprint with net-tied custom pads, symbol, library tables, core netlist), or with `--board` a complete KiCad 9 project (feeds, GND pours, stitching vias, stack-up).

- `node tools/mscalc.mjs --sub ID --z0 50 [--f F]`: microstrip calculator. It gives the width for a target Z0, W and S for even/odd impedances (`--ze`/`--zo`), or analyses a geometry (`--w`, `--s`), including losses.

- `node tools/opt.mjs file.cir [iters] [rounds]`: run the optimiser headless and write the tuned values back to the file.
- `node tools/summary.mjs file.cir 11 21`: print a text table of the response.

## Roadmap

- Synthesis:
  - Matthaei-style input/output-line coupling as an alternative to taps;
  - cross-coupled (transmission-zero) comb-line designs;
  - an inhomogeneous (microstrip) comb-line variant.
- Geometry → C/L via a 2-D field solver (stripline / coax-bar first, then microstrip).
- Varactor tuning sweeps, Monte-Carlo tolerances.
