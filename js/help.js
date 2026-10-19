export const HELP_HTML = `
<h2>Netlist syntax</h2>
<p>Quick reference. See the <a href="docs/manual.html" target="_blank" rel="noopener">manual</a> (<a href="docs/manual.html#3-netlist-language" target="_blank" rel="noopener">netlist language</a>, <a href="docs/manual.html#5-plots-and-trace-expressions" target="_blank" rel="noopener">traces</a>, <a href="docs/manual.html#7-filter-synthesis" target="_blank" rel="noopener">synthesis</a>) and the <a href="docs/examples/index.html" target="_blank" rel="noopener">worked examples</a>.</p>
<p>One statement per line. Comments start with <code>#</code> or <code>//</code> (or <code>*</code> at line start).
Numbers take SI prefixes: <code>f p n u m k M G T</code> (<code>m</code> = milli, <code>M</code>/<code>meg</code> = mega); trailing units are ignored
(<code>2.2pF</code>, <code>1.5GHz</code>, <code>25mm</code> = 0.025). Special units: <code>mil</code>, <code>in</code>, <code>deg</code>.
Values are expressions: <code>+ - * / ^</code>, <code>sqrt sin cos tan cot sind cosd tand cotd exp ln log10 abs min max db2mag</code>, constants <code>pi c0 mu0 eps0 eta0</code>.
Inside matrices and on statement lines, an expression must not contain spaces (except inside parentheses).</p>

<h4>Sweep and parameters</h4>
<pre>.freq START STOP POINTS [log]
.ref F0                         # reference frequency for "deg" lengths (default: sweep centre)
.param NAME = EXPR [tune LO HI] # tune → slider + optimiser variable
.title text
.substrate ID|custom [h=..] [er=..] [tand=..] [t=..]   # PCB technology; see the substrate presets page</pre>

<h4>Ports and lumped elements</h4>
<pre>port NODE [Z0]            # numbered 1, 2, … in order of appearance (default 50 Ω)
R|C|L&lt;name&gt; N1 N2 VALUE [Q=..]   # e.g.  C1 r1 0 2.2p Q=400
T&lt;name&gt; N1 N2 Z0=.. len=.. [er=..] [Q=..] [f0=..]   # single uncoupled line, both ends vs ground
wire N1 N2 [N3 …]         # join nodes (zero-ohm)
via &lt;name&gt; N1 [N2] d=.. [n=..] [h=..]   # n plated vias to ground (Goldfarb–Pucel L; h from .substrate)
cap &lt;name&gt; N1 [N2] C=.. type=ideal|smd|printed|trimmer [pkg=0603] [series=E24] [esl=..] [Q=..]   # loading capacitor with parasitics</pre>
<p>Ground: <code>0 gnd</code>. Open (unconnected) terminal: <code>- open nc</code>.</p>

<h4>Coupled-line section</h4>
<pre>cline NAME [len=..] [er=..] [Q=..] [f0=..]
  len 90deg | 25mm        # degrees at f0 (mean modal velocity if inhomogeneous)
  er 2.2                  # homogeneous dielectric (for Zeo/Y0/Z0/Cn/Cg forms)
  Q 500                   # unloaded Q → α = β/2Q per mode (optional)
  # line constants — one of:
  Zeo Z0e Z0o [eeff_e eeff_o]          # symmetric pair; inhomogeneous if eeff given
  Y0 [y11 y12; y21 y22]                # characteristic admittance matrix (S)
  Z0 [ … ]                             # characteristic impedance matrix (Ω)
  Cn [ … ]                             # normalised Maxwell capacitance C/ε
  Cg g1 g2 … gN                        # normalised ground capacitances C/ε …
  Cm m12 m23 …                         # … plus adjacent mutuals (N−1 values)
  Cm(i,j) m                            # … plus any non-adjacent mutual
  C [ … ]  and  L [ … ]                # per-unit-length F/m and H/m (general, inhomogeneous)
  geom msl  W w  S s                   # microstrip pair on the .substrate (closed form; model=field for the solver)
  geom msl  W [w1 … wN]  S [s12 …]     # N microstrip lines, C and L by the 2-D field solver (t = 0)
  A n1 n2 … nN            # nodes at end A (z = 0) of lines 1..N
  B n1 n2 … nN            # nodes at end B (z = ℓ)
end</pre>
<p>Sections sharing node names cascade, so tapped or stepped structures are built from several sections.</p>

<h4>Plots</h4>
<pre>.plot [ylim=LO,HI] [title=Words_with_underscores] TRACE TRACE …
.smith TRACE …</pre>
<p>Traces are complex expressions of <code>S21</code>, <code>S_12_3</code>, <code>S(i,j)</code>, <code>f</code>, <code>j</code>, with
<code>db mag ang angu(unwrapped) gd(group delay) re im vswr conj sqrt</code>. Example: <code>ang(S31/S21)</code>, <code>db(S31/S41)</code> (directivity).</p>

<h4>Measured data</h4>
<pre>.data NAME FILE.sNp [overlay] [z=Z]</pre>
<p>Touchstone 1.1/2.0 S-parameters as traces <code>NAME.S21</code>, usable in plots and goals; <b>Data…</b> loads files. <code>overlay</code> draws a dotted
data twin of every S trace; <code>z=</code> renormalises. Interpolated in magnitude and unwrapped phase; blank outside the file's range (manual §5.1).</p>

<h4>Layout and KiCad</h4>
<pre>.layout coupler K | schiffman CS TREF | marchand S1 S2  [pitch=..] [feed=..] [margin=..] [connector=..] [launch=matched|library]</pre>
<p>Sections must be physical (<code>geom=msl W= S=</code>, <code>T… W=</code>). The layout panel above the plots offers a layout when the topology fits,
converts impedance-defined sections to microstrip, edits these lines for you and exports KiCad 9 (manual §8).</p>

<h4>Optimisation</h4>
<pre>.goal TRACE &lt;|&gt;|= VALUE [F1 F2] [w=WEIGHT]
.opt maxiter=400</pre>
<p>Nelder–Mead over all <code>tune</code> parameters within their ranges (log-scaled when the range spans more than a decade).
Cost per goal = w·(mean(v²) + max(v)²) of the violation v over sweep points in [F1, F2].</p>

<h4>Synthesis (Synthesise… button)</h4>
<p>Tapped comb-line or interdigital band-pass from a Chebyshev or Butterworth prototype:
k<sub>i,i+1</sub> = FBW/√(g<sub>i</sub>g<sub>i+1</sub>), Q<sub>e</sub> = g<sub>0</sub>g<sub>1</sub>/FBW. Closed form (nodal, neighbours grounded, Y<sub>a</sub> = 1/Z<sub>r</sub>):
comb b = (Y<sub>a</sub>/2)(cot θ0 + θ0 csc² θ0), J = Y<sub>m</sub> cot θ0, C<sub>l</sub> = Y<sub>a</sub> cot θ0/ω0;
interdigital b = πY<sub>a</sub>/4, J = Y<sub>m</sub>; tap sin θt = sin θ0 √(bR0/Q<sub>e</sub>).
Refinement: exact split-mode k for each pair, tap Q<sub>e</sub> and end-resonator frequency from the full multiconductor model (S11 group delay),
then pre-distortion of f0 and FBW to land the realised centre and −3 dB bandwidth. The generated netlist carries tune ranges and a return-loss goal,
so the optimiser can polish the remaining ripple error. The trace functions <code>cheby(n,ripple,f0,fbw)</code> and <code>butter(n,f0,fbw)</code> give the ideal |S21|.</p>

<h4>Model</h4>
<p>Each section is solved by modal decomposition of LC (M = C<sup>½</sup>LC<sup>½</sup> = PΛPᵀ, W = C<sup>½</sup>P):
Y<sub>11</sub> = W diag(v<sub>i</sub> coth γ<sub>i</sub>ℓ) Wᵀ, Y<sub>12</sub> = −W diag(v<sub>i</sub> csch γ<sub>i</sub>ℓ) Wᵀ.
All sections and elements are stamped into a nodal admittance matrix; each port node is terminated in its reference conductance and S is solved directly
(real reference impedances). Lossless unless Q is given (low-loss approximation; characteristic admittances kept real).
Pure TEM/quasi-TEM: no dispersion, no end-effect or junction parasitics — add them explicitly as lumped elements.</p>
`;
