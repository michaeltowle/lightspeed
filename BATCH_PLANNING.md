# BATCH_PLANNING.md — Casella ch. 1–6 computational roadmap

Every computational / mathematical task type in Casella & Berger, *Statistical
Inference*, ch. 1–6, triaged by **what our pipeline can actually do today vs.
what needs a new method vs. what can't be auto-drilled at all**. The point of
this file is the triage, not the topic list.

**Actionability annotations:**

- *(blank, or a descriptive paren)* — **do it now**, plain sympy (differentiate,
  integrate, FTC, solve, determinant, series, limit, expand-back).
- *(numeric …)* — **do it now**; numeric cross-check, already in our toolkit
  (quadrature / plug-in points / score-equation check).
- *(novel: …)* — **needs a method we have not built.** The lever is named.
  ⚠ Most of these are unlocked by one thing: **Monte-Carlo simulation** (draw
  samples, compare empirical distribution / moment to the claim). We do not
  simulate anywhere yet — that is the single highest-leverage capability to add.
- *(not verifiable)* — **cannot be auto-drilled**: a proof or a concept with no
  computational check, by sympy or any method.

**Strikethrough** = we already have a (non-rejected) batch for it.
**Reference** items by id, e.g. `13a`, `14g`.

---

# Part I — Prerequisite fundamentals

*General calculus & algebra. All of this is do-it-now; nothing here is blocked.*

## 1. Algebra foundations

- **1a** ~~Known constants & values *(e, π, ln eᵏ, trig at special angles)*~~
- **1b** ~~Exponent & log laws~~ *(numeric cross-check)*
- **1c** ~~Factorizations *(difference of squares/cubes, perfect square)*~~
- **1d** ~~Complete the square — single variable~~
- **1e** ~~Partial-fraction decomposition~~

## 2. Combinatorics

- **2a** ~~Binomial coefficients *(n choose k)*~~

## 3. Differentiation

