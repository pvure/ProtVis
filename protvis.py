"""ESM-2 -> geometry. Everything the front end draws is computed here.

For one sequence we return:
  emb3d     final-layer per-residue embeddings, z-scored, smoothed along the
            sequence (Gaussian, SMOOTH residues), PCA'd to 3D
  layers2d  every layer (token embedding .. last block) PCA'd to 2D, each
            Procrustes-aligned to the one before so the stack reads as one
            continuous deformation instead of 13 independently flipped plots
  logp_wt   masked-marginal log p(wild-type residue): "evolutionary support"
  entropy   masked-marginal entropy (bits) over the 20 standard amino acids
  probs     the full 20-way masked marginal per position (for the readout)
  contacts  ESM-2's own contact head, pairs with p > CONTACT_MIN, |i-j| >= 6
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

import numpy as np
import torch

MODEL_NAME = os.environ.get("PROTVIS_MODEL", "facebook/esm2_t33_650M_UR50D")
AA = "ACDEFGHIKLMNPQRSTVWY"
CONTACT_MIN = 0.12
SMOOTH = 1.0  # residues; raw per-residue PCA jumps ~0.7 radii per step
MASKED_MAX_LEN = 1000  # above this, fall back to a single unmasked pass
CACHE = Path(__file__).parent / "cache"

_model = _tok = _device = None


def load():
    global _model, _tok, _device
    if _model is None:
        from transformers import AutoTokenizer, EsmForMaskedLM

        _device = "mps" if torch.backends.mps.is_available() else (
            "cuda" if torch.cuda.is_available() else "cpu")
        _tok = AutoTokenizer.from_pretrained(MODEL_NAME)
        _model = EsmForMaskedLM.from_pretrained(MODEL_NAME, attn_implementation="eager").eval().to(_device)
    return _model, _tok, _device


def clean(seq: str) -> str:
    seq = "".join(seq.split()).upper()
    if seq.startswith(">"):
        raise ValueError("paste the sequence without the FASTA header")
    bad = sorted(set(seq) - set(AA + "XBZUO"))
    if bad:
        raise ValueError(f"not amino acids: {''.join(bad)}")
    if not 8 <= len(seq) <= 2000:
        raise ValueError("sequence length must be 8-2000")
    return seq


def _pca(x: np.ndarray, k: int):
    x = (x - x.mean(0)) / (x.std(0) + 1e-6)  # tames ESM's outlier dimensions
    u, s, vt = np.linalg.svd(x, full_matrices=False)
    var = (s**2) / (s**2).sum()
    return u[:, :k] * s[:k], var[:k]


def _smooth(x: np.ndarray, sigma: float) -> np.ndarray:
    """Gaussian window along the sequence: each residue's vector becomes a
    weighted mean of its neighbours (sigma in residues)."""
    if sigma <= 0:
        return x
    r = int(np.ceil(3 * sigma))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    xp = np.pad(x, ((r, r), (0, 0)), mode="edge")
    out = np.zeros_like(x)
    for o, w in enumerate(k):
        out += w * xp[o : o + len(x)]
    return out / k.sum()


def _norm(y: np.ndarray) -> np.ndarray:
    """Centre, scale so the 90th-percentile residue sits at r=1, then
    soft-clip the radius so one outlier (often M1) can't flatten the rest."""
    y = y - np.median(y, 0)
    r = np.sqrt((y**2).sum(1)) + 1e-9
    y = y / np.percentile(r, 90)
    r = np.sqrt((y**2).sum(1)) + 1e-9
    return y * (1.2 * np.tanh(r / 1.2) / r)[:, None]


def _procrustes(y: np.ndarray, ref: np.ndarray) -> np.ndarray:
    u, _, vt = np.linalg.svd(y.T @ ref)
    return y @ (u @ vt)


@torch.no_grad()
def embed(seq: str) -> dict:
    seq = clean(seq)
    key = hashlib.sha1(f"v3:{MODEL_NAME}:{SMOOTH}:{seq}".encode()).hexdigest()[:16]
    hit = CACHE / f"{key}.json"
    if hit.exists():
        return json.loads(hit.read_text())

    model, tok, dev = load()
    enc = tok(seq, return_tensors="pt").to(dev)
    out = model(**enc, output_hidden_states=True)
    L = len(seq)
    hs = [h[0, 1 : L + 1].float().cpu().numpy() for h in out.hidden_states]

    # geometry
    z = hs[-1]
    z = (z - z.mean(0)) / (z.std(0) + 1e-6)
    e3, var3 = _pca(_smooth(z, SMOOTH), 3)
    emb3d = _norm(e3)
    layers2d, prev = [], None
    for h in hs:
        y, _ = _pca(h, 2)
        y = _norm(y)
        if prev is not None:
            y = _procrustes(y, prev)
        layers2d.append(y)
        prev = y

    # contacts from ESM-2's own regression head on attention maps
    c = model.esm.predict_contacts(enc["input_ids"], enc["attention_mask"])[0].float().cpu().numpy()
    ii, jj = np.triu_indices(L, 6)
    p = c[ii, jj]
    keep = p > CONTACT_MIN
    order = np.argsort(-p[keep])[: 6 * L]
    contacts = [[int(a), int(b), round(float(q), 3)]
                for a, b, q in zip(ii[keep][order], jj[keep][order], p[keep][order])]

    # masked marginals: mask each position in turn
    aa_ids = torch.tensor(tok.convert_tokens_to_ids(list(AA)), device=dev)
    ids = enc["input_ids"]
    if L <= MASKED_MAX_LEN:
        logits = torch.empty(L, len(AA))
        bs = max(1, 8192 // L)
        for s0 in range(0, L, bs):
            pos = torch.arange(s0, min(L, s0 + bs), device=dev)
            batch = ids.repeat(len(pos), 1)
            batch[torch.arange(len(pos)), pos + 1] = tok.mask_token_id
            lg = model(input_ids=batch, attention_mask=torch.ones_like(batch)).logits
            logits[s0 : s0 + len(pos)] = lg[torch.arange(len(pos)), pos + 1][:, aa_ids].float().cpu()
        marginal = "masked"
    else:
        logits = out.logits[0, 1 : L + 1][:, aa_ids].float().cpu()
        marginal = "unmasked"
    logp = torch.log_softmax(logits, -1).numpy()
    prob = np.exp(logp)
    entropy = -(prob * logp).sum(1) / np.log(2)
    wt = np.array([AA.index(a) if a in AA else -1 for a in seq])
    logp_wt = np.where(wt >= 0, logp[np.arange(L), np.clip(wt, 0, None)], np.nan)

    r = lambda a, d=4: np.round(a, d).tolist()
    res = {
        "id": key,
        "model": MODEL_NAME,
        "marginal": marginal,
        "seq": seq,
        "n_layers": len(hs) - 1,
        "dim": int(hs[-1].shape[1]),
        "emb3d": r(emb3d),
        "var3d": r(var3, 4),
        "smooth": SMOOTH,
        "layers2d": [r(y) for y in layers2d],
        "logp_wt": [None if np.isnan(v) else round(float(v), 3) for v in logp_wt],
        "entropy": r(entropy, 3),
        "probs": r(prob, 3),
        "contacts": contacts,
        "pseudo_ppl": round(float(np.exp(-np.nanmean(logp_wt))), 3),
    }
    CACHE.mkdir(exist_ok=True)
    hit.write_text(json.dumps(res, separators=(",", ":")))
    return res
