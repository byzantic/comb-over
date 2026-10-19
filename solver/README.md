# mtl2d: a 2-D field solver for coupled strips

This solver gives the quasi-static per-unit-length **C** (with the dielectric), **C0** (in air) and **L = μ0ε0·C0⁻¹** matrices of N zero-thickness strips lying side by side in one plane of a layered dielectric. It is one dependency-free ES module (`mtl2d.js`) that runs in the browser and in Node. It lives in the comb-over repository for now (issue #11), with no imports from the rest of comb-over, so it can be split out into its own repository later with `git subtree split`.

## Structures

| Helper | Stack |
|---|---|
| `microstrip({h, er, top=1})` | substrate on ground, air above (or a half-space of εr `top`) |
| `coveredMicrostrip({h, er, hc})` | substrate, then an air gap `hc` to a ground cover |
| `stripline({b, er, hb=b/2})` | ground planes `b` apart, strips at `hb` (offset stripline when hb ≠ b/2) |

Any other stack can be written directly: `{ below: [{t, er}, …], above: [{t, er}, …], cover, top }`. List the layers starting from the strip plane. `below` ends on the ground plane. `above` ends on a ground cover when `cover` is true; otherwise it ends in a half-space of permittivity `top`. Suspended stripline, overlays and multilayer substrates are all written this way.

## Use

```js
import { solve, microstrip, stripsFromWS, netlistSnippet } from './solver/mtl2d.js';
const r = solve(stripsFromWS([1e-3, 1e-3, 1e-3], 0.2e-3), microstrip({ h: 0.508e-3, er: 3.66 }));
r.C, r.C0, r.L      // SI, N×N
r.epsEff            // modal εeff, ascending
netlistSnippet(r)   // "C [...]  L [...]" body lines for a comb-over cline
```

```
node solver/cli.mjs --W 1,1,1 --S 0.2 --h 0.508 --er 3.66        # mm; --json for JSON
node solver/cli.mjs --W 0.4,0.4 --S 0.2 --stripline 1 --er 3
```

`evenOdd(r)` gives Z0e, Z0o, εe and εo for a symmetric pair, and `single(r)` gives Z0 and εeff for one strip.

## Method

The solver uses a Galerkin method of moments for the strip charge, with a Chebyshev basis that includes the edge singularity on each strip, f_k = T_k(u)/√(1−u²). The stack's Green's function is exact in the spectral domain: G̃(β) = 1/(Y_up + Y_down), with transmission-line recursion through the layers.

The Green's function is split into two parts:

- **Logarithmic part** (the asymptotic interface term and one image), G∞(x) = [ln|x+2jd| − ln|x|]/(π(ε_a+ε_b)). Its Galerkin integrals are done with the Chebyshev expansion of the logarithm: the inner integral is exact, and the outer one uses Gauss–Chebyshev quadrature sized to the gap. The self term is in closed form.
- **Spectral remainder.** It decays as e^{−2βd} and is finite at β = 0. It is integrated by composite Gauss–Legendre quadrature.

The default number of basis functions grows with width/gap and with width/height. It gives about 1e-6 relative accuracy in C. A few strips solve in milliseconds, and 10 lines take about 50 ms.

## Validation (`tests/solver.mjs`)

- **Stripline:** exact conformal-mapping results (Cohn 1954 and 1955). The single-line Z0 agrees to 1e-6 at the default order and to 1e-11 at order 24; the coupled-line Z0e and Z0o agree to 1e-6.
- **Microstrip in air:** Z0 agrees with Hammerstad–Jensen to within 0.01 %, their stated accuracy. εeff agrees to within 0.2 %, again their stated accuracy.
- **Coupled microstrip:** within 1 % of Kirschning–Jansen.
- **Three unequal lines:** every entry of C agrees to 1e-5 with an independent method: pulse basis with point matching, using the spatial image series of the grounded slab, refined with Richardson extrapolation.
- **Convergence:** in basis order and in quadrature. Symmetry, mirroring and translation invariance; Maxwell-matrix sign structure; LC = μ0ε0εr·I in a homogeneous medium.

## Not yet

Strip thickness, solder mask over the strips, strips on more than one plane (broadside coupling), and dielectric loss (a G matrix). These are the follow-ups listed in #11.
