# Design brief — `add-problems` page (Lightspeed)

A brief for redesigning the **add-problems** review screen. Big visual/layout
changes are welcome; the *informational elements and the workflow* below are the
fixed substance. Treat the current page as a rough first pass, not a constraint.

---

## 1. Context (what this app is)

Lightspeed is a **personal** tool (single user) for drilling calculus. Problems
are generated in batches by an LLM that runs a computer-algebra system (sympy) to
compute and **verify** each answer. Generated problems land in a "staged" state
and must be reviewed before they enter the practice bank.

**This page is the review gate.** It is the only place the user curates what
enters their bank, so it should make reviewing a large batch fast and confident.

## 2. The core job of this page

> Look at a freshly generated batch of ~50 problems, throw out the bad ones, and
> accept the rest into the bank — quickly.

Key facts that should shape the design:

- **Batches are large (~50 problems).** A session may produce several batches =
  hundreds of problems. Scanning speed and low-friction rejection matter most.
- **The default action is "accept."** Most generated problems are good. The user
  is hunting for the occasional dud to reject, not approving one-by-one.
- **Answers are math, rendered as LaTeX** (currently via MathJax). Problem and
  answer both display typeset math.
- **The user does not tag here.** Tags are assigned by the LLM at generation time
  and shown read-only for context.

## 3. Interaction model (this is the new, important part)

- **Approve happens at the BATCH level.** One action accepts the whole batch
  (every problem not individually rejected). There is **no per-problem approve
  button** anymore.
- **Reject happens at the PROBLEM level.** Each problem can be individually
  rejected (toggle — should be reversible before the batch is approved).
- **Star is at the PROBLEM level.** An optional ⭐ marks a problem as
  "interesting in a hard-to-define way" (e.g. ∫ ln x). Independent of approve/
  reject; purely a flag for later. Reversible toggle.

So the mental flow is: *scan the batch → flick reject on the few duds (and star
any gems) → hit "Approve batch" once.* After approval the batch's remaining
problems become the bank; rejected ones are discarded.

Open design questions worth solving (your call):
- How to make rejecting 2–3 out of 50 feel instant (hover action? keyboard? swipe?).
- Whether rejected items collapse/grey out, and how to undo a reject.
- Whether to show a running count ("47 will be approved, 3 rejected").
- How multiple batches stack on one screen (a session has several). Collapsible
  batch sections? One batch at a time? Pagination?
- Keyboard-driven review for speed (j/k to move, r to reject, s to star, enter to
  approve batch?) — highly desirable for 50-at-a-time.

## 4. Information elements to show

**Per batch (section):**
- The generating **prompt** (e.g. "IBP definite integrals, no trig, polynomials
  degree ≤ 2") — acts as the section header / what this set is.
- The batch's **tags** (read-only chips), e.g. `definite-integral`, `ibp`.
- A single **Approve batch** action.
- (Suggested) live counts of how many will be approved vs. rejected.

**Per problem (row/card):**
- **Problem** (typeset LaTeX), e.g. \( \int_{0}^{1} x e^{x} \, dx \).
- **Answer** (typeset LaTeX), e.g. \( 1 \).
- **Verified badge** — `sympy-verified` (good) or `UNVERIFIED` (warn). Almost all
  will be verified; unverified ones are rare and should stand out (they should
  probably be hard to accidentally approve, or visually loud).
- **Sources** — `problem: claude`, `answer: sympy` (low-priority metadata).
- **Reject** control (per problem, reversible).
- **Star** control (per problem, reversible).

## 5. Data the page receives

The page loads staged problems from `GET /api/staged`, which returns an array of
batches:

```json
[
  {
    "id": 1,
    "prompt": "IBP definite integrals, no trig, polynomials degree <= 2",
    "created_at": "2026-06-26T12:14:11Z",
    "tags": [
      { "id": 2, "display_text": "definite-integral" },
      { "id": 3, "display_text": "ibp" }
    ],
    "problems": [
      {
        "id": 1,
        "latex_problem_text": "\\int_{0}^{1} x e^{x} \\, dx",
        "latex_answer_text": "1",
        "answer_verified_by": "sympy",
        "problem_source": "claude",
        "answer_source": "sympy",
        "starred": 0,
        "status": "staged"
      }
    ]
  }
]
```

Actions available (already implemented on the backend):
- `POST /api/problems/{id}/reject` — reject one problem.
- `POST /api/problems/{id}/star` with `{ "starred": true|false }` — toggle star.
- `POST /api/batches/{id}/approve` — approve the whole batch (all still-staged
  problems in it).

The LaTeX strings are raw TeX (no surrounding `$`); render with MathJax (or any
TeX renderer). Inline delimiters currently used: `\( ... \)`.

## 6. Fixed vs. open

**Fixed (don't drop these):**
- Batch-level approve, problem-level reject, problem-level star.
- Showing problem LaTeX, answer LaTeX, and the verified status per problem.
- Read-only batch prompt + tags.
- Must comfortably handle ~50 problems per batch and several batches at once.

**Open (redesign freely):**
- Entire visual language, layout, density, color.
- How rows/cards look; list vs. grid; collapsing; stickiness.
- Interaction mechanics for reject/star/approve (mouse, keyboard, gestures).
- Progressive disclosure of low-priority metadata (sources).
- Empty state.

## 7. Non-goals
- No tag creation or editing on this page (tags are LLM-assigned upstream).
- No problem *editing* (problems are immutable; reject is the only "no").
- No generation UI here (generation happens in a separate LLM session).

---

Deliverable from design: a layout/interaction concept for this screen that makes
reviewing a 50-problem batch fast and low-error, honoring the elements above.
