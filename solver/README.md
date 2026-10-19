# mtl2d: a 2-D field solver for coupled strips

This solver gives the quasi-static per-unit-length **C** (with the dielectric), **C0** (in air) and **L = μ0ε0·C0⁻¹** matrices of N strips lying side by side in one plane of a layered dielectric. The strips are zero-thickness sheets or rectangles of thickness t. It is three dependency-free ES modules (`mtl2d.js`, `thick.js` for thick strips, `numeric.js`) that run in the browser and in Node. It lives in the comb-over repository for now (issue #11), with no imports from the rest of comb-over, so it can be split out into its own repository later with `git subtree split`.

## Structures

| Helper | Stack |
|---|---|
| `microstrip({h, er, top=1})` | substrate on ground, air above (or a half-space of εr `top`) |
| `coveredMicrostrip({h, er, hc})` | substrate, then an air gap `hc` to a ground cover |
| `stripline({b, er, hb=b/2})` | ground planes `b` apart, strips at `hb` (offset stripline when hb ≠ b/2) |

A thick strip `{x, w, t}` stands on the strip plane and grows into the first layer above it (or the top half-space), so for a centred thick stripline use `hb = (b − t)/2`.

Any other stack can be written directly: `{ below: [{t, er}, …], above: [{t, er}, …], cover, top }`. List the layers starting from the strip plane. `below` ends on the ground plane. `above` ends on a ground cover when `cover` is true; otherwise it ends in a half-space of permittivity `top`. Suspended stripline, overlays and multilayer substrates are all written this way.

## Use

```js
import { solve, microstrip, stripsFromWS, netlistSnippet } from './solver/mtl2d.js';
const r = solve(stripsFromWS([1e-3, 1e-3, 1e-3], 0.2e-3, 35e-6), microstrip({ h: 0.508e-3, er: 3.66 }));   // t = 35 µm
r.C, r.C0, r.L      // SI, N×N
r.epsEff            // modal εeff, ascending
netlistSnippet(r)   // "C [...]  L [...]" body lines for a comb-over cline
```

```
node solver/cli.mjs --W 1,1,1 --S 0.2 --h 0.508 --er 3.66 --t 0.035   # mm; --json for JSON
node solver/cli.mjs --W 0.4,0.4 --S 0.2 --stripline 1 --er 3
```

`evenOdd(r)` gives Z0e, Z0o, εe and εo for a symmetric pair, and `single(r)` gives Z0 and εeff for one strip.

## Method

The solver uses a Galerkin method of moments for the strip charge, with a Chebyshev basis that includes the edge singularity on each strip, f_k = T_k(u)/√(1−u²). The stack's Green's function is exact in the spectral domain: G̃(β) = 1/(Y_up + Y_down), with transmission-line recursion through the layers.

The Green's function is split into two parts:

- **Logarithmic part** (the asymptotic interface term and one image), G∞(x) = [ln|x+2jd| − ln|x|]/(π(ε_a+ε_b)). Its Galerkin integrals are done with the Chebyshev expansion of the logarithm: the inner integral is exact, and the outer one uses Gauss–Chebyshev quadrature sized to the gap. The self term is in closed form.
- **Spectral remainder.** It decays as e^{−2βd} and is finite at β = 0. It is integrated by composite Gauss–Legendre quadrature.

The default number of basis functions grows with width/gap and with width/height. It gives about 1e-6 relative accuracy in C. A few strips solve in milliseconds, and 10 lines take about 50 ms.

### Thick strips (`thick.js`)

Each strip becomes four faces: bottom, top and two walls. Each face carries the same edge-singular Chebyshev basis. In the layer that holds the strips (permittivity ε_h, thickness d), the exact spectral Green's function is

G̃ = e^{−β|z−z'|}/(2ε_hβ) + (s/D)[Γd E1E1' + ΓdΓu e²(E1E2' + E2E1') + Γu e² E2E2'],

with s = 1/(2ε_hβ), E1 = e^{−βz}, E2 = e^{βz}, e = e^{−βd}, D = 1 − ΓdΓu e², and Γd, Γu the reflection coefficients of the stacks below and above that layer. It is split into two parts:

- **Log terms**, done in space: the free-space term, single images across z = 0 and z = d with the high-β reflection coefficients, and a ground-like image across z = −t_b that brings the total log charge to zero.
- **A separable remainder**, finite at β = 0 and decaying as e^{−2β·min(t_b, d−t)}. Its Galerkin integrals need only 1-D transforms per basis: J_k for a face, e^{∓βz}·I_l for a wall.

The log integrals use the same exact inner integral (now for any relative position and orientation), with composite Gauss–Legendre quadrature in θ outside, its panels sized to the distance between the faces. A corner where two faces touch gives an integrand that is analytic in θ.

The charge at a right-angled corner goes as r^(−1/3), not r^(−1/2), so convergence in the order is algebraic, about 1/K². The defaults (16 basis functions per face, or more for tight gaps, and 6 per wall) give about 5e-5. A thick pair takes about 50 ms; 10 thick lines take about 0.5 s.

## Validation (`tests/solver.mjs`)

- **Stripline:** exact conformal-mapping results (Cohn 1954 and 1955). The single-line Z0 agrees to 1e-6 at the default order and to 1e-11 at order 24; the coupled-line Z0e and Z0o agree to 1e-6.
- **Microstrip in air:** Z0 agrees with Hammerstad–Jensen to within 0.01 %, their stated accuracy. εeff agrees to within 0.2 %, again their stated accuracy.
- **Coupled microstrip:** within 1 % of Kirschning–Jansen.
- **Three unequal lines:** every entry of C agrees to 1e-5 with an independent method: pulse basis with point matching, using the spatial image series of the grounded slab, refined with Richardson extrapolation.
- **Thick strips:**
  - **Microstrip vs an independent BEM.** A thick pair (35 µm; C and C0) and three unequal thick lines (50 µm, 0.12 mm gap; C) agree to 1e-4 of the diagonal with an independent BEM: pulse basis on the rectangle perimeters, graded panels, collocation and the spatial image series, refined with Richardson extrapolation.
  - **Wide thick stripline vs Cohn's exact fringing result** (t/b 0.02–0.2): 5e-5.
  - **Thin limit:** t = 1 nm reproduces the zero-thickness solver to 2e-5 for microstrip, offset stripline, covered microstrip and an overlay on a two-layer substrate.
  - **Single thick microstrip vs Hammerstad–Jensen:** Z0 to 0.15 %, and the thickness-induced change to 0.1 % of Z0.
- **Convergence:** in basis order and in quadrature. Symmetry, mirroring and translation invariance; Maxwell-matrix sign structure; LC = μ0ε0εr·I in a homogeneous medium.

## Not yet

Etch profile (trapezoidal strips), solder mask over the strips, strips on more than one plane (broadside coupling), and dielectric loss (a G matrix).