- **3a** ~~Single-variable derivatives *(chain / product / quotient)*~~
- **3b** ~~Higher-order derivatives~~
- **3c** ~~Partial derivatives~~
- **3d** ~~Mixed / higher partials~~
- **3e** ~~Logarithmic differentiation~~
- **3f** ~~Differentiate under the integral sign~~ *(Leibniz; numeric fallback if the integral won't close)*

## 4. Integration — single variable

- **4a** ~~u-substitution~~
- **4b** ~~Integration by parts~~
- **4c** ~~Partial-fraction integrals~~
- **4d** ~~Definite integrals *(FTC)*~~
- **4e** ~~Improper integrals *(infinite limits)*~~
- **4f** ~~Gamma-type integrals — ∫₀^∞ xᵃ⁻¹e⁻ˣ~~ *(numeric cross-check)*
- **4g** ~~Beta-type integrals — ∫₀¹ xᵃ⁻¹(1−x)ᵇ⁻¹~~ *(numeric cross-check)*
- **4h** ~~Gaussian integral — ∫ e⁻ˣ²ᐟ²~~ *(numeric cross-check)*
- **4i** ~~Arctan / Cauchy integrals — ∫ 1/(1+x²)~~

## 5. Series & sums

- **5a** ~~Finite sums *(closed form)*~~
- **5b** ~~Geometric series *(finite & infinite)*~~
- **5c** ~~Infinite-series sums~~ *(numeric cross-check where it won't close)*
- **5d** ~~Binomial-theorem expansion~~
- **5e** ~~Taylor / Maclaurin series~~
- **5f** ~~Power series of eˣ, ln(1+x), (1+x)ᵃ~~

## 6. Limits

- **6a** ~~Sequence limits~~
- **6b** ~~Function limits~~
- **6c** ~~L'Hôpital indeterminate forms~~
- **6d** ~~Compound-interest limit — (1+x/n)ⁿ → eˣ~~

## 7. Linear algebra *(Jacobians & multivariate normal)*

- **7a** ~~2×2 determinant~~
- **7b** ~~3×3 determinant~~
- **7c** ~~2×2 matrix inverse~~
- **7d** ~~Quadratic form xᵀAx — bivariate~~
- **7e** ~~Complete the square — quadratic form *(MVN exponent)*~~

## 8. Double integrals

- **8a** ~~Double integrals — rectangular region~~ *(numeric cross-check)*
- **8b** ~~Double integrals — non-rectangular region~~ *(numeric cross-check)*
- **8c** ~~Switch order of integration~~ *(numeric: both orders agree)*

## 9. Optimization

- **9a** ~~Critical points *(f′ = 0)*~~
- **9b** ~~Local extrema *(2nd-derivative test)*~~

---

# Part II — Casella material

*Probability & statistics computations, ch. 1–6. This is where the frontier is.*

## 10. Densities & CDFs

- **10a** Normalize a density / find the constant *(numeric cross-check)*
- **10b** Valid pdf/pmf check — nonneg & totals 1 *(numeric cross-check)*
- **10c** CDF from PDF *(integrate)*
- **10d** PDF from CDF *(differentiate)*
- **10e** Probability P(a < X < b) from a density *(numeric cross-check)*
- **10f** Quantile / inverse-CDF *(numeric: solve F(x) = p)*

## 11. Moments & generating functions

- **11a** ~~Expectation E[g(X)] — continuous, LOTUS~~ *(numeric cross-check)*
- **11b** ~~Expectation E[g(X)] — discrete, LOTUS~~ *(numeric cross-check)*
- **11c** ~~Variance~~ *(numeric cross-check)*
- **11d** Higher moments E[Xᵏ] *(numeric cross-check)*
- **11e** Moment generating function — compute *(numeric cross-check)*
- **11f** Moments by differentiating the MGF
- **11g** Cumulants / cumulant generating function
- **11h** Identify a distribution from its MGF *(novel: match against an MGF/series table)*

## 12. Joint, marginal & conditional

- **12a** Marginalize a joint density *(numeric cross-check)*
- **12b** Conditional density f(x∣y) *(novel: answer is a function — verify on a y-grid or by simulation)*
- **12c** Conditional expectation E[X∣Y] *(novel: simulate, or grid-compare)*
- **12d** Independence via factorization *(novel: check joint = product of marginals)*
- **12e** Covariance & correlation from a joint density *(numeric cross-check)*
- **12f** Bivariate-normal exponent — quadratic form / complete the square
- **12g** Iterated expectation E[E[X∣Y]] *(novel: simulate)*

## 13. Distributions of derived quantities  ⟵ frontier

*The shared catch: "integrates to 1" only proves it's **a** density, not the
**right** one. Confirming it's the true distribution of the derived quantity
needs Monte-Carlo or a CDF-match we don't have yet.*

- **13a** Distribution of Y = g(X), monotone *(novel: CDF method / simulate)*
- **13b** Distribution of Y = g(X), non-monotone *(novel: branch sum + simulate)*
- **13c** Bivariate transformation, 2-D Jacobian *(novel: simulate)*
- **13d** Sum of independents — convolution *(novel: via MGF product, or simulate)*
- **13e** Sampling distribution of X̄, S² *(novel: simulate / MGF)*
- **13f** Order-statistic density *(novel: formula + simulate)*
- **13g** Probability integral transform *(novel: simulate & KS-compare)*

## 14. Likelihood, sufficiency & information (ch. 6)

- **14a** Log-likelihood — construct
- **14b** Score function — ∂/∂θ log-lik
- **14c** MLE — single parameter *(score-equation check)*
- **14d** MLE — multi-parameter system *(novel: numeric solve + check when symbolic fails)*
- **14e** Fisher information, scalar *(numeric cross-check)*
- **14f** Fisher information matrix *(novel: symbolic/numeric Hessian of log-lik)*
- **14g** Sufficiency via factorization *(novel: verify a proposed factorization expands back — finding T isn't unique)*
- **14h** Minimal sufficiency *(novel: check f(x;θ)/f(y;θ) is θ-free)*
- **14i** Ancillary statistic *(novel: confirm the derived distribution has no θ)*
- **14j** Completeness *(not verifiable)*

## 15. Convergence & approximation (ch. 5)

- **15a** Convergence in distribution via MGF limit
- **15b** CLT standardization & limit *(numeric / MGF)*
- **15c** Delta method — approx mean / variance of g(X̄) *(derivative; asymptotic validity itself isn't checked)*
- **15d** Apply a Markov / Chebyshev bound

## 16. Not computationally drillable — concepts & proofs

*Surfaced deliberately: this is the bulk of Casella's actual reasoning, and none
of it is auto-drillable.*

- **16a** Convergence in probability / almost surely — proofs *(not verifiable)*
- **16b** WLLN / SLLN / CLT — the theorems *(not verifiable)*
- **16c** Prove Jensen / Cauchy–Schwarz / covariance inequality *(not verifiable)*
- **16d** Justify limit–integral interchange, DCT/MCT *(not verifiable)*
- **16e** Completeness / Basu / Rao–Blackwell arguments *(not verifiable)*
- **16f** Likelihood & sufficiency principles, equivariance *(not verifiable)*
