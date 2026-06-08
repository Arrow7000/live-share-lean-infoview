/-
Fixture for the M1 headless RPC spike.

The proof below is intentionally simple but has a visible, deterministic tactic
goal at the start of the `by` block, so that `Lean.Widget.getInteractiveGoals`
returns a non-empty, stable goal state we can assert on.

Imports nothing beyond the Lean prelude, so no `lake build` / network is needed
to elaborate it; a bare `lean --server` (or `lake env lean --server`) suffices.

Cursor positions referenced by the test are 0-indexed (LSP convention) and are
computed in the test from these anchors:
wow comment from Jake!
  - The tactic block goal is requested at the start of the `exact` line.
-/

theorem fixture (p q : Prop) (hp : p) (hq : q) : p ∧ q := by
  exact ⟨hp, hq⟩
