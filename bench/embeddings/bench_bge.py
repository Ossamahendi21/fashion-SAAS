#!/usr/bin/env python3
"""Step 7 Phase B1 — BAAI/bge-small-en-v1.5 CPU benchmark on the aarch64 target VPS.

Runtime: official ONNX artifact (onnx/model.onnx from the pinned official revision) on
onnxruntime CPUExecutionProvider. No torch, no CUDA, no self-quantization.

Reads ONLY the frozen B0 fixtures (corpus.json, pairs.json, neighbors.json) and never writes to
them. Every number lands in <out>/. No OpenAI, no network at benchmark time, no Convex access.

Official pipeline replicated here (sentence-transformers modules.json for this model):
    Transformer (BERT) -> Pooling(CLS, 1_Pooling/config.json) -> Normalize (L2)
The ONNX graph stops at last_hidden_state, so CLS pooling + L2 normalization happen here, and
L2 normalization happens in exactly one function.
"""

import argparse
import json
import os
import statistics
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import onnxruntime as ort
import tokenizers
from tokenizers import Tokenizer

MODEL_ID = "BAAI/bge-small-en-v1.5"
REVISION = "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a"
EXPECTED_DIM = 384
MODEL_MAX_SEQ = 512
NORM_TOLERANCE = 1e-5
WEIGHT_LIMIT_BYTES = 1_000_000_000
RSS_LIMIT_BYTES = 2_000_000_000


# --------------------------------------------------------------------------------------- process

def _proc_status_kb(field):
    with open("/proc/self/status", "r", encoding="utf-8") as handle:
        for line in handle:
            if line.startswith(field):
                return int(line.split()[1]) * 1024
    return 0


def rss_bytes():
    return _proc_status_kb("VmRSS:")


def peak_rss_bytes():
    return _proc_status_kb("VmHWM:")


def cpu_snapshot():
    with open("/proc/stat", "r", encoding="utf-8") as handle:
        parts = [int(v) for v in handle.readline().split()[1:9]]
    idle = parts[3] + parts[4]
    return sum(parts), idle


def cpu_utilisation(before, after):
    total_delta = after[0] - before[0]
    idle_delta = after[1] - before[1]
    if total_delta <= 0:
        return None
    return round(100.0 * (1.0 - idle_delta / total_delta), 1)


# --------------------------------------------------------------------------------------- helpers

def pct(values, p):
    """Nearest-rank percentile on a sorted list; deterministic and dependency-free."""
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, int(round((p / 100.0) * len(ordered) + 0.5)) - 1))
    return float(ordered[index])


def describe(values):
    if not values:
        return None
    return {
        "n": len(values),
        "min": round(float(min(values)), 6),
        "p05": round(pct(values, 5), 6),
        "p25": round(pct(values, 25), 6),
        "median": round(pct(values, 50), 6),
        "p75": round(pct(values, 75), 6),
        "p95": round(pct(values, 95), 6),
        "max": round(float(max(values)), 6),
        "mean": round(float(statistics.fmean(values)), 6),
    }


def l2_normalize(matrix):
    """THE single normalization point for the whole benchmark. Applied once, after CLS pooling."""
    norms = np.linalg.norm(matrix, axis=1)
    safe = np.where(norms == 0, 1.0, norms)
    return (matrix / safe[:, None]).astype(np.float32), norms.astype(np.float64)


# --------------------------------------------------------------------------------------- encoder

class Encoder:
    def __init__(self, snapshot, threads):
        self.model_path = str(Path(snapshot) / "onnx" / "model.onnx")
        self.tokenizer_path = str(Path(snapshot) / "tokenizer.json")
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.threads = threads
        self.session = ort.InferenceSession(
            self.model_path, options, providers=["CPUExecutionProvider"]
        )
        self.tokenizer = Tokenizer.from_file(self.tokenizer_path)
        self.tokenizer.enable_truncation(max_length=MODEL_MAX_SEQ)

    def input_names(self):
        return [i.name for i in self.session.get_inputs()]

    def output_names(self):
        return [o.name for o in self.session.get_outputs()]

    def token_lengths(self, texts):
        return [len(e.ids) for e in self.tokenizer.encode_batch(texts)]

    def _feeds(self, texts):
        encodings = self.tokenizer.encode_batch(texts)
        width = max(len(e.ids) for e in encodings)
        batch = len(encodings)
        ids = np.zeros((batch, width), dtype=np.int64)
        mask = np.zeros((batch, width), dtype=np.int64)
        types = np.zeros((batch, width), dtype=np.int64)
        for row, encoding in enumerate(encodings):
            length = len(encoding.ids)
            ids[row, :length] = encoding.ids
            mask[row, :length] = 1
            types[row, :length] = encoding.type_ids
        return {"input_ids": ids, "attention_mask": mask, "token_type_ids": types}

    def forward(self, texts, batch_size=1):
        """CLS-pooled, un-normalized vectors. L2 normalization happens in embed()."""
        chunks = []
        for start in range(0, len(texts), batch_size):
            feeds = self._feeds(texts[start : start + batch_size])
            hidden = self.session.run(["last_hidden_state"], feeds)[0]
            chunks.append(hidden[:, 0, :].astype(np.float32))
        return np.vstack(chunks)

    def embed(self, texts, batch_size=1):
        """Returns (unit vectors, norms measured BEFORE normalization)."""
        pooled = self.forward(texts, batch_size=batch_size)
        return l2_normalize(pooled)


