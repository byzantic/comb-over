# comb-over

Browser-based analysis of N-port networks built from **coupled multiconductor TEM / quasi-TEM line sections**: comb-line and interdigital filters, couplers (including Lange), Marchand baluns, Schiffman sections, and anything else you can wire from coupled lines, single lines, and lumped R/L/C.

No build step and no dependencies: plain ES modules plus canvas.

## Run it

Serve the folder (ES modules don't load from `file://`):

```sh
python3 -m http.server 8000      # then open http://localhost:8000
```

or enable **GitHub Pages** (Settings → Pages → Deploy from branch → `main` / root).

Tests (Node ≥ 18):

```sh
npm test
```

## What it does

- Write a netlist in the editor (press **Syntax** for the full reference). It re-solves as you type.
- **Plots:** rectangular and Smith plots of arbitrary trace expressions, e.g. `db(S31/S41)` for directivity or `ang(S21/S43)` for a phase difference. Hover to read values at a frequency.
- **Tuning:** `.param x = … tune lo hi` gives you a slider for `x`.
- **Optimiser:** `.goal` statements drive a Nelder–Mead optimiser over the tuned parameters. When it finishes, the results are written back into the netlist.
- **Section info:** the modal velocities (ε_eff), modal impedances and voltage eigenvectors are shown for each section.
- **Touchstone export:** `.sNp` in RI, MA or dB format. Mixed port impedances are written as Touchstone 2.0 with `[Reference]`.
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

## Model

For each section with per-unit-length Maxwell capacitance **C** and inductance **L**:

- **Modes:** M = C^½ L C^½ = P Λ Pᵀ, and W = C^½ P. The modal velocities are vᵢ = 1/√λᵢ.
- **Admittance matrix:** with terminals ordered A₁…A_N, B₁…B_N,
  - Y₁₁ = Y₂₂ = W diag(vᵢ coth γᵢℓ) Wᵀ
  - Y₁₂ = Y₂₁ = −W diag(vᵢ csch γᵢℓ) Wᵀ
- **Homogeneous case:** this reduces to Y₁₁ = vC coth γℓ.
- **Assembly:** sections and lumped elements are stamped into a nodal admittance matrix. Internal nodes are removed by Kron reduction, and S = (I + y)⁻¹(I − y) with y = √R Y √R.
- **Loss (optional):** a constant unloaded Q per section, with αᵢ = βᵢ/2Q. Characteristic admittances stay real, so this is a low-loss approximation.
- **Singular points:** exact half-wave frequencies of lossless lines are evaluated 1 ppb away, which gives the limiting value.

**Not modelled:** dispersion, end/open-end effects, junction and bond-wire parasitics, and frequency-dependent conductor loss. Add these as lumped elements or extra line sections where they matter.

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

- `node tools/opt.mjs file.cir [iters] [rounds]`: run the optimiser headless and write the tuned values back to the file.
- `node tools/summary.mjs file.cir 11 21`: print a text table of the response.

## Roadmap

- Synthesis front end:
  - prototype → coupling matrix → comb-line / interdigital C/ε (Cristal / Matthaei);
  - dimensional extraction via coupling coefficients and external Q.
- Geometry → C/L via a 2-D field solver (stripline / coax-bar first, then microstrip).
- Varactor tuning sweeps, Monte-Carlo tolerances.
