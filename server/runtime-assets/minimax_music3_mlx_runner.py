"""Run MiniMax Music 3 with an optional persistent MLX worker.

The JSON-lines worker keeps the roughly 13 GB model resident between songs.  A
legacy one-shot request is retained so an older desktop shell can still use a
newer runtime asset during an in-place update.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import mlx.core as mx

from mlx_audio.audio_io import write as audio_write
from mlx_audio.music.generate import generate_music
from mlx_audio.music.models.minimax_music3 import ar as ar_runtime
from mlx_audio.music.models.minimax_music3 import minimax_music3 as music3_runtime
from mlx_audio.music.utils import load_model


EVENT_PREFIX = "YYT_MUSIC3_EVENT "


def emit(event: dict) -> None:
    print(f"{EVENT_PREFIX}{json.dumps(event, ensure_ascii=False)}", flush=True)


def fast_generate_depth_codes(language_model, depth, config, last_hidden, semantic_code, rng_key):
    """Conditional-only RVQ depth pass used by the explicit draft profile."""
    sequence = [depth.projection(last_hidden)[:, None, :]]
    code_embedding = language_model.model.embed_tokens(semantic_code + config.audio_code_offset)
    sequence.append(depth.projection(code_embedding)[:, None, :])
    codes = [semantic_code]
    hidden_parts = []
    key = rng_key
    for index in range(1, config.num_codebooks):
        hidden = depth(mx.concatenate(sequence, axis=1))[:, -1]
        hidden_parts.append(hidden)
        logits = depth.audio_heads[index - 1](hidden).astype(mx.float32)
        sampled, key = ar_runtime.sample_top_k(logits, key, ar_runtime.AR_SAMPLING_TOP_K)
        codes.append(sampled)
        if index < config.num_codebooks - 1:
            embedding = depth.audio_embeddings(sampled + (index - 1) * config.audio_vocab_size)
            sequence.append(depth.projection(embedding)[:, None, :])
    return mx.stack(codes, axis=1), mx.concatenate(hidden_parts, axis=-1), key


def fast_ar_one_frame(language_model, depth, config, last_hidden, cache, rng_key, emit_frame=True):
    """Run the draft profile without the second CFG batch in the AR models."""
    logits = ar_runtime.lm_logits(language_model, last_hidden).astype(mx.float32)
    token_ids = mx.arange(logits.shape[-1])
    allowed = mx.logical_or(
        mx.logical_and(token_ids >= config.audio_code_offset, token_ids < config.audio_code_offset + config.semantic_vocab_size),
        token_ids == config.audio_end_token_id,
    )
    logits = mx.where(allowed[None, :], logits, -1e9)
    k = min(ar_runtime.AR_CFG_TOP_K, logits.shape[-1])
    threshold = mx.min(mx.topk(logits, k, axis=-1), axis=-1, keepdims=True)
    logits = mx.where(logits < threshold, -1e9, logits)
    sampled, key = ar_runtime.sample_top_k(logits, rng_key, ar_runtime.AR_SAMPLING_TOP_K)
    if int(sampled.item()) == config.audio_end_token_id:
        return ar_runtime.ARFrame(
            semantic_code=sampled,
            residual_codes=mx.zeros((1, config.residual_codebooks), dtype=mx.int32),
            frame_hidden=mx.zeros((1, config.num_codebooks * config.hidden_size)),
            last_hidden=last_hidden, cache=cache, ended=True,
        )
    semantic_code = sampled - config.audio_code_offset
    frame_codes, depth_hidden, key = fast_generate_depth_codes(
        language_model, depth, config, last_hidden, semantic_code, key
    )
    frame_hidden = (
        ar_runtime.fuse_frame_hiddens(last_hidden, depth_hidden)
        if emit_frame else mx.zeros((1, config.num_codebooks * config.hidden_size))
    )
    feedback = ar_runtime._embed_audio_frame(language_model, depth, config, frame_codes)
    hidden, cache = ar_runtime.qwen3_hidden(language_model, feedback, cache)
    return ar_runtime.ARFrame(
        semantic_code=semantic_code, residual_codes=frame_codes[:, 1:],
        frame_hidden=frame_hidden, last_hidden=hidden[:, -1], cache=cache, ended=False,
    )


def generate_with_loaded_model(model, request: dict) -> dict:
    request_id = str(request.get("id") or "")
    started = time.perf_counter()
    stage_state = {"id": request_id, "started": started}
    original_run_flow = model._run_flow
    original_text_ids = model._text_ids
    original_ar_one_frame = ar_runtime.ar_one_frame
    original_cfg = music3_runtime.DIT_CFG_SCALE
    cfg = max(0.5, min(5.0, float(request.get("cfg", original_cfg))))
    fast_ar = bool(request.get("fastAr"))

    def logged_run_flow(frame_hiddens, num_inference_steps, seed):
        ar_seconds = time.perf_counter() - stage_state["started"]
        emit({
            "type": "stage", "id": request_id, "stage": "sample",
            "label": "自回归编曲完成，开始声学生成", "elapsedSeconds": ar_seconds,
            "frames": int(frame_hiddens.shape[1]),
        })
        audio = original_run_flow(frame_hiddens, num_inference_steps, seed)
        emit({
            "type": "stage", "id": request_id, "stage": "decode",
            "label": "声学生成完成，开始解码母带",
            "elapsedSeconds": time.perf_counter() - stage_state["started"],
        })
        return audio

    model._run_flow = logged_run_flow
    music3_runtime.DIT_CFG_SCALE = cfg
    if fast_ar:
        model._text_ids = lambda prompt, lyrics: original_text_ids(prompt, lyrics)[:1]
        ar_runtime.ar_one_frame = fast_ar_one_frame
    try:
        emit({
            "type": "stage", "id": request_id, "stage": "encode",
            "label": "开始逐帧自回归编曲", "elapsedSeconds": 0,
        })
        results = list(model.generate(
            text=str(request["caption"]),
            lyrics=str(request["lyrics"]),
            duration=float(request["duration"]),
            steps=int(request["steps"]),
            seed=int(request["seed"]),
        ))
        if not results:
            raise RuntimeError("Music generation produced no audio")
        sample_rate = results[0].sample_rate
        if any(result.sample_rate != sample_rate for result in results):
            raise ValueError("Music generation returned inconsistent sample rates")
        audio = results[0].audio if len(results) == 1 else mx.concatenate(
            [result.audio for result in results], axis=0
        )
        destination = Path(request["output"]).expanduser()
        destination.parent.mkdir(parents=True, exist_ok=True)
        emit({
            "type": "stage", "id": request_id, "stage": "save",
            "label": "写入本地音频", "elapsedSeconds": time.perf_counter() - started,
        })
        audio_write(destination, audio, sample_rate)
        final = results[-1]
        elapsed = time.perf_counter() - started
        actual_duration = sum(result.samples for result in results) / sample_rate
        return {
            "elapsedSeconds": elapsed,
            "modelSeconds": float(final.processing_time_seconds or elapsed),
            "actualDuration": actual_duration,
            "realTimeFactor": elapsed / max(actual_duration, 1e-9),
            "peakMemoryGb": float(final.peak_memory_usage or 0),
            "steps": int(request["steps"]),
            "cfg": cfg,
            "fastAr": fast_ar,
            "requestedDuration": float(request["duration"]),
        }
    finally:
        model._run_flow = original_run_flow
        model._text_ids = original_text_ids
        ar_runtime.ar_one_frame = original_ar_one_frame
        music3_runtime.DIT_CFG_SCALE = original_cfg


def run_worker(model_path: Path) -> None:
    load_started = time.perf_counter()
    emit({"type": "loading", "label": "正在载入 MiniMax Music 3 MXFP8 权重"})
    model = load_model(model_path)
    emit({
        "type": "ready", "label": "MiniMax Music 3 MLX 常驻引擎已就绪",
        "loadSeconds": time.perf_counter() - load_started,
    })
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        request_id = ""
        try:
            request = json.loads(line)
            request_id = str(request.get("id") or "")
            if request.get("op") == "shutdown":
                emit({"type": "stopped", "label": "常驻引擎已释放"})
                return
            metrics = generate_with_loaded_model(model, request)
            emit({"type": "result", "id": request_id, "ok": True, "metrics": metrics})
        except Exception as error:
            emit({
                "type": "result", "id": request_id, "ok": False,
                "error": f"{type(error).__name__}: {error}",
            })


def run_one_shot(request_path: Path) -> None:
    request = json.loads(request_path.read_text(encoding="utf-8"))
    generate_music(
        caption=str(request["caption"]),
        lyrics=str(request["lyrics"]),
        model=Path(request["model"]),
        duration=float(request["duration"]),
        steps=int(request["steps"]),
        seed=int(request["seed"]),
        output_path=Path(request["output"]),
        verbose=True,
    )


def main() -> None:
    if len(sys.argv) == 3 and sys.argv[1] == "--worker":
        run_worker(Path(sys.argv[2]).resolve())
        return
    if len(sys.argv) == 2:
        run_one_shot(Path(sys.argv[1]).resolve())
        return
    raise SystemExit("usage: minimax_music3_mlx_runner.py REQUEST.json | --worker MODEL_DIR")


if __name__ == "__main__":
    main()