def cosine_matrix(vectors):
    """Unit vectors assumed; guards the assumption rather than trusting it."""
    lengths = np.linalg.norm(vectors, axis=1)
    if not np.all(np.abs(lengths - 1.0) < 1e-5):
        raise AssertionError("cosine_matrix called on non-normalized vectors")
    return np.clip(vectors @ vectors.T, -1.0, 1.0)


# --------------------------------------------------------------------------------------- sections

def section_load(snapshot, threads):
    weight_bytes = (Path(snapshot) / "onnx" / "model.onnx").stat().st_size
    before_rss = rss_bytes()
    cpu_before = cpu_snapshot()
    started = time.perf_counter()
    encoder = Encoder(snapshot, threads)
    load_seconds = time.perf_counter() - started
    load_cpu = cpu_utilisation(cpu_before, cpu_snapshot())

    import onnx

    graph = onnx.load(encoder.model_path).graph
    param_count = 0
    initializer_bytes = 0
    dtypes = Counter()
    for initializer in graph.initializer:
        count = 1
        for dim in initializer.dims:
            count *= dim
        param_count += count
        initializer_bytes += count * 4
        dtypes[onnx.TensorProto.DataType.Name(initializer.data_type)] += count

    report = {
        "runtime": "onnxruntime CPUExecutionProvider (official onnx/model.onnx)",
        "onnxruntime_version": ort.__version__,
        "providers": ort.get_available_providers(),
        "model_id": MODEL_ID,
        "revision": REVISION,
        "weight_bytes": weight_bytes,
        "weight_mib": round(weight_bytes / 1024 / 1024, 2),
        "weight_limit_ok": weight_bytes <= WEIGHT_LIMIT_BYTES,
        "input_names": encoder.input_names(),
        "output_names": encoder.output_names(),
        "param_count": param_count,
        "param_dtype": dict(dtypes),
        "initializer_bytes": initializer_bytes,
        "architecture": "BertModel (BERT): 12 layers, hidden 384, 12 heads, intermediate 1536, vocab 30522",
        "pooling": "CLS token (sentence-transformers 1_Pooling, pooling_mode_cls_token=true)",
        "normalization": "L2, applied once in l2_normalize()",
        "model_max_seq_length": MODEL_MAX_SEQ,
        "max_position_embeddings": 512,
        "load_seconds": round(load_seconds, 3),
        "load_cpu_percent": load_cpu,
        "rss_before_bytes": before_rss,
        "rss_after_bytes": rss_bytes(),
        "peak_rss_bytes": peak_rss_bytes(),
        "peak_rss_mib": round(peak_rss_bytes() / 1024 / 1024, 2),
        "rss_limit_ok": peak_rss_bytes() <= RSS_LIMIT_BYTES,
        "threads": {"intra_op": threads, "inter_op": 1},
        "env_threads": {
            key: os.environ.get(key)
            for key in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS")
        },
        "host": {
            "arch": os.uname().machine,
            "cpu_count": os.cpu_count(),
            "cuda_available": False,
        },
    }
    return encoder, report


