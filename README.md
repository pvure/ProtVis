# ProtVis

A protein, as ESM-2 sees it.

```bash
.venv/bin/python serve.py          # → http://localhost:8765, paste any sequence
PROTVIS_MODEL=facebook/esm2_t33_650M_UR50D .venv/bin/python serve.py   # bigger model
.venv/bin/python build_demos.py    # recompute web/demos/*.json
.venv/bin/python build_artifact.py # one self-contained HTML in dist/
```

What's drawn (`protvis.py`):

| | |
|---|---|
| thread | final-layer embeddings, z-scored, Gaussian-smoothed along sequence (σ = 1 residue), PCA → 3D |
| colour | masked-marginal p(wild-type) on a log scale, 0.002 → 0.6 (`K` cycles to conservation = 1 − H/log₂20, and N→C position) |
| arcs | ESM-2 contact head, p > 0.12, \|i−j\| ≥ 6 |
| Shift-3 | every layer's hidden states, PCA → 2D, Procrustes-aligned layer to layer, stacked by depth |

Keys: `Shift-1` fold · `Shift-2` landscape (`F` ride, `B` city) · `Shift-3` layers · `K` palette · `C` contacts · `Space` spin · `/` paste. UI fades when idle.
URL params: `?view=explode|land&ride&still#ubiquitin`. Default model is ESM-2 650M.

Results are cached in `cache/` keyed by model + sequence.
