"""Research only. Kaggle GPU script: does keeping Maia's per-square activations beat pooling them?

The probe (probe_job.py) averages Maia3's token activations into one vector per position, which
throws away where things are. Here a small attention probe reads the tokens themselves:
- maia-mlp: the pooled baseline (layers 3, 5, last; mean + max), retrained in this run;
- spatial-mlp: tokens after the move (layers 5 and last), one transformer layer, then one
  learned attention query per concept;
- spatial-move-mlp: the same plus after-minus-before tokens and a token for the move.
Same labels, game split, validation-only selection and game bootstrap as probe_job.py.
Writes RESULTS.json (per-concept AUC/AP, bootstrap of spatial minus pooled) and, per concept,
where the probe looks on its top test positions.
"""
from probe_job import MIN_POSITIVES, MIN_VAL_AUC, MIN_VAL_POSITIVES, OUT, bootstrap, move_features, run, split

import glob
import json
import sys
from collections import Counter, deque

DIFFS = [("spatial-mlp", "maia-mlp"), ("spatial-move-mlp", "spatial-mlp"), ("spatial-move-mlp", "maia-mlp")]
LIMIT = 0  # smoke runs set a row cap
EPOCHS = 80


def main():
    if not OUT.is_dir():
        raise RuntimeError("Kaggle only")
    run([sys.executable, "-m", "pip", "install", "-q", "chess", "git+https://github.com/CSSLab/maia3.git"])
    import chess
    import numpy as np
    import torch
    from maia3.dataset import tokenize_board
    from maia3.uci import Maia3UCIEngine, parse_args
    from sklearn.metrics import average_precision_score, roc_auc_score
    nn, DEV = torch.nn, "cuda"

    path = glob.glob("/kaggle/input/**/labels.jsonl", recursive=True)[0]
    rows = [json.loads(line) for line in open(path, encoding="utf-8")]
    rows = rows[:LIMIT] if LIMIT else rows
    for r in rows:
        r["tags"] = r["tags"] + [f"[{c}]" for c in r["cats"]]
    train_count = Counter(t for r in rows if split(r["game"]) == "train" for t in r["tags"])
    tags = sorted(t for t, n in train_count.items() if n >= (20 if LIMIT else MIN_POSITIVES))
    befores = [chess.Board(r["before"]) for r in rows]
    moves = [b.parse_san(r["move"]) for b, r in zip(befores, rows)]
    afters = [chess.Board(r["fen"]) for r in rows]

    eng = Maia3UCIEngine(parse_args(["--model", "maia3-23m", "--device", DEV]))
    eng.ensure_model_loaded()
    model = eng.model.eval()
    layers = model.transformer.layers
    pooled_layers, token_layers = [3, 5, len(layers) - 1], [5, len(layers) - 1]
    grabbed = {}
    for i in set(pooled_layers + token_layers):
        layers[i].register_forward_hook(lambda m, a, o, i=i: grabbed.__setitem__(i, o))

    def encode(bs):
        """Pooled vectors (float32) and per-token activations (float16, CPU) for boards bs."""
        pooled, toks = [], []
        for s in range(0, len(bs), 512):
            t = torch.stack([eng._tokens_from_history(deque([tokenize_board(b)], maxlen=eng.cfg.history))
                             for b in bs[s:s + 512]]).to(DEV)
            elo = torch.full((len(t),), 1500, dtype=torch.long, device=DEV)
            with torch.no_grad():
                model(t, elo, elo)
            pooled.append(torch.cat([torch.cat([grabbed[i].mean(1), grabbed[i].amax(1)], 1)
                                     for i in pooled_layers], 1).float().cpu())
            toks.append(torch.cat([grabbed[i] for i in token_layers], 2).half().cpu())
        return torch.cat(pooled), torch.cat(toks)

    pooled, after = encode(afters)
    _, before = encode(befores)
    delta = after - before
    del before
    mv = torch.tensor(np.stack([move_features(chess, np, b, m) for b, m in zip(befores, moves)]), dtype=torch.float32)
    print("rows", len(rows), "tags", len(tags), "tokens", tuple(after.shape), flush=True)

    y = torch.tensor([[t in r["tags"] for t in tags] for r in rows], dtype=torch.float32)
    sp = [split(r["game"]) for r in rows]
    idx = {k: torch.tensor([i for i, s in enumerate(sp) if s == k]) for k in ("train", "val", "test")}
    tr = idx["train"]

    def norm(x):
        dims = (0, 1) if x.dim() == 3 else 0
        sample = x[tr[:4000]].float()  # enough for a mean and spread; the full split would not fit in float32
        return sample.mean(dims).to(DEV), (sample.std(dims) + 1e-4).to(DEV)

    data = {"pooled": pooled, "after": after, "delta": delta, "mv": mv}
    stats = {k: norm(x) for k, x in data.items()}

    class Pooled(nn.Module):
        def __init__(self):
            super().__init__()
            self.net = nn.Sequential(nn.Linear(pooled.shape[1], 512), nn.ReLU(), nn.Dropout(0.2),
                                     nn.Linear(512, len(tags)))

        def forward(self, b):
            return self.net(b["pooled"])

    class Spatial(nn.Module):
        """Tokens -> one transformer layer -> one attention query per concept -> logit."""
        def __init__(self, with_move, width=128):
            super().__init__()
            self.with_move = with_move
            self.proj = nn.Linear(after.shape[2] * (2 if with_move else 1), width)
            self.pos = nn.Parameter(torch.zeros(after.shape[1] + with_move, width))
            self.mv = nn.Linear(mv.shape[1], width) if with_move else None
            self.body = nn.TransformerEncoderLayer(width, 4, 2 * width, dropout=0.1, batch_first=True)
            self.query = nn.Parameter(torch.randn(len(tags), width) / width ** 0.5)
            self.head = nn.Parameter(torch.zeros(len(tags), width))
            self.bias = nn.Parameter(torch.zeros(len(tags)))

        def forward(self, b, attention=False):
            h = self.proj(torch.cat([b["after"], b["delta"]], 2) if self.with_move else b["after"])
            if self.with_move:
                h = torch.cat([h, self.mv(b["mv"])[:, None]], 1)
            h = self.body(h + self.pos)
            a = torch.softmax(torch.einsum("kw,ntw->nkt", self.query, h) / h.shape[2] ** 0.5, 2)
            logit = torch.einsum("nkt,ntw,kw->nk", a, h, self.head) + self.bias
            return (logit, a) if attention else logit

    def batch(ix):
        return {k: (x[ix].to(DEV).float() - stats[k][0]) / stats[k][1] for k, x in data.items()}

    def predict(net, ix):
        net.eval()
        with torch.no_grad():
            return torch.cat([torch.sigmoid(net(batch(ix[s:s + 512]))).cpu() for s in range(0, len(ix), 512)]).numpy()

    def fit(net):
        net = net.to(DEV)
        pos = y[tr].mean(0).clamp(1e-3)
        loss_fn = nn.BCEWithLogitsLoss(pos_weight=((1 - pos) / pos).sqrt().to(DEV))
        opt = torch.optim.AdamW(net.parameters(), lr=3e-4, weight_decay=1e-2)
        yv = y[idx["val"]]
        best, best_state, bad = 1e9, None, 0
        for epoch in range(EPOCHS):
            net.train()
            perm = tr[torch.randperm(len(tr))]
            for s in range(0, len(perm), 256):
                bi = perm[s:s + 256]
                opt.zero_grad()
                loss_fn(net(batch(bi)), y[bi].to(DEV)).backward()
                opt.step()
            pv = torch.tensor(predict(net, idx["val"])).clamp(1e-6, 1 - 1e-6)
            v = -(yv * pv.log() + (1 - yv) * (1 - pv).log()).mean().item()
            print("  epoch", epoch, round(v, 5), flush=True)
            if v < best - 1e-4:
                best, bad, best_state = v, 0, {k: t.clone() for k, t in net.state_dict().items()}
            else:
                bad += 1
                if bad >= 6:
                    break
        net.load_state_dict(best_state)
        pv, p = predict(net, idx["val"]), predict(net, idx["test"])
        yvn, yt = yv.numpy(), y[idx["test"]].numpy()
        val_auc = {t: round(float(roc_auc_score(yvn[:, j], pv[:, j])), 4)
                   for j, t in enumerate(tags) if 0 < yvn[:, j].sum() < len(yvn)}
        per = {t: {"auc": round(float(roc_auc_score(yt[:, j], p[:, j])), 4),
                   "ap": round(float(average_precision_score(yt[:, j], p[:, j])), 4),
                   "base_rate": round(float(yt[:, j].mean()), 4)}
               for j, t in enumerate(tags) if 0 < yt[:, j].sum() < len(yt)}
        return {"macro_auc": round(sum(v["auc"] for v in per.values()) / len(per), 4),
                "val_macro_auc": round(sum(val_auc.values()) / len(val_auc), 4),
                "val_auc": val_auc, "epochs": epoch + 1, "per_tag": per}, net, p

    results = {"rows": len(rows), "tags": tags, "train_counts": {t: train_count[t] for t in tags},
               "tokens": list(after.shape[1:]), "routers": {}}
    preds, nets = {}, {}
    for key, make in (("maia-mlp", Pooled), ("spatial-mlp", lambda: Spatial(False)),
                      ("spatial-move-mlp", lambda: Spatial(True))):
        torch.manual_seed(0)
        results["routers"][key], nets[key], preds[key] = fit(make())
        print(key, results["routers"][key]["macro_auc"], results["routers"][key]["val_macro_auc"], flush=True)
        torch.save(nets[key].state_dict(), OUT / f"{key}.pt")
    test = idx["test"]
    yt = y[test].numpy()
    results["bootstrap"] = bootstrap(np, roc_auc_score, preds, yt, [rows[i]["game"] for i in test.tolist()], tags)
    best = max(results["routers"], key=lambda k: results["routers"][k]["val_macro_auc"])
    yv, val_auc = y[idx["val"]].numpy(), results["routers"][best]["val_auc"]
    results["chosen_router"] = best
    results["kept"] = [t for j, t in enumerate(tags) if t.startswith("[") or (
        yv[:, j].sum() >= MIN_VAL_POSITIVES and val_auc.get(t, 0) >= MIN_VAL_AUC)]
    print("chosen", best, json.dumps(results["bootstrap"]["macro"]), flush=True)

    # Where the move-aware probe looks: per concept, its 5 highest-scoring labelled test positions
    # and the 8 tokens it attends to most (token index in Maia's order; the last one is the move).
    net = nets["spatial-move-mlp"].eval()
    with torch.no_grad():
        att = torch.cat([net(batch(test[s:s + 512]), attention=True)[1].cpu() for s in range(0, len(test), 512)])
    p = preds["spatial-move-mlp"]
    results["attention"] = {
        t: [{"fen": rows[int(test[i])]["fen"], "move": rows[int(test[i])]["move"], "score": round(float(p[i, j]), 3),
             "top_tokens": [[int(k), round(float(w), 3)] for w, k in zip(*att[i, j].topk(8))]}
            for i in [i for i in np.argsort(-p[:, j]) if yt[i, j]][:5]]
        for j, t in enumerate(tags)}
    (OUT / "RESULTS.json").write_text(json.dumps(results, indent=1), encoding="utf-8")
    print("done", flush=True)


if __name__ == "__main__":
    main()