def section_contract(encoder, texts_by_name):
    all_texts = [t for group in texts_by_name.values() for t in group]
    vectors, norms = encoder.embed(all_texts, batch_size=16)
    unit_norms = np.linalg.norm(vectors, axis=1)
    return {
        "inputs": len(all_texts),
        "output_dim": int(vectors.shape[1]),
        "dim_is_exactly_384": vectors.shape[1] == EXPECTED_DIM,
        "all_finite": bool(np.all(np.isfinite(vectors))),
        "norm_before_normalization": describe(norms.tolist()),
        "norm_after_normalization": describe(unit_norms.tolist()),
        "max_abs_deviation_from_1": float(np.max(np.abs(unit_norms - 1.0))),
        "within_1e-5": bool(np.all(np.abs(unit_norms - 1.0) < NORM_TOLERANCE)),
    }, vectors, norms


def section_determinism(encoder, texts):
    first, _ = encoder.embed(texts, batch_size=16)
    second, _ = encoder.embed(texts, batch_size=16)
    reversed_first, _ = encoder.embed(list(reversed(texts)), batch_size=16)
    batch_one, _ = encoder.embed(texts, batch_size=1)

    diff = np.abs(first - second)
    reversed_diff = np.abs(first - np.vstack(list(reversed(reversed_first))))
    repeat_cosines = np.sum(first * second, axis=1)
    batch_diff = np.abs(first - batch_one)

    return {
        "runs": 3,
        "exact_vector_equality_repeat": bool(np.array_equal(first, second)),
        "max_abs_diff_repeat": float(diff.max()),
        "min_cosine_repeat": float(repeat_cosines.min()),
        "exact_vector_equality_reversed_order": bool(np.array_equal(first, np.vstack(list(reversed(reversed_first))))),
        "max_abs_diff_reversed_order": float(reversed_diff.max()),
        "exact_vector_equality_batch1_vs_batch16": bool(np.array_equal(first, batch_one)),
        "max_abs_diff_batch1_vs_batch16": float(batch_diff.max()),
        "bitwise_repeat_note": (
            "ONNX Runtime CPU fp32 is not guaranteed bitwise reproducible across batch shapes; "
            "functional determinism is what is asserted."
        ),
    }


def section_latency(encoder, texts, threads_list=(1, 2, 4, 8)):
    for text in texts[:4]:
        encoder.embed([text])

    single = []
    for text in texts:
        started = time.perf_counter()
        encoder.embed([text])
        single.append((time.perf_counter() - started) * 1000.0)

    single_report = {
        "requests": len(single),
        "batch_size": 1,
        "warm": True,
        "p50_ms": round(pct(single, 50), 2),
        "p95_ms": round(pct(single, 95), 2),
        "max_ms": round(round(max(single), 2), 2),
        "mean_ms": round(statistics.fmean(single), 2),
    }

    concurrency = {}
    for workers in threads_list:
        wall_start = time.perf_counter()
        cpu_before = cpu_snapshot()
        rss_before = rss_bytes()

        def one(text):
            begin = time.perf_counter()
            encoder.embed([text])
            return (time.perf_counter() - begin) * 1000.0

        with ThreadPoolExecutor(max_workers=workers) as pool:
            latencies = list(pool.map(one, texts))
        wall = time.perf_counter() - wall_start

        concurrency[str(workers)] = {
            "concurrency": workers,
            "requests": len(latencies),
            "batch_size": 1,
            "wall_seconds": round(wall, 3),
            "throughput_texts_per_sec": round(len(latencies) / wall, 2),
            "latency_p50_ms": round(pct(latencies, 50), 2),
            "latency_p95_ms": round(pct(latencies, 95), 2),
            "latency_max_ms": round(max(latencies), 2),
            "peak_rss_bytes": peak_rss_bytes(),
            "peak_rss_mib": round(peak_rss_bytes() / 1024 / 1024, 2),
            "rss_growth_mib": round((peak_rss_bytes() - rss_before) / 1024 / 1024, 2),
            "cpu_percent": cpu_utilisation(cpu_before, cpu_snapshot()),
            "failures": 0,
        }

    bulk = {}
    for batch in (8, 16, 32):
        started = time.perf_counter()
        encoder.embed(texts, batch_size=batch)
        wall = time.perf_counter() - started
        bulk[str(batch)] = {
            "batch_size": batch,
            "texts": len(texts),
            "wall_seconds": round(wall, 3),
            "throughput_texts_per_sec": round(len(texts) / wall, 2),
            "per_text_ms": round(wall * 1000.0 / len(texts), 2),
        }

    return {"single_request": single_report, "concurrency": concurrency, "bulk_batches": bulk}


# --------------------------------------------------------------------------------------- scoring

