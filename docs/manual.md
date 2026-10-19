# comb-over manual

comb-over analyses linear networks built from **uniform coupled multiconductor TEM / quasi-TEM line sections**, single lines and lumped R/L/C. It also synthesises tapped comb-line and interdigital band-pass filters. Everything runs in the browser, and the same engine runs under Node for scripting and tests.

Worked examples are in [docs/examples](examples/README.md).

## Contents

1. [Running it](#1-running-it)
2. [The interface](#2-the-interface)
3. [Netlist language](#3-netlist-language)
4. [Coupled-line sections](#4-coupled-line-sections)
5. [Plots and trace expressions](#5-plots-and-trace-expressions)
6. [Tuning and optimisation](#6-tuning-and-optimisation)
7. [Filter synthesis](#7-filter-synthesis)
8. [Export and sharing](#8-export-and-sharing)
9. [The model, its assumptions and limits](#9-the-model-its-assumptions-and-limits)
10. [Command-line tools](#10-command-line-tools)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. Running it

The app is a static page with ES modules and has no build step. Browsers refuse to load modules from `file://`, so serve the folder:

```sh
python3 -m http.server 8000        # from the repository root
# open http://localhost:8000
```

Or enable GitHub Pages for the repository (Settings → Pages → deploy from `main`, root).

Tests and tools need Node 18 or later:

```sh
npm test                           # engine + synthesis tests
```

---

## 2. The interface

![UI overview](img/ui-overview.png)

| Area | What it does |
|---|---|
| **Editor** (left) | The netlist. It re-solves 350 ms after you stop typing, or on **Run** / Ctrl+Enter. Tab inserts two spaces. A parse error shows in red in the status line, and its line number is highlighted in the gutter. |
| **Status line** | Port, node, section and point counts and solve time. Also shows the goal cost and worst violation per goal (if any), singular-point count and warnings. |
| **Tune** | One slider per `.param … tune lo hi`. Sliders override the netlist values without editing the text.<br>• **Write to netlist** copies the slider values into the `.param` lines.<br>• **Reset** discards them.<br>• Editing the text also discards slider overrides. |
| **Line sections** | For each coupled section: physical length, and for each mode its ε<sub>eff</sub>, v/c, modal impedance and voltage eigenvector (§4.4). |
| **Plots** (right) | One panel per `.plot` / `.smith` statement. Hovering shows a cursor synchronised across all plots, and the legends show the values at that frequency. |
| **Examples…** | Loads a netlist from `examples/`. |
| **Synthesise…** | Filter synthesis dialog (§7). |
| **Optimise** | Runs the goal optimiser (§6). The button becomes **Stop** while it runs. |
| **Open… / Save .cir** | Load or save the netlist text. |
| **RI / MA / DB + Export .sNp** | Touchstone export of the full S-matrix (§8). |
| **Link** | Copies a URL with the netlist embedded. |
| **Syntax** | Quick reference, with links into this manual. |
| **Manual / Examples guide** | Open these documentation pages in a new tab. |

The editor content is also kept in the browser's localStorage, so a reload restores it.

---

## 3. Netlist language

### 3.1 Lexical rules

- **Statements:** one per line.
- **Comments:**
  - from `#` or `//` (at the start of a line or after whitespace) to the end of the line;
  - a line starting with `*` (SPICE style).
- **Tokens:** statements are split on whitespace. Inside `( )` and `[ ]` whitespace does not split, so an **expression must not contain spaces except inside brackets**. For example, `Z0*sqrt((1+k)/(1-k))` is fine, but `Z0 * 2` is three tokens.
- **Keywords:** case-insensitive. Node and parameter names are case-sensitive.

### 3.2 Numbers and units

A number may carry an SI prefix, optionally followed by a unit, which is ignored:

| Prefix | f | p | n | u (µ) | m | k (K) | M, meg | G | T |
|---|---|---|---|---|---|---|---|---|---|
| ×  | 1e-15 | 1e-12 | 1e-9 | 1e-6 | 1e-3 | 1e3 | 1e6 | 1e9 | 1e12 |

Examples: `2.2pF`, `1.5GHz`, `68nH`, `25mm` (= 0.025), `50Ohm`.

There are three special units:
- `mil` (25.4 µm);
- `in` (25.4 mm);
- `deg`, which marks a section length as electrical degrees (§4.2).

> **Watch out:**
> - `m` is *milli*, so `1m` is 0.001. A bare number in a length field is **metres**: `len 25` is 25 m. Write `25mm`.
> - `M` is *mega*, so `1M` is 10⁶.

### 3.3 Expressions

Values anywhere in the netlist are expressions:

- **Operators:** `+ − * / ^` (right-associative) and unary `−`.
- **Functions:**
  - trigonometric, radians: `sin cos tan cot asin acos atan atan2`;
  - trigonometric, degrees: `sind cosd tand cotd`;
  - hyperbolic: `sinh cosh tanh asinh acosh atanh`;
  - others: `sqrt exp ln log log10 abs min max floor ceil round db2mag mag2db` (`ln` and `log` are both natural logarithms).
- **Constants:**
  - `pi` and `e`;
  - `c0` (speed of light);
  - `mu0`, `eps0`;
  - `eta0` (376.73 Ω).
- **Parameters:** any `.param` defined earlier in the file.

### 3.4 Directives

| Directive | Meaning |
|---|---|
| `.freq START STOP [POINTS] [log]` | Sweep (required). POINTS defaults to 401. `log` gives log spacing. |
| `.ref F0` | Reference frequency for `deg` lengths. Default: the sweep centre. |
| `.param NAME = EXPR [tune LO HI]` | Parameter, evaluated in file order. `tune` adds a slider and makes it an optimiser variable bounded by LO..HI. |
| `.title TEXT` | Title, used for export file names. |
| `.plot [ylim=LO,HI] [title=Text_with_underscores] TRACE …` | Rectangular plot against frequency (§5). |
| `.smith TRACE …` | Smith chart of complex traces. |
| `.goal TRACE OP VALUE [F1 F2] [w=W]` | Optimisation goal. OP is `<`, `>` or `=` (§6). |
| `.opt maxiter=N` | Optimiser iteration limit (default 400). |
| `.layout TEMPLATE SECTION… [key=value …]` | Board layout preview from a template (§8.1). At most one per netlist. |
| `.substrate ID [key=value …]` | PCB technology (§3.6). At most one per netlist. Required by lines given by dimensions. |

Unknown directives are ignored with a warning.

### 3.5 Nodes, ports and elements

- **Ground:** `0`, `gnd`, `GND` or `ground`.
- **Open (unconnected) terminal:** `-`, `open` or `nc`. Each use is a separate floating node.
- **Other names:** any other name is a node. The same name anywhere means the same node.

| Statement | Meaning |
|---|---|
| `port NODE [Z0]` | Port numbered in order of appearance (1, 2, …). Z0 is the real reference impedance, default 50 Ω. A port cannot be on ground, and two ports cannot share a node. |
| `R<name> N1 N2 VALUE` | Resistor (non-zero). |
| `C<name> N1 N2 VALUE [Q=..]` | Capacitor. With Q, it has a shunt conductance ωC/Q. |
| `L<name> N1 N2 VALUE [Q=..]` | Inductor. With Q, it has a series resistance ωL/Q. |
| `T<name> N1 N2 Z0=.. len=.. [er=..] [Q=..] [f0=..]` | Single uncoupled line, both ends referenced to ground. |
| `T<name> N1 N2 W=.. len=.. [Q=..] [f0=..]` | Single microstrip line of width W on the `.substrate` (§4.6). |
| `wire N1 N2 [N3 …]` | Joins nodes (a zero-ohm short). Use this instead of a 0 Ω resistor. |
| `cap <name> N1 [N2] C=.. [type=ideal\|smd\|printed\|trimmer] [pkg=0402\|0603\|0805] [Q=..] [esl=..] [d=..] [n=..] [a=..] [series=E12\|E24] [mpn=..]` | A loading capacitor with its parasitic model (§7.5): to ground unless N2 is given. |
| `via <name> N1 [N2] d=.. [n=..] [h=..] [Q=..]` | `n` plated vias of drill `d` from N1 to ground (or to N2), as the Goldfarb–Pucel inductance (§4.7). `h` defaults to the `.substrate` height. |
| `cline NAME … end` | Coupled multiconductor section (§4). |

Element names follow SPICE: the first letter selects the type (`C1`, `Cload`, `Lchoke`, `T5`).

---

### 3.6 Substrates

`.substrate` names the PCB technology the design is meant for. Pick a preset, optionally overriding values, or describe a board of your own:

```
.substrate jlc-ro4350b-0.508                 # preset
.substrate jlc-fr4-1.6 er=4.3 tand=0.018      # preset with overrides
.substrate custom h=0.8mm er=3.0 tand=0.002 t=18u
```

The presets cover the JLCPCB 2-layer boards, each with its source and access date:

- **FR-4** at 0.4–2.0 mm board thickness.
- **Rogers RO4350B** at 0.508, 0.762 and 1.524 mm. These use the Rogers *design* Dk of 3.66, not the process Dk of 3.48 that JLCPCB quotes.
- **Four PTFE laminates** at 0.762 and 1.524 mm.

The full list, with every assumption flagged, is on the generated [substrate presets](substrates.md) page.

| key | meaning | default (custom) |
|---|---|---|
| `h` | dielectric thickness | required |
| `er` | relative permittivity | required |
| `tand` | loss tangent, quoted at `ftand` | 0 |
| `ftand` | frequency at which `tand` applies | 1 GHz |
| `t` | copper thickness | 1 oz (34.8 µm) |
| `sigma` | copper conductivity | 5.8×10⁷ S/m |
| `rough` | RMS copper roughness | none |
| `mintrace`, `minspace`, `mindrill` | fabrication limits | none |

Behaviour:

- **Order.** `.substrate` is processed in file order together with `.param`. Overrides may therefore use earlier parameters, including tuned ones, so slider and optimiser values flow into the substrate.
- **Expression names.** Statements after it can use `sub_h`, `sub_er`, `sub_tand`, `sub_t` and `sub_sigma` in expressions, e.g. `er sub_er` in a `cline` block.
- **Display.** The substrate's values, assumptions and sources are shown at the top of the info panel.
- **Effect on the simulation.** Lines given by physical dimensions (`T … W=`, `cline … W= S=`) take their impedances, effective permittivities and losses from the substrate (§4.6). Otherwise the substrate only affects the simulation through the `sub_*` names. Layout and KiCad export will also use it (issues #5–#10).

## 4. Coupled-line sections

### 4.1 Syntax

```
cline NAME [len=..] [er=..] [Q=..] [f0=..]
  <line constants>          # exactly one parameterisation, see 4.3
  er   EPS_R                # homogeneous dielectric (default 1)
  len  LENGTH               # e.g. 90deg, 25mm, tt*1deg
  f0   F                    # reference for deg (default .ref)
  Q    QU                   # unloaded Q of the line (optional)
  A    n1 n2 … nN           # terminal nodes at end A (z = 0), lines 1..N
  B    n1 n2 … nN           # terminal nodes at end B (z = ℓ)
end
```

`end`, `.end` and `endc` all close the block. N is taken from the line constants. `A` and `B` must each list exactly N nodes.

Line i at end A and line i at end B are the two ends of the same conductor. Terminations are just node names:

- `0` shorts the end;
- `-` leaves it open;
- a named node connects it to ports, elements or other sections.

Sections that share node names connect, so cascades, tapped lines and stepped structures are made from several `cline` blocks. Example 4 shows a tapped interdigital filter built from two sections.

### 4.2 Length

- **Physical length:** a value with a length unit (`25mm`, `980mil`), or a plain number in metres.
- **Electrical length:** any expression containing a `deg` number (`90deg`, `tt*1deg`, `(th0-tt)*1deg`). This is degrees at f0, the section's `f0` or else `.ref`. ℓ = θ/360 · v̄/f0.
  - Homogeneous section: v̄ is the phase velocity.
  - Inhomogeneous section: v̄ is c divided by the mean of √ε<sub>eff</sub> over the modes. The modes then have different electrical lengths, and the Line sections panel shows each mode's ε<sub>eff</sub>.

### 4.3 Line constants

Use exactly one of these. Lines are numbered 1..N in the order used by `A`/`B`.

| Keyword | Medium | Meaning |
|---|---|---|
| `Zeo Z0e Z0o` | homogeneous (`er`) | Symmetric pair, per-line even/odd impedances. |
| `Zeo Z0e Z0o εe εo` | inhomogeneous | Same, with even/odd effective permittivities. |
| `Y0 [y11 y12; y21 y22]` | homogeneous | Characteristic admittance matrix (S). Y0 = v·C. |
| `Z0 [ … ]` | homogeneous | Characteristic impedance matrix (Ω), Z0 = Y0⁻¹. |
| `Cn [ … ]` | homogeneous | Normalised Maxwell capacitance matrix C/ε (dimensionless, ε = ε0·εr). Matthaei/Getsinger convention. |
| `Cg g1 … gN` + `Cm m12 m23 …` | homogeneous | Normalised ground capacitances and adjacent mutual capacitances (all positive). Add non-adjacent terms with `Cm(i,j) value`. |
| `C [ … ]` and `L [ … ]` | general | Per-unit-length Maxwell capacitance (F/m) and inductance (H/m) matrices. This is the form a 2-D field solver gives. |
| `geom msl` + `W …` + `S …` | `.substrate` | Coupled microstrip pair given by strip width and gap. Two lines only; N-line geometry needs the field solver (issue #12). Also accepted inline: `cline K geom=msl W=0.88mm S=0.1mm`. |

Matrices are written `[a b c; d e f; g h i]`, with rows separated by `;` and entries by spaces or commas. They must be square and symmetric, and C must be positive definite.

The **Maxwell capacitance matrix** has positive diagonal entries (each line's total capacitance with all other lines grounded) and negative off-diagonal entries. Ground and mutual capacitances convert to it as

```
C_ii = Cg_i + Σ_j Cm_ij,    C_ij = −Cm_ij
```

The homogeneous forms are converted to C and L with v = c/√εr:

| Form | Conversion |
|---|---|
| `Cn` | C = ε·Cn |
| `Y0` | C = Y0/v |
| all homogeneous forms | L = C⁻¹/v² |

For `Zeo`, the mode capacitances are C<sub>e,o</sub> = √ε<sub>e,o</sub>/(c Z<sub>0e,0o</sub>) and the mode inductances are L<sub>e,o</sub> = Z<sub>0e,0o</sub>√ε<sub>e,o</sub>/c. They are combined as C = [[(Ce+Co)/2, (Ce−Co)/2], …], and likewise for L.

### 4.4 Modes (Line sections panel)

For each mode the panel shows:

- **ε<sub>eff</sub>:** the effective permittivity, (c/vᵢ)².
- **v/c:** the mode velocity.
- **Z<sub>mode</sub>:** 1/(vᵢ·tᵀCt), where t is the unit-norm voltage eigenvector. For a symmetric pair this is exactly Z0e and Z0o.
- **Voltage vector:** the eigenvector t.

In a homogeneous medium all modes have the same velocity, so any basis is valid. The panel then shows the eigenvectors of C (the characteristic-admittance eigenmodes).

### 4.5 Loss

`Q` on a section gives every mode an attenuation αᵢ = βᵢ/(2Q). The characteristic admittances are left real. This is a low-loss, frequency-independent-Q approximation: it gives the right insertion loss and dissipation of a high-Q resonator, but not the √f behaviour of conductor loss.

### 4.6 Microstrip models

`js/microstrip.js` gives physical models for single microstrip lines and coupled pairs. Netlists use them through lines given by dimensions on the `.substrate`:

```
.substrate jlc-ro4350b-0.508
.param w = 0.883mm tune 0.5mm 1.3mm
T1 a b W=1.07mm len=20mm                 # single microstrip line
cline K geom=msl W=w S=0.1025mm          # coupled pair (geom msl is the default when W and S are given)
  len 90deg
  A in   cpl
  B thru iso
end
```

How these lines are modelled:

- **Evaluation frequency.** The models are evaluated once, at the section's `f0` (or `.ref`), including dispersion of εeff. The section then behaves as a TEM line with those values across the sweep. Away from `f0` this ignores the change of εeff and Z with frequency. For example, for the 10 dB coupler on 0.508 mm RO4350B the even-mode εeff goes from 2.995 at 1 GHz to 3.025 at 5 GHz and 3.058 at 9 GHz: about ±1 %, or ±0.5 % in phase velocity. Frequency-dependent sections are a possible follow-up.
- **Losses.** Substrate losses are included by default: conductor loss with roughness, plus dielectric loss, evaluated at `f0` and applied as a Q. A coupled pair gets separate Q values for its even and odd modes. Write `Q=` to override this; a very large `Q` (e.g. `Q=1e30`) makes the line lossless.
- **Tuning.** W and S are ordinary expressions, so `tune` parameters let the sliders and the optimiser adjust the actual copper dimensions.
- **Warnings.** Model-range and fab-rule warnings (e.g. a gap below JLC's 0.1 mm) appear in the status line. The Line sections panel shows the resulting Z or Ze/Zo and the Q values.

You can also use the models directly, through the command-line calculator or from JavaScript:

```sh
node tools/mscalc.mjs --sub jlc-ro4350b-0.508 --z0 50 --f 2G          # width for 50 Ω
node tools/mscalc.mjs --sub jlc-ro4350b-0.508 --ze 69.4 --zo 36 --f 5G  # W and S for a 10 dB coupler
node tools/mscalc.mjs --sub jlc-fr4-1.6 --w 2.8mm --f 1G                 # analyse a geometry
```

| | model | notes |
|---|---|---|
| single line | Hammerstad & Jensen (1980), with their strip-thickness correction | quasi-static Z0, εeff |
| single-line dispersion | Kirschning & Jansen (1982) for εeff; Jansen & Kirschning (1983) for Z0 | uses the thickness-corrected width, as scikit-rf does |
| coupled pair | Kirschning & Jansen (1984) | quasi-static even/odd Z and εeff; dispersion of even/odd εeff |
| coupled strip thickness | Jansen's even/odd effective widths with the Hammerstad–Bekkadal ΔW | published for S ≫ 2t |
| conductor loss | Wheeler's incremental-inductance rule applied to the same models, with the Hammerstad roughness factor | default; `model: 'hammerstad'` gives Rs/(Z0·W)·Ki·Kr instead |
| dielectric loss | αd = π f/c · εr(εeff − 1)/(√εeff (εr − 1)) · tan δ | |

**Validity ranges.** The functions return warnings when an input is outside the published range:

| model | range |
|---|---|
| single line | 0.01 ≤ W/h ≤ 100 |
| single-line dispersion | f·h ≤ 60 GHz·mm, εr ≤ 20 |
| coupled pair | 0.1 ≤ W/h ≤ 10, 0.1 ≤ S/h ≤ 10, εr ≤ 18 |
| coupled dispersion | f·h ≤ 25 GHz·mm |

They also warn about gaps below 20 t and about copper thinner than 3 skin depths.

**Synthesis.**

- `synthMsline` (Z0 → W) bisects in log W, optionally at a frequency.
- `synthMscoupled` ((Ze, Zo) → (W, S)) is a damped Newton iteration in (ln W, ln S) from several starting gaps. It reports non-convergence rather than returning a poor answer.
- `fabCheck` compares the result with the substrate's fabrication limits.

Some results on JLC's 0.508 mm RO4350B:

- **50 Ω line:** 1.07 mm wide.
- **10 dB coupler** (Ze 69.4 / Zo 36.0 Ω): W 0.88 mm, S 0.10 mm, right at the 0.1 mm minimum space.
- **3 dB edge-coupled pair:** needs a 7 µm gap. The calculator flags it as below the minimum space and outside the model's range.

**Validation** (`tests/microstrip.mjs`):

- **Single lines vs scikit-rf.** Static and dispersive Z0 and εeff agree with scikit-rf's independent implementation of the same models to 1e−8 (Z0 1e−5 with dispersion), over 30 geometries on five substrates.
- **Coupled pairs vs Qucsator.** Quasi-static even/odd Z and εeff agree with Qucsator's independent implementation to 1e−9, over 82 cases with εr 2.2–16 and W/h, S/h 0.1–10 (zero thickness).
- **Published example.** An alumina example (Steer, *Microwave and RF Design II*, Example 5.6.1) agrees within the 2 % precision of its graph readings.
- **Limits and consistency:**
  - a widely spaced pair converges to the single line, statically and in dispersion;
  - finite thickness lowers both mode impedances;
  - the odd mode is lossier than the even mode;
  - synthesis round-trips to 1e−6.

**Known limitations.**

- **Coupled impedance dispersion.** Even/odd *impedance* dispersion is not included: Z_e and Z_o are quasi-static at every frequency, and only εeff disperses. The published Kirschning–Jansen impedance-dispersion equations could not be confirmed from two independent sources, and the one available implementation shows inconsistencies. At typical PCB frequencies (f·h of a few GHz·mm) the effect is around 1 %.
- **Conductor-loss models disagree for narrow lines.** The two models differ by up to about 3× near W/h = 0.1, and Hammerstad's is the higher. The Wheeler result agrees within 3 % with the Pucel–Massé–Hartwig narrow-strip formula (four substrates at W/h = 0.1), so it is the default. A field-solver check (issue #11) or a measurement should settle which is right.
- **Thickness correction for tight gaps.** For gaps below about 20 t, the coupled-line thickness correction is approximate. A field-solver check can settle this too.

---


### 4.7 Discontinuities

The line model is pure TEM, so it has no parasitics of its own (§9.3). The layout templates add the most important ones automatically, and a `via` element is available for netlists written by hand. The models live in `js/discontinuities.js`.

| discontinuity | model | where it is used |
|---|---|---|
| **Open end** | Equivalent length extension Δl of the open-circuited line (Kirschning, Jansen & Koster, *Electronics Letters* 1981; stated accuracy about 2.5 % for 0.01 ≤ W/h ≤ 100, εr ≤ 128). | Marchand main line: a `Tmain_oe … len=Δl` stub on the open end in the as-built and core netlists. |
| **Via to ground** | L = (μ0/2π)[h ln((h + √(r² + h²))/r) + 1.5(r − √(r² + h²))], r = d/2 (Goldfarb & Pucel, *IEEE MGWL* 1991). n vias in parallel give L/n, with mutual coupling neglected, which is optimistic for closely spaced vias. | `via` element; Marchand grounded ends (a stub to the via-pad centre plus `via … n=2`). |
| **Edge-connector launch** | Placeholder series L / shunt C at each port, with parameters `sma_l` and `sma_c`. | Every connector port (§8.4). |
| **T-junction** | Not yet. | Needed only by tapped comb-line and interdigital layouts (issue #15). |

**Typical values:**

| | 0.508 mm RO4350B | 1.524 mm RO4350B |
|---|---|---|
| Open end Δl (50 Ω line) | 0.22 mm (Δl/h 0.42) | 0.65 mm (Δl/h 0.43) |
| One 0.3 mm via | 83 pH | 0.50 nH |

**Effect on the Marchand demo.** On 1.524 mm RO4350B, the 2 × 0.3 mm vias at each grounded end (0.25 nH, j1.6 Ω at 1 GHz) and the 0.52 mm open-end extension move the outputs by less than 0.1 dB at f0.

**Checks.** The KJK Δl agrees with Hammerstad's older formula within 5 % for 0.5 ≤ W/h ≤ 3, and differs by up to 25 % at the extremes of W/h. The via formula is checked against its own long-via limit and against S11 = (jωL − 50)/(jωL + 50) for a via at a port (`tests/discontinuities.mjs`). Neither model has been checked here against EM simulation or measurement; issues #16 and #17 cover that.


## 5. Plots and trace expressions

A trace is an expression evaluated at every sweep point. It is complex unless it passes through a real function.

**Variables**

| Name | Meaning |
|---|---|
| `S21`, `S11`, … | S-parameters with single-digit port numbers. Sᵢⱼ is the wave out of port i for a wave into port j. |
| `S_10_3`, `S(i,j)` | Any port numbers. |
| `f` or `freq` | Frequency in Hz. |
| `j` | Imaginary unit. |
| constants and `.param` names | As in §3.3. |

**Operators:** `+ − * /`, and `^` with a real exponent.

| Function | Result |
|---|---|
| `db(x)` | 20 log₁₀\|x\| |
| `db10(x)` | 10 log₁₀\|x\| |
| `mag(x)`, `abs(x)` | \|x\| |
| `ang(x)` | phase in degrees, −180…180 |
| `angu(x)` | unwrapped phase in degrees |
| `gd(x)` | group delay −dφ/dω in seconds, by central differences |
| `re(x)`, `im(x)` | real and imaginary parts |
| `conj(x)`, `sqrt(x)` | complex conjugate, principal square root |
| `vswr(x)` | (1+\|x\|)/(1−\|x\|) |
| `cheby(n,ripple_dB,f0,fbw)` | ideal Chebyshev band-pass \|S21\| with the mapping Ω = (f/f0 − f0/f)/fbw |
| `butter(n,f0,fbw)` | ideal Butterworth \|S21\| (fbw is the 3 dB bandwidth) |

Useful combinations:

- `db(S31/S41)`: directivity of a coupler.
- `ang(S31/S21)`: quadrature of a coupler.
- `ang(-S21/S31)`: deviation of a balun's phase balance from 180°.
- `db(S21/S31)`: amplitude imbalance.
- `ang(S21/S43)`: phase difference between two networks in one netlist.

A rectangular plot shows the real part of each trace. A Smith chart plots the complex value; the small square marks the first sweep point.

---

## 6. Tuning and optimisation

**Tuning.** `.param x = 2.3p tune 1p 5p` creates a slider from 1 to 5 pF. The slider is logarithmic when LO > 0 and HI/LO > 10, linear otherwise. Dragging it re-solves immediately.

**Goals.** `.goal TRACE OP VALUE [F1 F2] [w=W]`, for example:

```
.goal db(S11) < -20 0.95G 1.05G
.goal db(S21) < -40 0.5G 0.8G w=0.5
.goal ang(S21/S43) = 90 1.3G 2.7G
```

A compact form `.goal db(S11)<-20 0.95G 1.05G` is also accepted. The trace should be real-valued; the real part is used.

**Cost.** For each sweep point inside [F1, F2], the violation v is:

| OP | v |
|---|---|
| `<` | max(0, y − VALUE) |
| `>` | max(0, VALUE − y) |
| `=` | y − VALUE |

Each goal contributes w·(mean(v²) + max(v)²). The max term pushes towards an equiripple (minimax) result.

**Optimiser.** Nelder–Mead over all `tune` parameters. Each parameter is mapped to [0, 1] within its LO..HI range, logarithmically under the same rule as the sliders, and leaving the box is penalised.

- **Frequency points:** each goal band is evaluated on at most about 121 sweep points, so a wide stopband goal cannot drown a narrow passband goal.
- **Live display:** the status line shows progress and the plots update while it runs.
- **Result:** the best values are written into the `.param` lines when it finishes or you press **Stop**.

Optimisation is local. Start from a sensible design (§7) and give realistic ranges.

---

## 7. Filter synthesis

**Synthesise…** generates a complete netlist for a tapped **comb-line** or **interdigital** band-pass filter.

![Synthesis dialog](img/ui-synth.png)

| Field | Meaning |
|---|---|
| Structure | **Comb-line:** all lines shorted at one end, with a loading capacitor at the other end and length θ0 < 90°.<br>**Interdigital:** lines shorted at alternate ends, θ0 = 90°, no capacitors. |
| Response, order n, ripple | Chebyshev or Butterworth prototype. The return loss equivalent to the ripple is shown. |
| f0, bandwidth | Centre and fractional bandwidth: ripple bandwidth for Chebyshev, 3 dB bandwidth for Butterworth. The mapping is Ω = (f/f0 − f0/f)/FBW. |
| θ0 | Comb-line resonator line length at f0. |
| Z<sub>r</sub> | Resonator line impedance **with all neighbouring lines grounded**, i.e. 1/(v·C<sub>ii</sub>). This sets the admittance level; the couplings set the ratios. |
| ε<sub>r</sub>, R0 | Dielectric (homogeneous) and port impedance. |
| Refine numerically | Corrections using the full model (below). |
| Polish | Runs the optimiser on the result. |

### 7.1 Closed form

Prototype values g₀…g<sub>n+1</sub> give

```
k(i,i+1) = FBW / √(g_i g_{i+1})        Qe = g0 g1 / FBW
```

Take each resonator's open end as a node, with all other resonator nodes grounded. Let Yₐ = 1/Z<sub>r</sub> and Yₘ be the adjacent mutual admittance (v × mutual capacitance).

| | Comb-line | Interdigital |
|---|---|---|
| Node susceptance | B<sub>ii</sub> = ωC<sub>l</sub> − Yₐ cot θ | B<sub>ii</sub> = −Yₐ cot θ |
| Coupling susceptance | B<sub>i,i+1</sub> = Yₘ cot θ | \|B<sub>i,i+1</sub>\| = Yₘ csc θ |
| Resonance | C<sub>l</sub> = Yₐ cot θ0 / ω0 | θ0 = 90° |
| Slope parameter b = (ω0/2) dB/dω | (Yₐ/2)(cot θ0 + θ0 csc² θ0) | πYₐ/4 |
| Inverter J | Yₘ cot θ0 | Yₘ |

Setting J = k·b gives each Yₘ. The normalised capacitances are then Cg = (Yₐ − ΣYₘ)·η and Cm = Yₘ·η, with η = η0/√εr.

For the tap, the resonator voltage is ∝ sin βz from the short. A load R0 tapped at θ<sub>t</sub> therefore appears at the open end as G0·(sin θ<sub>t</sub>/sin θ0)², so

```
sin θt = sin θ0 · √(b R0 / Qe)
```

### 7.2 Refinement

1. **Couplings.** For each pair, the split-mode frequencies (B<sub>ii</sub> ± B<sub>i,i+1</sub> = 0) are found by bisection. Yₘ is then scaled until (f<sub>o</sub>² − f<sub>e</sub>²)/(f<sub>o</sub>² + f<sub>e</sub>²) equals the target k. Within the model this is exact.
2. **Tap.** The first resonator is modelled with the full multiconductor sections, singly loaded, with the others grounded. Q<sub>e</sub> = ω<sub>r</sub>·τ<sub>max</sub>/4 comes from the S11 group-delay peak.
   - θ<sub>t</sub> is iterated until Q<sub>e</sub> is on target.
   - The end capacitor is Newton-corrected (ΔC = (ω<sub>r</sub> − ω0)·2b/ω0²) until the resonance is at f0.
   - Interdigital end resonators get a small trim capacitor for this, which can only lower their frequency.
3. **Centre and bandwidth.** The realised centre (geometric mean of the −3 dB points) and −3 dB bandwidth are measured. The design f0 and FBW are pre-distorted until both match the ideal prototype.

### 7.3 The generated netlist

The generated netlist contains:

- a comment header with g, k, Qe, the closed-form and refined tap positions, the pre-distorted design values, and any warnings;
- symmetric `.param`s with ±30 % tune ranges: `cg1…`, `cm12…`, `cl1` (end resonators), `cl`, and `tt` (tap angle);
- the coupled sections split at the tap planes;
- a return-loss `.goal` over the ripple band;
- two skirt goals, which hold the realised rejection at the ideal −20 dB points (+0.5 dB). These stop the optimiser from buying return loss by widening the band.

### 7.4 What to expect

These figures are from `npm test` and Example 3:

- **Refined:** centre within 0.05 % and −3 dB bandwidth within 0.5 % of the ideal. Return loss is typically 1–5 dB short of the target, because the nodal model ignores couplings such as the tap line coupling directly to resonator 2.
- **After polishing:** the target return loss is normally reached in about 100 evaluations.
- **Unreachable specifications** are reported:
  - "tap position impossible" means the tap would need sin θ<sub>t</sub> > 1: raise Z<sub>r</sub>, lower R0, or reduce the bandwidth;
  - "ground capacitance ≤ 0" means the couplings are too strong for this bandwidth (and θ0 for comb-line). Yₘ/Yₐ does not depend on Z<sub>r</sub>.

---

### 7.5 Loading capacitors

A comb-line's resonators are loaded by capacitors at their open ends. **Loading capacitors** in the synthesis dialog chooses how they are built. The comb sections stay as synthesised, with their εr; the **capacitor substrate** sets only the pads and ground vias.

| option | model (`cap … type=`) | the synthesiser |
|---|---|---|
| ideal | `C` | as before: `cl1`, `cl` tunable |
| SMD 0402 / 0603 / 0805 | hot pad shunt C → ESL → C (Q) → cold pad → ground vias | Finds the nominal value whose **effective** capacitance at f0 equals the ideal one, snaps it to E24 or E12, re-tunes the common line length (and tap) to absorb the snapping, and reports each resonator's residual detuning. `th0` becomes tunable for polishing. |
| trimmer (Murata TZC3) | pad C → ESL → C (Q) → ground vias | Picks the narrowest TZC3 that covers each value with ±10 % adjustment. The `cl1`/`cl` sliders span the trimmer's range, so they are the trimmer screws. |
| printed pad | square pad to the bottom ground: an open microstrip stub, side a + open-end Δl | Sizes each pad for its value at f0 and warns when the substrate cannot reach it |

**The models** (`js/capacitors.js`):

- **Pad capacitance.** A short microstrip section with Kirschning–Jansen–Koster end fringing (§4.6, §4.7).
- **Vias.** Goldfarb–Pucel (§4.7).
- **SMD effective capacitance.** C<sub>eff</sub> = C<sub>pad</sub> + C/(1 − ω²(ESL + L<sub>via</sub>)C), which also gives the self-resonance.
- **Printed pad.** Its input capacitance tan(β(a + Δl))/(ωZ0), valid while a ≤ λg/8 and W/h ≤ 100. Pads are also capped at a practical 25 mm side.

**Sources and assumptions:**

- **SMD land patterns:** KiCad's `C_0402_1005Metric`, `C_0603_1608Metric` and `C_0805_2012Metric`.
- **SMD ESL** (0.4 / 0.6 / 0.8 nH) and **Q** (300) are typical values, not from a particular part. Set `esl=` and `Q=` from your capacitor's datasheet.
- **Trimmer ranges:** from Murata's TZC3 datasheet, 1.4–3, 2–6, 3–10, 5–20 and 6.5–30 pF. Murata specifies Q only at 1 MHz and draws frequency curves to 2 GHz (Z types) or 1 GHz (R/P types). The trimmer's RF Q (100) and ESL (1 nH) are assumptions.
- **Gap and interdigital printed capacitors** are not included yet.

**Measured on a 5-pole, 6 % comb-line at 1 GHz** (θ0 40°, Zr 70 Ω, lossless lines), against the ideal design, which is centred at 1.0006 GHz with a 7.08 % −3 dB bandwidth:

| option | capacitors | centre | −3 dB BW (below the peak) | peak S21 | note |
|---|---|---|---|---|---|
| SMD 0603, E24, 0.508 mm RO4350B | 2.4 pF × 5 | −0.21 % | 6.43 % | −1.37 dB | length 39.92° → 40.18°; residual detuning ±0.3 % per resonator |
| SMD 0402, E12 | 2.7 pF × 5 | −0.18 % | 6.73 % | −1.38 dB | length 39.92° → 38.00° |
| printed, 0.508 mm RO4350B | 5.9 mm square pads | −0.03 % | 6.66 % | −1.54 dB | pad conductor and dielectric loss |
| trimmer, 1.524 mm RO4350B | TZC3Z030 (1.4–3 pF) | −0.06 % (0.00 % lossless) | 5.64 % | −4.21 dB | with the assumed Q 100 |

The SMD loss is set by the assumed Q of 300. The narrower bandwidth comes from the ESL, which makes the effective capacitance rise with frequency and steepens each resonator's slope. **Polish** recovers the bandwidth by retuning `cg`/`cm`/`tt` and the now-tunable `th0`.

The designer warns, in the netlist comments and the status line, when an option cannot reach the value:

- a printed pad that would need to be too large;
- no trimmer that covers the value;
- an SMD pad that alone is more than the value;
- E-series detuning above FBW/10;
- self-resonance below 3 f0;
- more than 1 dB of loss from capacitor Q.

**Footprints.** `capFootprint()` in `js/kicad.js` gives each option's KiCad footprint: pad 1 on the resonator end, pad 2 and its via land to ground. The comb-line layouts of issue #15 place them. `node tools/kicad.mjs --caps SUBSTRATE --out DIR` writes them as a library, and CI checks that library in KiCad.

## 8. Export and sharing

**Touchstone.** Exports the full S-matrix at all sweep points, with frequency in Hz, as RI (real/imaginary), MA (magnitude/angle°) or DB (dB/angle°).

| Port reference impedances | Format |
|---|---|
| All equal | Touchstone 1.1 (`# Hz S RI R 50`) |
| Different | Touchstone 2.0 with a `[Reference]` line (2-ports declare `[Two-Port Data Order] 21_12`) |

**Link.** Encodes the netlist in the URL fragment (`#n=…`). Nothing is uploaded.

**Example links.** `index.html?example=NAME.cir` opens a file from `examples/`; the worked-example pages use this for their "open in designer" links.

When a netlist arrives from a link of either kind and you already had a different one in the editor, your previous netlist is kept and a **Restore it** button appears above the status line. The query string is removed after loading, so reloading the page keeps your edits.

**Save .cir / Open….** Plain text netlists.

### 8.1 Layout

A `.layout` statement turns sections given by physical dimensions (§4.6) into a board layout. The designer shows it in the **layout panel** above the plots. [Worked example 8](examples/08-coupler-to-board.md) goes from an impedance-defined coupler to a KiCad board using only the panel.

**The layout panel.** The netlist text stays the source of truth: every control rewrites a line of it and re-runs.

- **No `.layout` yet.** If the topology fits a template, the panel offers one, for example "this netlist fits **coupler** (K)". Choose a substrate and press **Make PCB layout**. That sets `.substrate`, converts the sections given by impedance to microstrip and adds the `.layout` line.
  - **Coupled pairs:** for symmetric pairs in any input form (`Zeo`, `Y0`, `Cn`, `Cg/Cm`, `C/L`), Z0e and Z0o are taken from the Maxwell matrices and synthesised to W/S.
  - **Single lines:** these get W for their Z0.
  - **Not converted:** sections with three or more lines, which need the field solver (#11/#12).
  - Your previous netlist is kept for **Restore it**.
- **Substrate.** Rewrites `.substrate` and re-synthesises every section's W/S, so the impedances stay those the sections had on the previous substrate. Any overrides on the old `.substrate` line are dropped.
- **Template, Connector, Launch, Pitch, Feed, Margin.** These rewrite the `.layout` line. A blank number uses the default, shown greyed; defaults are not written.
- **Physical view.** Adds a dashed twin of every plotted trace, computed from the as-built netlist: feeds, tapers, connector pads, launch placeholders, vias and open ends. It is remembered in this browser.
- **Buttons.**
  - **As-built netlist:** opens the as-built netlist for editing or optimisation.
  - **SVG:** the preview.
  - **KiCad library:** the part alone (§8.2).
  - **KiCad project:** the whole board (§8.3).

Hovering a copper shape in the preview shows its net and width.

![Layout preview](img/ui-layout.png)

```
.layout coupler K                         # 4-port coupled-line coupler
.layout schiffman CS TREF                 # C-section (far ends joined) + reference line
.layout marchand S1 S2                    # two coupled sections, grounded secondaries
```

| option | default | meaning |
|---|---|---|
| `connector` | `amphenol-132289` | edge-launch connector at every port (§8.4); `none` for bare feeds to the edge |
| `launch` | `matched` | `matched`: the connector's signal pad is the feed width; `library`: KiCad's 1.5 mm pad plus a taper (§8.4) |
| `pitch` | 12 mm (10 mm without a connector) | spacing between neighbouring ports on the same edge; the default clears the connector's courtyard (11.16 mm) |
| `feed` | connector pad + launch taper + 1 mm, rounded up to 0.5 mm (5 mm without a connector) | length of the straight port-impedance feed at each port |
| `margin` | 6 mm (4 mm without a connector) | board margin beyond the copper; the default keeps the connector's ground pads on the board |
| `gap` (marchand) | 0.5 mm or the fab minimum | separation between the two sections' secondary lines, where the outputs come out |
| `drill` (marchand) | 0.3 mm or the fab minimum | grounding-via drill; the pad is 0.3 mm larger |
| `vias` (marchand) | 2 | grounding vias at each grounded end |

**What the templates do:**

- **Coordinates.** Everything is in millimetres, with the y axis pointing down as in KiCad.
- **Port feeds.** Each port gets a feed of its reference impedance (50 Ω → the microstrip width on the substrate). The feed runs to the board edge, where an edge-launch SMA connector attaches.
- **Leaving a coupled line.** A feed first runs diagonally (45°) at the coupled-line width. As soon as it is clear of its neighbour by the coupling gap, a linear taper of length max(w<sub>f</sub>, 3|w<sub>f</sub> − W|) widens it to the feed width w<sub>f</sub>. The taper replaces an abrupt width step and belongs to the part (§8.2). The as-built netlist models it as three stepped sections.
- **Connectors.** An edge-launch SMA at every port (§8.4).
- **Ground.** The back of the board is a full ground pour.
- **Schiffman reference line.** It is lengthened by the length of the C-section's feeds, so the designed phase difference between the two networks is kept.
- **Marchand.** The secondary lines get via pads at their grounded ends. The two sections are separated by `gap` so that both outputs can leave from between them, which adds a short uncoupled piece of main line.

**Checks.** The layout is checked against the substrate's fabrication limits:

- copper-to-copper spacing between different nets (and shorts), and gaps below the minimum space within one net;
- overlapping connector courtyards;
- trace width and via drill;
- copper too close to the board edge or outside it.

Results appear under the preview.

**As-built netlist.** The **As-built netlist** button opens the netlist of what is laid out: the original sections plus every taper, feed line and connector pad section. Simulate it to see what the feeds do to the response; your previous netlist is kept for **Restore it**.

For the 10 dB coupler at 5 GHz the as-built coupling is −10.25 dB, against −10.07 dB for the bare section, and the match stays below −34 dB. The as-built netlist does not model:

- bends;
- coupling between the diverging feed sections;
- the Schiffman bridge;
- T-junctions (not used by these templates).

It does model the discontinuities of §4.7: grounding vias (Marchand), the open end of the Marchand main line, and a tunable placeholder for each connector launch.

**SVG** downloads the preview. From the command line:

```sh
node tools/layout.mjs examples/coupler-10dB-ro4350b.cir --svg coupler.svg --netlist asbuilt.cir
```

### 8.2 KiCad component library

**KiCad library** (on the layout card) downloads the core of the layout as a self-contained KiCad 9 library, a footprint plus a matching schematic symbol, so the part can be reused in any design. The board around it, with its connectors, is §8.3.

The zip holds one folder:

| file | contents |
|---|---|
| `LIB.pretty/PART.kicad_mod` | footprint (board file version 20241229, as written by KiCad 9.0) |
| `LIB.kicad_sym` | symbol, one pin per port (plus GND for the Marchand); its Footprint field is `LIB:PART` |
| `fp-lib-table`, `sym-lib-table` | project library tables using `${KIPRJMOD}`: put them next to your `.kicad_pro`, or add the library under Preferences → Manage Libraries |
| `PART.cir` | the **core netlist**: the part alone, with its ports at the reference planes |
| `README.txt` | the pin list, substrate and notes |

The part name carries the template, f0 and substrate, e.g. `COUPLER_5G00_jlc-ro4350b-0.508`, because the copper is only right on that stack-up. The library name is the same as the part name.

**What is in the footprint:**

- **Reference planes.** The part ends where the feeds change to the port-impedance width: the split points of §8.1 on coupled lines, and the ends of the reference line's matched feeds (Schiffman). They are drawn dashed on F.Fab. Attach each feed at its pad end.
- **Pads.** Every conductor is a custom-shape SMD pad on F.Cu, so the copper has a net and DRC treats it as such. A conductor that carries two ports, like a coupler's through line, is cut at mid-length into two abutting pads.
- **Net ties.** Those pad pairs are declared in `net_tie_pad_groups`, so KiCad accepts the DC path between two different nets. A side effect: KiCad then skips clearance checks between all pads of the footprint (§8.3, Validation). The part's internal gaps are checked by comb-over's DRC, which refuses to export when they fail. On the Marchand the two outputs and GND form one group, since both secondaries are grounded.
- **Grounding vias** (Marchand) are thru-hole pads on the GND pad number, with solid zone connection.
- **Keepout.** A rule area named "RF keepout" forbids copper pour on F.Cu within max(3h, 1 mm) of the copper. Tracks, vias and pads are still allowed in it, so feeds can enter.
- **Solder mask** is opened over the conductors, which matches the model (no mask dielectric). The paste layer is not used.
- **Properties:** the substrate (h, εr, tanδ, copper thickness) and a hash of the source netlist.

**Core netlist.** `PART.cir` is the as-built netlist without the board feeds, so it can be dropped into another simulation. For the 10 dB coupler at 5 GHz: bare section −10.07 dB, core −10.14 dB, as built with feeds and connector pads −10.25 dB.

The **Schiffman** reference line in the part is the designed length plus the C-section's in-part escape lengths, and its two board feeds are as long as the C-section's feeds. The phase difference is therefore set by the part alone.

From the command line:

```sh
node tools/kicad.mjs examples/coupler-10dB-ro4350b.cir --out lib/ [--zip] [--mask covered] [--keepout 2] [--name PART]
```

`--board` writes the whole KiCad project instead (§8.3).

### 8.3 KiCad board

**KiCad project** (on the layout card) downloads a complete KiCad 9 project for the layout: open the `.kicad_pro`, press **B** to fill the zones, and the board is ready for review and Gerber export.

| file | contents |
|---|---|
| `NAME.kicad_pro`, `NAME.kicad_pcb` | the project and board (file version 20241229) |
| `NAME-asbuilt.cir` | the as-built netlist of the whole board (§8.1) |
| `NAME.pretty`, `NAME.kicad_sym`, lib tables, `NAME.cir` | the component library of §8.2, which also holds the connector footprints |
| `NAME.kicad_dru` | a custom design rule that lets the connector pads meet the board edge |

**What is on the board:**

- **The part** from §8.2, placed with its nets: one net per port node, plus GND.
- **Ports.** `J1`…`Jn` are edge-launch SMA footprints (§8.4) on the board edge. With `connector=none` they are placeholder pads (`PORT_…`) the width of the feed.
- **Feeds.** Port-impedance tracks along the layout's feed paths, from each port pad to the part's reference planes.
- **Ground.**
  - A full GND pour on B.Cu.
  - A GND pour on F.Cu, kept the part's keepout distance (max(3h, 1 mm)) clear of all RF copper.
  - Stitching vias on a grid of pitch min(λ<sub>eff</sub>/10, 5 mm), at least 1.5 mm, where both pours exist.
  - Fence vias along both sides of each feed at half that pitch.
- **Stack-up.** Taken from the substrate: core thickness, εr, tanδ, copper thickness and ENIG finish. KiCad's stack-up manager and impedance calculator therefore see the same board as comb-over.
- **Design rules.** The board and project carry the fab's minimum space and trace width as the default net class clearance and track width.
- **Notes.** The title block and a note on User.Comments record the substrate, f0, the part name and the netlist hash, and warn the fab not to substitute material or thickness.

The F.Cu pour can be switched off from the command line (`--no-top-pour`). On thick substrates the 3h clearance leaves little room for it anyway. The 1.524 mm Marchand and Schiffman demos get only a few vias, while the 0.508 mm coupler gets a full fence.

**Validation.** Every pull request generates KiCad projects and checks them with KiCad's own tools in the official `kicad/kicad` containers (`tools/kicad-check.sh`). The projects are the three demos, worked example 8 (converted to microstrip as the layout panel does it) and a deliberately broken board. The checks are:

- the footprint and symbol libraries parse;
- every footprint re-saves identically with KiCad's writer;
- the board loads and its zones fill;
- DRC;
- Gerber and drill export.

DRC is judged against `tools/kicad-expected.json`: any violation type not listed for a design fails the build, warnings included. Allowed today: "isolated copper" on the 1.524 mm Marchand and the example 8 board, where the 3h keepout leaves only small top-pour islands.

Two deliberate faults check that faults are caught:

- **A 0.06 mm coupled gap**, below JLC's 0.1 mm. comb-over's own DRC must refuse the export. KiCad cannot catch this one: declaring net ties turns off KiCad's clearance checks between *all* pads of that footprint, not only those tied together. This was verified on 9.0.8 and 10.0.7: without the declaration the same board shows four clearance violations. So the gaps inside a part are checked by comb-over, and everything around the part (connectors, feeds, vias, pours) by both.
- **Connectors on an 8 mm pitch**, so their 11.16 mm courtyards overlap. The board is exported with `--force`, and KiCad's DRC must report `courtyards_overlap`.

**KiCad 9.0.8** is the target and gates merges. **KiCad 10.0.7** runs the same checks but only reports, so format changes show up early. Under KiCad 10 the footprint re-save comparison is informational, because KiCad 10 converts files to its own format on save.

The Marchand board has two "isolated copper" warnings. On 1.524 mm material the 3h keepout around the part, a rectangle, leaves only small top-pour islands, each touching a single connector ground pad. A keepout that follows the conductors instead of their bounding box would fix this.

```sh
node tools/kicad.mjs examples/coupler-10dB-ro4350b.cir --out board/ --board [--zip] [--no-top-pour] [--via-pitch MM]
```

### 8.4 Edge-launch connectors

Every port gets an edge-launch SMA. The default, and so far the only one, is the **Amphenol RF 132289**, a 50 Ω jack rated 0–18 GHz for **0.062" (1.57 mm) boards** ([listing](https://ciiva.com/part/132289-579270)). Its pads come from KiCad's library footprint `Connector_Coaxial:SMA_Amphenol_132289_EdgeMount` (CC-BY-SA 4.0 with the KiCad library exception):

- a 5.08 mm signal pad;
- 5.08 × 1.5 mm ground pads at ±4.25 mm, on both copper layers;
- an 11.16 mm courtyard, which sets the default 12 mm port pitch.

The generated footprint (`SMA_Amphenol_132289_EdgeMount_W<feed width>`) has its origin on the board edge. It adds three thru-hole ground vias in each ground pad to tie the top and bottom ground together at the launch. The pads carry paste, so expect solder to wick into those vias. A `.kicad_dru` rule (severity ignore) lets the connector's pads meet the board edge.

**Launch.** The signal pad is a 5 mm length of line, so its width matters:

| `launch=` | signal pad | when |
|---|---|---|
| `matched` (default) | the feed width w<sub>f</sub> | the pad is simply part of the 50 Ω line |
| `library` | KiCad's 1.5 mm, then a taper of max(1 mm, 2\|Δw\|) to w<sub>f</sub> | to keep the stock land pattern |

On 0.508 mm RO4350B the stock 1.5 mm pad is a 41 Ω, 5 mm section, about 50° at 5 GHz, at every port. It moves the 10 dB coupler's coupling from −10.07 dB to −11.29 dB. With `launch=matched` it stays at −10.25 dB.

The as-built netlist models the pad and any taper as line sections. The transition into the connector is a placeholder (§4.7): a series L (`sma_l`) and shunt C (`sma_c`) at every port. They are effectively zero by default, with tune ranges of 1 pH–2 nH and 1 fF–1 pF, so they can be fitted to EM or measured data.

**Board thickness.** The connector's ground legs straddle the board. The layout card warns when the board (core + 2 × copper) is more than ±0.15 mm from the connector's 1.57 mm, which is the case for the 0.508 mm coupler demo. Either choose a variant of the connector made for the actual thickness, or use a 1.57 mm stack-up. The 1.524 mm RO4350B demos (1.594 mm with copper) fit.

---

## 9. The model, its assumptions and limits

### 9.1 Section admittance matrix

For per-unit-length Maxwell C and inductance L:

| Step | Definition |
|---|---|
| Symmetrised modal problem | M = C<sup>½</sup> L C<sup>½</sup> = P Λ Pᵀ |
| Modal velocities | vᵢ = 1/√λᵢ |
| Voltage eigenvectors | Tv = C<sup>−½</sup> P |
| Weight matrix | W = C<sup>½</sup> P |

With terminals ordered A₁…A<sub>N</sub>, B₁…B<sub>N</sub> and currents flowing into the section:

```
Y11 = Y22 =  W · diag(vᵢ coth γᵢℓ) · Wᵀ
Y12 = Y21 = −W · diag(vᵢ csch γᵢℓ) · Wᵀ          γᵢ = βᵢ (1/(2Q) + j)
```

In a homogeneous medium this reduces to Y11 = vC coth γℓ.

### 9.2 Network solution

All sections and lumped elements are stamped into one nodal admittance matrix Y (n×n, ground eliminated). Each port node is then terminated in its reference conductance G, and

```
(Y + G_ports) X = E_ports,        S = 2 √G · X_pp · √G − I
```

This is valid for real reference impedances.

The terminated form stays well conditioned where a Kron reduction onto the ports would not. An example is a resonance of the network with its ports shorted: the Marchand balun has one at f0/2.

At exact half-wave frequencies a lossless line's admittance is singular. Such points are evaluated 1 ppb away from the requested frequency, which gives the limiting value. Points that still fail are shown as gaps and counted in the status line.

### 9.3 Not modelled

- Dispersion; the quasi-TEM ε<sub>eff</sub> is constant.
- Higher-order modes and radiation.
- Open-end fringing, via inductance and connector launches, except where you add them: the `via` element, the layout templates (§4.7), or explicit lumped elements and short line sections. Tap and junction discontinuities and bond wires are not modelled.
- Frequency-dependent conductor loss, apart from the constant-Q approximation.
- Mutual coupling between sections that do not share a `cline` block.

### 9.4 Verification

- **`tests/run.mjs`:**
  - closed-form quarter-wave transformer and 3 dB coupler;
  - the even/odd closed form for an inhomogeneous pair;
  - reciprocity and SᴴS = I for a general 3-line section;
  - agreement between all homogeneous parameterisations;
  - section cascading;
  - the Q loss law;
  - a Marchand regression at its f0/2 internal resonance.
- **`tests/synth.mjs`:**
  - Matthaei g-value tables;
  - the engine against the analytic pair split;
  - realised centre, bandwidth and return loss of synthesised designs, before and after polishing.

---

## 10. Command-line tools

| Command | Purpose |
|---|---|
| `node tools/summary.mjs FILE.cir 11 21 …` | Text table of dB/angle for the given S-parameters, plus section lengths and ε<sub>eff</sub>. |
| `node tools/opt.mjs FILE.cir [iters] [rounds]` | Runs the optimiser headless and writes tuned values back into the file. |
| `tools/measure.mjs` | Helper module (`load`, `at`, `band`, `extreme`) used to compute the numbers quoted in the worked examples. |
| `node tools/mscalc.mjs --sub ID (--z0 Z \| --ze Ze --zo Zo \| --w W [--s S]) [--f F]` | Microstrip calculator: width for Z0, W/S for even/odd impedances, or analysis of a geometry, including losses (§4.6). `--list` shows the substrate presets. |
| `node tools/layout.mjs FILE.cir [--svg F] [--netlist F] [--json F]` | Builds the `.layout` of a netlist, reports the board size and design-rule results, and writes the SVG preview, the as-built netlist or the layout data (§8.1). Exits with code 2 if the layout breaks a design rule. |
| `node tools/kicad.mjs FILE.cir --out DIR [--board] [--zip] [--mask covered] [--keepout MM] [--name PART] [--no-top-pour] [--via-pitch MM]` | Writes the `.layout` core as a self-contained KiCad 9 library (§8.2), or with `--board` the whole KiCad project (§8.3). |
| `npm run docs` | Rebuilds these HTML documentation pages from the Markdown in `docs/` (`npm test` fails if they are out of date). |
| `python3 tools/docfigs.py` | Regenerates the figures in `docs/img` (needs Playwright with Chromium and a local server on port 8765). |

The engine modules have no DOM dependencies and can be imported directly:

```js
import { parseNetlist } from './js/netlist.js';
import { solve } from './js/solver.js';
import { design } from './js/synth.js';
const r = solve(parseNetlist(text));      // r.S(2,1) → {re, im} arrays over r.freq
```

---

## 11. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `line N: unexpected …` | An expression contains a space. Remove it, or wrap it in brackets. |
| A filter appears at a silly frequency or with a silly length | A unit problem: `len 25` is 25 m, and `1m` is 1 milli. Check the Line sections panel for the physical length. |
| `capacitance matrix is not positive definite` | The mutual capacitances are larger than the self capacitances. Check the signs: Maxwell off-diagonals are negative; `Cg`/`Cm` are all positive. |
| `two ports share a node` | Put a `wire` between two nodes and a port on each, or use one port. |
| Gaps in a plot, status says "singular" | An exactly singular lossless point that survived the retry. Shift the sweep slightly or add a little loss (`Q`). |
| Optimiser stalls with nonzero cost | The goals conflict, or the range bounds are active (a slider pinned at an end). Widen the ranges, re-weight the goals, or run it again from the new point. |
| Synthesised filter return loss a few dB short | Expected (§7.4). Tick **Polish**, or press **Optimise**. |