def score_pairs(pairs_fixture, vectors_by_text):
    scored = []
    for entry in pairs_fixture["pairs"]:
        left = vectors_by_text[entry["a"]["embeddingText"]]
        right = vectors_by_text[entry["b"]["embeddingText"]]
        scored.append(
            {
                "pairId": entry["id"],
                "class": entry["cls"],
                "isDuplicate": entry["isDuplicate"],
                "isStronglySimilar": entry["isStronglySimilar"],
                "cosine": round(float(np.dot(left, right)), 6),
            }
        )
    return scored


def distributions(scored):
    by_class = {}
    for entry in scored:
        by_class.setdefault(entry["class"], []).append(entry["cosine"])
    out = {cls: describe(values) for cls, values in by_class.items()}
    out["_positives_isDuplicate"] = describe([e["cosine"] for e in scored if e["isDuplicate"]])
    out["_negatives_notDuplicate"] = describe([e["cosine"] for e in scored if not e["isDuplicate"]])
    out["_positives_isStronglySimilar"] = describe(
        [e["cosine"] for e in scored if e["isStronglySimilar"]]
    )
    out["_negatives_notStronglySimilar"] = describe(
        [e["cosine"] for e in scored if not e["isStronglySimilar"]]
    )
    return out


def sweep(scored, label_field):
    """Predict positive when cosine >= t. Returns the full sweep plus the zero-FP analysis."""
    positives = [e["cosine"] for e in scored if e[label_field]]
    negatives = [e["cosine"] for e in scored if not e[label_field]]
    observed = sorted(set(round(v, 6) for v in [e["cosine"] for e in scored]))

    candidates = set()
    for index in range(len(observed) - 1):
        candidates.add(round((observed[index] + observed[index + 1]) / 2.0, 6))
    if observed:
        candidates.add(round(observed[0] - 1e-4, 6))
        candidates.add(round(observed[-1] + 1e-4, 6))
    for grid in range(400, 1000, 5):
        candidates.add(round(grid / 1000.0, 4))
    candidates = sorted(c for c in candidates if 0.0 <= c <= 1.0)

    total_pos, total_neg = len(positives), len(negatives)
    rows = []
    for threshold in candidates:
        tp = sum(1 for v in positives if v >= threshold)
        fn = total_pos - tp
        fp = sum(1 for v in negatives if v >= threshold)
        tn = total_neg - fp
        precision = tp / (tp + fp) if (tp + fp) else 1.0
        recall = tp / total_pos if total_pos else 0.0
        rows.append(
            {
                "threshold": threshold,
                "tp": tp,
                "fp": fp,
                "tn": tn,
                "fn": fn,
                "precision": round(precision, 6),
                "recall": round(recall, 6),
            }
        )

    zero_fp = [r for r in rows if r["fp"] == 0]
    best = max(zero_fp, key=lambda r: (r["recall"], r["threshold"])) if zero_fp else None
    tightest = max(zero_fp, key=lambda r: r["threshold"]) if zero_fp else None
    binding = None
    if best is not None:
        ceiling = max(negatives) if negatives else None
        binding = sorted(
            (
                {
                    "pairId": e["pairId"],
                    "class": e["class"],
                    "cosine": e["cosine"],
                }
                for e in scored
                if not e[label_field] and (ceiling is None or e["cosine"] >= ceiling - 0.02)
            ),
            key=lambda e: -e["cosine"],
        )[:6]

    return {
        "label": label_field,
        "positives": total_pos,
        "negatives": total_neg,
        "max_negative_cosine": round(max(negatives), 6) if negatives else None,
        "min_positive_cosine": round(min(positives), 6) if positives else None,
        "zero_fp_thresholds": len(zero_fp),
        "proposed_zero_fp_max_recall": best,
        "zero_fp_tightest": tightest,
        "binding_negatives_near_ceiling": binding,
        "sweep": rows,
    }


def separation_analysis(scored, label_field):
    """How separable is this label at all? Computed before any threshold is proposed."""
    positives = [e["cosine"] for e in scored if e[label_field]]
    negatives = [e["cosine"] for e in scored if not e[label_field]]

    pos_min, neg_max = min(positives), max(negatives)
    overlap = [e for e in scored if not e[label_field] and e["cosine"] >= pos_min]
    pos_above_negmax = [e for e in scored if e[label_field] and e["cosine"] > neg_max]

    # Mann-Whitney AUC: P(positive > negative); 0.5 == no better than random
    wins = sum(
        (1 if p > n else 0.5 if p == n else 0) for p in positives for n in negatives
    )
    auc = wins / (len(positives) * len(negatives))

    rows = sweep(scored, label_field)["sweep"]
    best_f1 = max(
        rows,
        key=lambda r: (
            (2 * r["tp"] / (2 * r["tp"] + r["fp"] + r["fn"])) if (2 * r["tp"] + r["fp"] + r["fn"]) else 0,
            -r["fp"],
        ),
    )
    min_fp_at_full_recall = min(
        (r for r in rows if r["fn"] == 0), key=lambda r: r["fp"], default=None
    )
    zero_fp = [r for r in rows if r["fp"] == 0]
    best_zero_fp = max(zero_fp, key=lambda r: r["recall"], default=None)

    return {
        "label": label_field,
        "positives": len(positives),
        "negatives": len(negatives),
        "positive_min": round(pos_min, 6),
        "positive_max": round(max(positives), 6),
        "negative_min": round(min(negatives), 6),
        "negative_max": round(neg_max, 6),
        "distributions_overlap": pos_min <= neg_max,
        "positives_below_negative_max": len(pos_above_negmax),
        "negatives_above_positive_min": len(overlap),
        "auc": round(auc, 4),
        "auc_interpretation": (
            "better than random" if auc >= 0.55 else
            "no better than random" if auc >= 0.45 else
            "WORSE than random (inverted signal)"
        ),
        "best_f1": best_f1,
        "best_f1_score": round(
            (2 * best_f1["tp"] / (2 * best_f1["tp"] + best_f1["fp"] + best_f1["fn"]))
            if (2 * best_f1["tp"] + best_f1["fp"] + best_f1["fn"]) else 0, 4),
        "min_false_positives_at_100pct_recall": min_fp_at_full_recall,
        "best_zero_false_positive": best_zero_fp,
        "zero_fp_gate_satisfiable": bool(best_zero_fp and best_zero_fp["recall"] > 0),
    }


# --------------------------------------------------------------------------------------- neighbours

def neighbour_quality(corpus_ids, vectors, neighbours_fixture, top=(3, 8)):
    expectations = {e["id"]: e for e in neighbours_fixture["items"]}
    similarity = cosine_matrix(vectors)
    per_item = []
    for index, item_id in enumerate(corpus_ids):
        scores = similarity[index].copy()
        scores[index] = -2.0
        order = np.argsort(-scores)
        ranked = [corpus_ids[i] for i in order]
        expected = expectations[item_id]["expected"]
        bad = expectations[item_id]["bad"]
        entry = {"id": item_id}
        for k in top:
            head = ranked[:k]
            entry[f"top{k}"] = [
                {"id": cid, "cosine": round(float(scores[order[position]]), 4),
                 "judgement": "expected" if cid in expected else ("bad" if cid in bad else "neutral")}
                for position, cid in enumerate(head)
            ]
            entry[f"expected_in_top{k}"] = len([c for c in head if c in expected])
            entry[f"expected_total"] = len(expected)
            entry[f"bad_in_top{k}"] = len([c for c in head if c in bad])
        per_item.append(entry)

    summary = {}
    for k in top:
        exp_hits = sum(e[f"expected_in_top{k}"] for e in per_item)
        exp_total = sum(e["expected_total"] for e in per_item)
        bad_hits = sum(e[f"bad_in_top{k}"] for e in per_item)
        summary[f"top{k}"] = {
            "expected_recall": f"{exp_hits}/{exp_total}",
            "expected_recall_fraction": round(exp_hits / exp_total, 4) if exp_total else None,
            "items_with_all_expected_in_top": sum(
                1 for e in per_item if e[f"expected_in_top{k}"] == e["expected_total"] and e["expected_total"] > 0
            ),
            "items_with_all_expected_in_top_of_expected_items": sum(
                1 for e in per_item if e["expected_total"] > 0 and e[f"expected_in_top{k}"] == e["expected_total"]
            ),
            "bad_in_top": bad_hits,
            "items_touched_by_bad": sum(1 for e in per_item if e[f"bad_in_top{k}"] > 0),
        }
    return summary, per_item


# --------------------------------------------------------------------------------------- scale

def contract_parts(text):
    """Split a frozen contract string back into its parts. Separator is U+00B7 MIDDLE DOT."""
    return [p.strip() for p in text.split("·")]


def build_synthetic(size, seed, corpus_items):
    """Deterministic recombination of the frozen attribute vocabulary.

    Vocabulary comes ONLY from the frozen corpus contract strings; no attribute is invented and
    no label is derived here. Synthetic output is never used to set a threshold.
    """
    rng = np.random.default_rng(seed)
    parts = [contract_parts(item["embeddingText"]) for item in corpus_items]
    names = sorted({p[0] for p in parts})
    categories = sorted({p[1] for p in parts})
    subcategories = sorted({p[2] for p in parts})
    colours = sorted({p[3] for p in parts})
    hexes = sorted({t for p in parts for t in p if t.startswith("#")})
    patterns = sorted({p[-3] for p in parts})
    materials = sorted({p[-2] for p in parts})

    texts = []
    for index in range(size):
        name = f"{names[int(rng.integers(len(names)))]} {index}"
        category = categories[int(rng.integers(len(categories)))]
        subcategory = subcategories[int(rng.integers(len(subcategories)))]
        primary = colours[int(rng.integers(len(colours)))]
        secondary = [colours[int(rng.integers(len(colours)))]]
        hexes_used = [hexes[int(rng.integers(len(hexes)))], hexes[int(rng.integers(len(hexes)))]]
        pattern = patterns[int(rng.integers(len(patterns)))]
        material = materials[int(rng.integers(len(materials)))]
        description = (
            f"An adult {primary} {subcategory} in {material} with a {pattern} finish, "
            f"{category} item number {index}."
        )
        texts.append(
            separator_join_parts(
                [name, category, subcategory, primary, *secondary, *hexes_used, pattern, material, description]
            )
        )
    return texts


def scale_report(encoder, size, seed, threads, corpus_items, queries=50):
    texts = build_synthetic(size, seed, corpus_items)
    rss_before = rss_bytes()
    started = time.perf_counter()
    vectors, norms = encoder.embed(texts, batch_size=16)
    wall = time.perf_counter() - started
    after_norms = np.linalg.norm(vectors, axis=1)

    sample = np.linspace(0, size - 1, min(queries, size), dtype=int)
    similarity = cosine_matrix(vectors)
    top_k = min(8, size - 1)
    cat_hits, colour_hits, collapse = 0, 0, 0
    category_counts = Counter(contract_parts(t)[1] for t in texts)
    colour_counts = Counter(contract_parts(t)[3] for t in texts)
    cat_baseline = sum((c / size) ** 2 for c in category_counts.values())
    colour_baseline = sum((c / size) ** 2 for c in colour_counts.values())

    for index in sample:
        scores = similarity[index].copy()
        scores[index] = -2.0
        for j in np.argsort(-scores)[:top_k]:
            a, b = contract_parts(texts[index]), contract_parts(texts[j])
            if a[1] == b[1]:
                cat_hits += 1
            if a[3] == b[3]:
                colour_hits += 1
            if a[1] != b[1] and a[3] == b[3] and a[-2] == b[-2]:
                collapse += 1

    total = len(sample) * top_k
    return {
        "size": size,
        "seed": seed,
        "threads": threads,
        "embed_wall_seconds": round(wall, 2),
        "throughput_texts_per_sec": round(size / wall, 2),
        "rss_before_mib": round(rss_before / 1024 / 1024, 2),
        "peak_rss_mib": round(peak_rss_bytes() / 1024 / 1024, 2),
        "dim_ok": vectors.shape[1] == EXPECTED_DIM,
        "norm_after_max_dev": float(np.max(np.abs(after_norms - 1.0))),
        "top_k": top_k,
        "queries_sampled": len(sample),
        "category_match_in_top_k": round(cat_hits / total, 4),
        "category_match_baseline_chance": round(cat_baseline, 4),
        "category_match_lift": round(cat_hits / total - cat_baseline, 4),
        "colour_match_in_top_k": round(colour_hits / total, 4),
        "colour_match_baseline_chance": round(colour_baseline, 4),
        "colour_match_lift": round(colour_hits / total - colour_baseline, 4),
        "colour_material_only_collapse_rate": round(collapse / total, 4),
    }


def separator_join_parts(parts):
    return " · ".join(p for p in parts if len(p) > 0)


# --------------------------------------------------------------------------------------- variants

def variant_report(encoder, corpus_fixture, pairs_fixture, neighbours_fixture, threads):
    BGE_INSTRUCTION = "Represent this sentence for searching relevant passages: "
    corpus_texts = [c["embeddingText"] for c in corpus_fixture["items"]]
    corpus_ids = [c["id"] for c in corpus_fixture["items"]]
    doc_vectors, _ = encoder.embed(corpus_texts, batch_size=16)
    pair_texts = []
    for entry in pairs_fixture["pairs"]:
        pair_texts.append((entry["a"]["embeddingText"], entry["b"]["embeddingText"]))

    variants = {}
    for name, prefix in (("raw", ""), ("bge_instruction", BGE_INSTRUCTION), ("query_prefix", "query: ")):
        query_vectors, _ = encoder.embed([prefix + t for t in corpus_texts], batch_size=16)
        # The instruction/prefix belongs on the INCOMING side only; stored vectors stay raw,
        # which is how an asymmetric index would actually have to be built.
        incoming, _ = encoder.embed([prefix + a for a, _ in pair_texts], batch_size=16)
        stored, _ = encoder.embed([b for _, b in pair_texts], batch_size=16)

        scored = []
        for index, entry in enumerate(pairs_fixture["pairs"]):
            left, right = incoming[index], stored[index]
            scored.append(
                {
                    "pairId": entry["id"],
                    "class": entry["cls"],
                    "isDuplicate": entry["isDuplicate"],
                    "isStronglySimilar": entry["isStronglySimilar"],
                    "cosine": round(float(np.dot(left, right)), 6),
                }
            )
        dup = sweep(scored, "isDuplicate")
        strong = sweep(scored, "isStronglySimilar")
        dup_sep = separation_analysis(scored, "isDuplicate")
        summary, _ = neighbour_quality(corpus_ids, query_vectors, neighbours_fixture, top=(3, 8))
        variants[name] = {
            "query_prefix": prefix,
            "doc_prefix": "",
            "duplicate_auc": dup_sep["auc"],
            "duplicate_zero_fp_possible": dup_sep["zero_fp_gate_satisfiable"],
            "duplicate_min_fp_at_full_recall": dup_sep["min_false_positives_at_100pct_recall"]["fp"],
            "duplicate_best_f1": dup_sep["best_f1_score"],
            "duplicate_zero_fp_recall": dup["proposed_zero_fp_max_recall"]["recall"]
            if dup["proposed_zero_fp_max_recall"]
            else None,
            "duplicate_proposed_threshold": dup["proposed_zero_fp_max_recall"]["threshold"]
            if dup["proposed_zero_fp_max_recall"]
            else None,
            "strong_zero_fp_recall": strong["proposed_zero_fp_max_recall"]["recall"]
            if strong["proposed_zero_fp_max_recall"]
            else None,
            "strong_proposed_threshold": strong["proposed_zero_fp_max_recall"]["threshold"]
            if strong["proposed_zero_fp_max_recall"]
            else None,
            "neighbours_top8": summary["top8"],
            "neighbours_top3": summary["top3"],
        }
    return variants


# --------------------------------------------------------------------------------------- main

FIXTURES = Path(".")


def main():
    global FIXTURES
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--fixtures", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--latency-requests", type=int, default=160)
    parser.add_argument("--scale-sizes", default="100,500,1500")
    parser.add_argument("--scale-seed", type=int, default=20260904)
    args = parser.parse_args()

    FIXTURES = Path(args.fixtures)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    snapshot = (
        Path(os.environ["HF_HOME"])
        / "hub"
        / "models--BAAI--bge-small-en-v1.5"
        / "snapshots"
        / REVISION
    )

    corpus_fixture = json.loads((FIXTURES / "corpus.json").read_text(encoding="utf-8"))
    pairs_fixture = json.loads((FIXTURES / "pairs.json").read_text(encoding="utf-8"))
    neighbours_fixture = json.loads((FIXTURES / "neighbors.json").read_text(encoding="utf-8"))

    corpus_ids = [c["id"] for c in corpus_fixture["items"]]
    corpus_texts = [c["embeddingText"] for c in corpus_fixture["items"]]
    pair_texts = [entry[side]["embeddingText"] for entry in pairs_fixture["pairs"] for side in ("a", "b")]

    results = {}

    encoder, load_report = section_load(snapshot, args.threads)
    results["load"] = load_report
    (out_dir / "b1-load.json").write_text(json.dumps(load_report, indent=2), encoding="utf-8")
    print(f"[load] {load_report['load_seconds']}s peak_rss={load_report['peak_rss_mib']} MiB "
          f"params={load_report['param_count']:,}")

    contract_report, _, _ = section_contract(encoder, {"corpus": corpus_texts, "pairs": pair_texts})
    results["contract"] = contract_report
    print(f"[contract] dim={contract_report['output_dim']} finite={contract_report['all_finite']} "
          f"norm_dev={contract_report['max_abs_deviation_from_1']:.2e}")

    determinism = section_determinism(encoder, corpus_texts)
    results["determinism"] = determinism
    print(f"[determinism] exact={determinism['exact_vector_equality_repeat']} "
          f"max_abs_diff={determinism['max_abs_diff_repeat']:.2e}")

    token_lengths = encoder.token_lengths(corpus_texts) + encoder.token_lengths(pair_texts)
    tokens_report = {
        "model_max_seq_length": MODEL_MAX_SEQ,
        "corpus_tokens": describe(encoder.token_lengths(corpus_texts)),
        "all_frozen_input_tokens": describe(token_lengths),
        "max_observed": max(token_lengths),
        "any_truncated": max(token_lengths) > MODEL_MAX_SEQ,
        "longest_text_preview": max(
            zip(token_lengths, corpus_texts + pair_texts), key=lambda kv: kv[0]
        )[1][:160],
    }
    results["tokens"] = tokens_report
    print(f"[tokens] median={tokens_report['all_frozen_input_tokens']['median']} "
          f"max={tokens_report['max_observed']} truncated={tokens_report['any_truncated']}")

    latency = section_latency(encoder, corpus_texts + pair_texts[: args.latency_requests])
    results["latency"] = latency
    print(f"[latency] single p50={latency['single_request']['p50_ms']}ms "
          f"p95={latency['single_request']['p95_ms']}ms")

    unique_texts = list(dict.fromkeys(corpus_texts + pair_texts))
    vectors, norms = encoder.embed(unique_texts, batch_size=16)
    vectors_by_text = dict(zip(unique_texts, vectors))
    corpus_vectors = np.vstack([vectors_by_text[t] for t in corpus_texts])

    scored = score_pairs(pairs_fixture, vectors_by_text)
    (out_dir / "b1-pairs-scored.json").write_text(json.dumps(scored, indent=2), encoding="utf-8")
    pair_distributions = distributions(scored)
    results["pair_distributions"] = pair_distributions
    print(f"[pairs] scored={len(scored)} duplicate_positive_median="
          f"{pair_distributions['_positives_isDuplicate']['median']} "
          f"negative_max={pair_distributions['_negatives_notDuplicate']['max']}")

    duplicate_sweep = sweep(scored, "isDuplicate")
    strong_sweep = sweep(scored, "isStronglySimilar")
    thresholds = {
        "duplicate": duplicate_sweep,
        "strong_similarity": strong_sweep,
        "separation": {
            "duplicate": separation_analysis(scored, "isDuplicate"),
            "strong_similarity": separation_analysis(scored, "isStronglySimilar"),
        },
    }
    results["thresholds"] = thresholds
    separation = thresholds["separation"]["duplicate"]
    print(f"[thresholds] duplicate AUC={separation['auc']} overlap={separation['distributions_overlap']} "
          f"zero_fp_possible={separation['zero_fp_gate_satisfiable']} "
          f"min_fp_at_full_recall={separation['min_false_positives_at_100pct_recall']['fp']}")

    neighbour_summary, per_item = neighbour_quality(corpus_ids, corpus_vectors, neighbours_fixture)
    results["neighbours"] = {"summary": neighbour_summary, "items": per_item}
    print(f"[neighbours] top8 {neighbour_summary['top8']}")

    scale = {}
    for size in [int(s) for s in args.scale_sizes.split(",")]:
        scale[str(size)] = scale_report(
            encoder, size, args.scale_seed, args.threads, corpus_fixture["items"]
        )
        print(f"[scale] {size}: {scale[str(size)]['throughput_texts_per_sec']} texts/s "
              f"cat_lift={scale[str(size)]['category_match_lift']} "
              f"collapse={scale[str(size)]['colour_material_only_collapse_rate']}")
    results["scale"] = scale

    variants = variant_report(encoder, corpus_fixture, pairs_fixture, neighbours_fixture, args.threads)
    results["variants"] = variants
    print(f"[variants] {json.dumps({k: v['duplicate_proposed_threshold'] for k, v in variants.items()})}")

    (out_dir / "b1-results.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"[done] wrote {out_dir / 'b1-results.json'}")
    print(f"[final] peak_rss={peak_rss_bytes() / 1024 / 1024:.2f} MiB")


if __name__ == "__main__":
    main()