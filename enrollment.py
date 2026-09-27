from __future__ import annotations

import hashlib
import json
import math
import os
import random
import re
import secrets
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

from fingerprint import analyze_global_outputs, generate_challenges, parse_numbers
from bank_builder import build_bank, read_rows
from challenge_suite import fingerprint_suite


PROJECT = Path(__file__).resolve().parent
DATA_FILE = PROJECT / "data" / "gpt_reference.jsonl"
BANK_FILE = PROJECT / "data" / "gpt_bank.json"

# urllib 默认的 Python-urllib User-Agent 会被 Cloudflare/WAF 网关直接拦成 403，
# 因此伪装成真实客户端（与 gpt56 检测器使用的 UA 一致）。
DEFAULT_UPSTREAM_USER_AGENT = (
    "codex-tui/0.156.1 (Windows 10.0.19044; x86_64) WindowsTerminal "
    "(codex-tui; 0.156.1)"
)
DEFAULT_ORIGINATOR = "codex-tui"
DEFAULT_CODEX_VERSION = "0.156.1"
# Responses 端点需要 SSE；带上流式请求头与服务端要求的 beta 特性，否则网关会返回空体
CODEX_BETA_FEATURES = "prevent_idle_sleep,remote_compaction_v2"
RETRYABLE_STATUS = {408, 429, 500, 502, 503, 504}
# 400/422 属于"参数被拒"：中转站拒绝非流式请求时就用这两个码，因此升级为流式再试一次。
# 判定只看状态码，不匹配第三方网关的具体文案（措辞不可穷举，且"200 + 空体"根本无码可认）。
STREAM_REQUIRED_STATUS = {400, 422}
MAX_ATTEMPTS = 3
RETRY_BASE_DELAY = 1.0

# 端点格式探测结果缓存：(base_url, api_key 摘要) -> "responses" | "anthropic" | "openai"。
# 没有它时，前端每轮测试的每个挑战都会把三种格式重新探一遍，一次测试最多打 18 次上游请求。
FORMAT_CACHE: dict[tuple[str, str], str] = {}


def upstream_user_agent() -> str:
    override = (
        os.environ.get("MODELTRACE_USER_AGENT")
        or os.environ.get("GPT56_USER_AGENT")
        or ""
    ).strip()
    return override or DEFAULT_UPSTREAM_USER_AGENT


def bank_summary(bank: dict) -> dict:
    return {
        "model_count": len(bank["models"]),
        "response_count": sum(model["response_count"] for model in bank["models"]),
        "number_count": sum(model["valid_number_count"] for model in bank["models"]),
        "models": [
            {
                "id": model["id"],
                "display_name": model["display_name"],
                "responses": model["response_count"],
                "valid_numbers": model["valid_number_count"],
            }
            for model in bank["models"]
        ],
    }


def make_row(
    model_label: str,
    text: str,
    condition: str,
    challenge_id: str,
    expected_count: int = 0,
    temperature: str | float = "unknown",
    bank_id: str = "reference-bank",
    wrapper_transport: str | None = None,
    provider: str = "api",
    prompt: str | None = None,
    base_prompt: str | None = None,
    system_prompt: str | None = None,
    user_prefix: str | None = None,
) -> dict:
    numbers = parse_numbers(text)
    threshold = max(80, math.ceil(expected_count * 0.55)) if expected_count else 80
    row_id = f"{condition}-{secrets.token_hex(8)}"
    return {
        "row_id": row_id,
        "parent_row_id": row_id,
        "bank_id": bank_id,
        "source": model_label,
        "model_id": model_label,
        "exact_version": model_label,
        "condition_id": condition,
        "nuisance_condition_id": condition,
        "wrapper_id": condition,
        "wrapper_transport": wrapper_transport or ("manual_import" if condition == "manual" else "clean"),
        "provider": "manual" if condition == "manual" else provider,
        "challenge_id": challenge_id,
        "task_index": 0,
        "requested_count": expected_count,
        "parsed_count": len(numbers),
        "strict_threshold": threshold,
        "strict_valid": len(numbers) >= threshold,
        "temperature": temperature,
        "config_id": "enrollment",
        "prompt": prompt,
        "base_prompt": base_prompt,
        "system_prompt": system_prompt,
        "user_prefix": user_prefix,
        "text": text,
        "error": None,
        "collected_at": datetime.now(timezone.utc).isoformat(),
    }


def append_rows(rows: list[dict], data_file: Path = DATA_FILE) -> None:
    with data_file.open("a", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def rebuild_bank(data_file: Path = DATA_FILE, bank_file: Path = BANK_FILE) -> dict:
    previous = json.loads(bank_file.read_text(encoding="utf-8")) if bank_file.exists() else None
    bank = build_bank(read_rows(data_file), previous["calibration"] if previous else None)
    bank_file.write_text(json.dumps(bank, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return bank


def enroll_manual(
    model_label: str,
    pasted: str,
    data_file: Path = DATA_FILE,
    bank_file: Path = BANK_FILE,
    bank_id: str = "reference-bank",
) -> dict:
    blocks = [
        block.strip()
        for block in re.split(r"(?m)^\s*===OUTPUT===\s*$", pasted)
        if block.strip()
    ]
    rows = [
        make_row(
            model_label=model_label,
            text=block,
            condition="manual",
            challenge_id=f"manual-{secrets.token_hex(6)}",
            bank_id=bank_id,
        )
        for block in blocks
    ]
    accepted = [row for row in rows if row["strict_valid"]]
    append_rows(accepted, data_file)
    bank = rebuild_bank(data_file, bank_file)
    return {
        "submitted": len(rows),
        "accepted": len(accepted),
        "rejected": len(rows) - len(accepted),
        "parsed_numbers": [row["parsed_count"] for row in rows],
        "bank": bank_summary(bank),
    }


def is_absolute_endpoint(normalized: str) -> bool:
    """末尾带 # 表示用户已给出完整端点，不要再拼任何路径。"""
    return normalized.endswith("#")


def auto_formats(normalized: str) -> tuple[str, ...]:
    """auto 探测顺序：Responses > Anthropic > Chat。
    用户端点以某种格式的路径结尾时，先试该格式，避免打一堆必然 404 的请求。"""
    if is_absolute_endpoint(normalized):
        return ()
    if normalized.endswith("/messages"):
        return ("anthropic", "responses", "openai")
    if normalized.endswith("/responses"):
        return ("responses", "anthropic", "openai")
    return ("responses", "anthropic", "openai")


def completion_url(base_url: str, api_format: str = "openai") -> str:
    normalized = base_url.rstrip("/")
    # 末尾 # 表示“已是完整端点，不要再拼路径”，去掉 # 后原样使用
    if is_absolute_endpoint(normalized):
        return normalized[:-1]
    if api_format == "anthropic":
        if normalized.endswith("/messages"):
            return normalized
        if normalized.endswith("/v1"):
            return normalized + "/messages"
        return normalized + "/v1/messages"
    if api_format == "responses":
        # Codex 的端点是 {base}/responses，不带 /v1（实测 /v1/responses 一律 403）
        if normalized.endswith("/responses"):
            return normalized
        return normalized + "/responses"
    if normalized.endswith("/chat/completions"):
        return normalized
    if normalized.endswith("/v1"):
        return normalized + "/chat/completions"
    return normalized + "/v1/chat/completions"


class UpstreamError(RuntimeError):
    """上游返回的错误，保留状态码与响应体供前端留档。"""

    def __init__(self, message: str, status: int, body: str) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


def list_models(base_url: str, api_key: str) -> list[str]:
    """拉取上游 /models 列表，供模型名自动补全。失败时抛 UpstreamError。"""
    if not base_url:
        raise ValueError("请先填写 Base URL")
    normalized = base_url.rstrip("/")
    if is_absolute_endpoint(normalized):
        normalized = normalized[:-1]
    # /models 属于 OpenAI 风格路径；Codex 的 /responses 端点没有它，回退到去掉末尾端点段
    if normalized.endswith("/responses"):
        normalized = normalized[: -len("/responses")]
    url = normalized + "/models" if normalized.endswith("/v1") else normalized + "/v1/models"
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Accept": "application/json",
            "User-Agent": upstream_user_agent(),
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace").strip()
        raise UpstreamError(f"HTTP {error.code}: {_compact_upstream_error(body, error.reason)}", error.code, body) from error
    except urllib.error.URLError as error:
        reason = getattr(error, "reason", str(error))
        raise UpstreamError(f"无法连接接口：{reason}", 0, str(reason)) from error
    items = payload.get("data") if isinstance(payload, dict) else None
    if items is None:
        items = payload.get("models") if isinstance(payload, dict) else None
    if not isinstance(items, list):
        raise UpstreamError("上游返回中没有模型列表", 200, json.dumps(payload, ensure_ascii=False)[:500])
    return sorted(
        str(item.get("id") or item.get("name"))
        for item in items
        if isinstance(item, dict) and (item.get("id") or item.get("name"))
    )


def _looks_like_waf_block(text: str) -> bool:
    lowered = text.lower()
    return any(
        marker in lowered
        for marker in ("cloudflare", "just a moment", "cf-ray", "access denied", "attention required")
    )


def _compact_upstream_error(details: str, fallback: str) -> str:
    text = (details or fallback or "").strip()
    if not text:
        return "上游接口返回错误"
    if _looks_like_waf_block(text):
        return (
            "请求被上游网关拦截（Cloudflare/WAF 拦截页）。"
            "请确认 base_url 指向 API 端点而非网页地址、API Key 有效，"
            "或该服务是否限制当前网络/IP"
        )
    if text.startswith("<") or "{" not in text and "html" in text.lower():
        return text[:200]
    try:
        payload = json.loads(text)
        if isinstance(payload, dict):
            error = payload.get("error")
            if isinstance(error, dict):
                return str(error.get("message") or error)
            if error:
                return str(error)
            return json.dumps(payload, ensure_ascii=False)[:500]
    except (json.JSONDecodeError, TypeError, ValueError):
        pass
    return text[:500]


def iter_sse_events(raw: str):
    """逐条产出 SSE 事件对象，非 data 行与坏帧直接跳过。"""
    for line in raw.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if not data or data == "[DONE]":
            continue
        try:
            event = json.loads(data)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            yield event


def aggregate_responses_sse(text: str) -> dict | None:
    """把 Responses 的 SSE 帧聚合成一个完整响应对象。

    优先取 response.completed 里的完整对象；只有增量帧时按 output_text.delta 拼接，
    并保留 response.failed / error 事件，供上层识别流内错误后换格式。
    """
    result = None
    deltas: list[str] = []
    failure = None
    for event in iter_sse_events(text):
        if event.get("type") == "response.completed" and isinstance(event.get("response"), dict):
            return event["response"]
        if event.get("type") in {"response.failed", "error"} or event.get("error"):
            failure = event
        if isinstance(event.get("response"), dict) and event["response"].get("output"):
            result = event["response"]
        if event.get("type") == "response.output_text.delta" and isinstance(event.get("delta"), str):
            deltas.append(event["delta"])
    if result is not None:
        return result
    if deltas:
        # 增量帧没有完整 output，按 Responses 的形状手工组装，交给 extract_text 走同一条路径
        return {
            "status": "completed",
            "output": [
                {
                    "type": "message",
                    "content": [{"type": "output_text", "text": "".join(deltas)}],
                }
            ],
        }
    if failure is not None:
        # 把流内错误包装成可读异常，避免退化成"上游返回中没有文本内容"
        detail = failure.get("error") or failure
        if isinstance(detail, dict):
            detail = detail.get("message") or json.dumps(detail, ensure_ascii=False)
        raise RuntimeError(f"上游在流中返回错误：{detail}")
    return None


def aggregate_anthropic_sse(text: str) -> dict | None:
    """聚合 Anthropic 的 SSE 帧：content_block_delta 拼正文，message_delta 取 stop_reason。"""
    parts: list[str] = []
    stop_reason = None
    seen = False
    for event in iter_sse_events(text):
        seen = True
        event_type = event.get("type")
        if event_type == "error":
            detail = event.get("error") or {}
            message = detail.get("message") if isinstance(detail, dict) else detail
            raise RuntimeError(f"上游在流中返回错误：{message or json.dumps(event, ensure_ascii=False)}")
        if event_type == "content_block_delta":
            delta = event.get("delta") or {}
            if isinstance(delta.get("text"), str):
                parts.append(delta["text"])
        if event_type == "message_delta":
            delta = event.get("delta") or {}
            if delta.get("stop_reason"):
                stop_reason = delta["stop_reason"]
    if not seen:
        return None
    payload: dict = {"content": [{"type": "text", "text": "".join(parts)}]}
    if stop_reason:
        # 保留 stop_reason，截断样本才会被上层拒收
        payload["stop_reason"] = stop_reason
    return payload


def aggregate_openai_sse(text: str) -> dict | None:
    """聚合 OpenAI Chat 的 SSE 帧：choices[0].delta.content 拼正文，末帧取 finish_reason。"""
    parts: list[str] = []
    finish_reason = None
    seen = False
    for event in iter_sse_events(text):
        seen = True
        if event.get("error"):
            detail = event["error"]
            message = detail.get("message") if isinstance(detail, dict) else detail
            raise RuntimeError(f"上游在流中返回错误：{message or json.dumps(event, ensure_ascii=False)}")
        choices = event.get("choices")
        if not isinstance(choices, list) or not choices:
            continue
        choice = choices[0] or {}
        delta = choice.get("delta") or {}
        if isinstance(delta.get("content"), str):
            parts.append(delta["content"])
        if choice.get("finish_reason"):
            finish_reason = choice["finish_reason"]
    if not seen:
        return None
    message: dict = {"content": "".join(parts)}
    choice_out: dict = {"message": message}
    if finish_reason:
        # 保留 finish_reason，length/content_filter 仍会被上层拒收
        choice_out["finish_reason"] = finish_reason
    return {"choices": [choice_out]}


SSE_AGGREGATORS = {
    "responses": aggregate_responses_sse,
    "anthropic": aggregate_anthropic_sse,
    "openai": aggregate_openai_sse,
}


def parse_completion_payload(api_format: str, raw: str, content_type: str = "") -> dict:
    """按响应形态决定解析方式：SSE 走聚合器，整包 JSON 直接 loads。

    用 Content-Type 而非"首字符是不是 {"来判定，因为上游可能忽略 stream 参数回整包 JSON，
    也可能在非流式下回 SSE；两种都要吃下。
    """
    text = raw.lstrip()
    if text.startswith("{"):
        return json.loads(text)
    if "text/event-stream" in (content_type or "").lower() or text.startswith("data:") or text.startswith("event:"):
        aggregated = SSE_AGGREGATORS[api_format](text)
        if aggregated is not None:
            return aggregated
        raise RuntimeError("上游返回的流中没有可用事件：" + raw[:300])
    raise RuntimeError("上游返回的不是可解析的响应：" + raw[:300])


def _emit(on_event, **event) -> None:
    """把探测进度推给订阅者（前端 SSE 端点卡片）；没有订阅者时是空操作。"""
    if on_event:
        on_event(event)


def _request_completion(
    base_url: str,
    api_key: str,
    api_model: str,
    prompt: str,
    temperature: float | None,
    api_format: str,
    system_prompt: str = "",
    on_event=None,
) -> str:
    if api_format == "anthropic":
        body_data = {
            "model": api_model,
            "max_tokens": 4096,
            "messages": [{"role": "user", "content": prompt}],
        }
        if system_prompt:
            body_data["system"] = system_prompt
        headers = {
            "x-api-key": api_key,
            "Authorization": f"Bearer {api_key}",
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": upstream_user_agent(),
        }
    elif api_format == "responses":
        # Codex 的 Responses 端点会校验请求是否来自真实客户端，缺 client_metadata 时
        # 一律返回 codex_access_restricted 403。实测最小通过集合是本条 body（约 450B）：
        # 身份值全部用随机 UUID 即可，无需伪造真实客户端的安装标识。
        session_id = str(uuid.uuid4())
        body_data = {
            "model": api_model,
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": prompt}],
                }
            ],
            "client_metadata": {
                "x-codex-installation-id": str(uuid.uuid4()),
                "x-codex-window-id": f"{session_id}:0",
                "session_id": session_id,
                "thread_id": session_id,
                "turn_id": str(uuid.uuid4()),
            },
        }
        if system_prompt:
            body_data["instructions"] = system_prompt
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": upstream_user_agent(),
            "originator": DEFAULT_ORIGINATOR,
            "version": DEFAULT_CODEX_VERSION,
            "x-codex-beta-features": CODEX_BETA_FEATURES,
        }
    else:
        body_data = {
            "model": api_model,
            "messages": [
                *([{"role": "system", "content": system_prompt}] if system_prompt else []),
                {"role": "user", "content": prompt},
            ],
        }
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": upstream_user_agent(),
        }
    if temperature is not None:
        body_data["temperature"] = temperature
    url = completion_url(base_url, api_format)
    payload = None
    content_type = ""
    # 是否已升级为流式请求：400/422 或 200+空体说明该站拒绝非流式
    streaming = False
    for attempt in range(1, MAX_ATTEMPTS + 1):
        # 第 3 次无条件走流式兜底：前两次失败原因不可预测时也给流式一次机会
        if attempt >= MAX_ATTEMPTS:
            streaming = True
        body_data["stream"] = streaming
        body = json.dumps(body_data).encode("utf-8")
        request = urllib.request.Request(url, data=body, headers=headers, method="POST")
        started = time.monotonic()

        def log_upstream(outcome: str) -> None:
            """统一上游请求日志格式：格式/端点/模型/次数 + 结果 + 耗时。"""
            print(
                f"[上游请求] {api_format} POST {url} model={api_model} "
                f"attempt={attempt} stream={streaming} {outcome} "
                f"耗时={time.monotonic() - started:.2f}s",
                flush=True,
            )

        try:
            with urllib.request.urlopen(request, timeout=240) as response:
                status = response.status
                content_type = response.headers.get("Content-Type", "")
                raw = response.read().decode("utf-8")
            log_upstream(f"status={status} bytes={len(raw)}")
            try:
                payload = parse_completion_payload(api_format, raw, content_type)
            except (RuntimeError, json.JSONDecodeError) as error:
                # 200 也可能是网关的"非流式不支持"回落（空体或 HTML）。升级为流式再试，
                # 这条路径覆盖了没有 400 可识别的失败模式。
                if not streaming and attempt < MAX_ATTEMPTS:
                    log_upstream(f"200 但解析失败，升级为流式重试：{error}")
                    _emit(on_event, phase="attempt", api_format=api_format, attempt=attempt,
                          status=status, body=raw[:2000], ok=False, done=False, stream=streaming)
                    streaming = True
                    time.sleep(RETRY_BASE_DELAY * attempt + random.uniform(0, 0.5))
                    continue
                raise
            # ok 事件在拿到可解析正文后才推，避免"200 但空体"被前端当作成功
            _emit(on_event, phase="attempt", api_format=api_format, attempt=attempt,
                  status=status, body="", ok=True, done=True, stream=streaming)
            break
        except urllib.error.HTTPError as error:
            details = error.read().decode("utf-8", errors="replace").strip()
            message = _compact_upstream_error(details, error.reason)
            retried = f"（已自动重试 {attempt - 1} 次）" if attempt > 1 else ""
            log_upstream(f"status={error.code} body={details[:500]}")
            # 400/422 视为"拒绝当前请求形态"：升级为流式重试，而不是立刻换格式
            upgrade = (
                not streaming
                and error.code in STREAM_REQUIRED_STATUS
                and attempt < MAX_ATTEMPTS
            )
            will_retry = attempt < MAX_ATTEMPTS and error.code in RETRYABLE_STATUS
            # 每次尝试都推一条，前端据此就地刷新该端点的卡片
            _emit(on_event, phase="attempt", api_format=api_format, attempt=attempt,
                  status=error.code, body=details, ok=False, done=not (will_retry or upgrade),
                  stream=streaming)
            if upgrade:
                streaming = True
                time.sleep(RETRY_BASE_DELAY * attempt + random.uniform(0, 0.5))
                continue
            if will_retry:
                time.sleep(RETRY_BASE_DELAY * attempt + random.uniform(0, 0.5))
                continue
            raise UpstreamError(
                f"HTTP {error.code}: {message}{retried}", error.code, details
            ) from error
        except urllib.error.URLError as error:
            reason = getattr(error, "reason", str(error))
            log_upstream(f"无法连接 reason={reason}")
            will_retry = attempt < MAX_ATTEMPTS
            _emit(on_event, phase="attempt", api_format=api_format, attempt=attempt,
                  status=0, body=str(reason), ok=False, done=not will_retry, stream=streaming)
            if will_retry:
                time.sleep(RETRY_BASE_DELAY * attempt + random.uniform(0, 0.5))
                continue
            retried = f"（已自动重试 {attempt - 1} 次）" if attempt > 1 else ""
            raise UpstreamError(f"无法连接接口：{reason}{retried}", 0, str(reason)) from error
    # 200 也可能是中转站的错误体。以下三处形状不符统一抛 UpstreamError，
    # 把状态码与响应体带到前端，避免只剩一句无从下手的 KeyError。
    body_text = json.dumps(payload, ensure_ascii=False)
    if api_format == "anthropic":
        blocks = payload.get("content") if isinstance(payload, dict) else None
        if not blocks:
            raise UpstreamError("上游返回中没有 content", status, body_text)
        content = "".join(
            block.get("text", "")
            for block in blocks
            if block.get("type") == "text"
        )
        stop_reason = payload.get("stop_reason")
        if stop_reason == "refusal":
            raise RuntimeError("模型拒绝生成，本次回答不计入")
        if stop_reason == "max_tokens":
            raise RuntimeError("回答因 max_tokens 截断，本次回答不计入")
    elif api_format == "responses":
        # Responses API：正文在 output 数组的 message 类型条目里，文本在 output_text
        content = "".join(
            block.get("text", "")
            for block in payload.get("output") or []
            if block.get("type") == "message"
            for block in (block.get("content") or [])
            if block.get("type") == "output_text"
        )
        if payload.get("status") == "incomplete":
            detail = payload.get("incomplete_details") or {}
            reason = detail.get("reason") or "上游返回不完整"
            raise RuntimeError(f"回答未正常完成（{reason}），本次回答不计入")
        if not content:
            raise UpstreamError("上游返回中没有文本内容", status, body_text)
    else:
        choices = payload.get("choices") if isinstance(payload, dict) else None
        if not choices:
            raise UpstreamError("上游返回中没有 choices", status, body_text)
        choice = choices[0]
        content = choice["message"]["content"]
        if isinstance(content, list):
            content = "".join(part.get("text", "") for part in content)
        if choice.get("finish_reason") in {"length", "content_filter"}:
            raise RuntimeError(f"回答未正常完成（{choice['finish_reason']}），本次回答不计入")
    return str(content)


def detection_cache_key(base_url: str, api_key: str) -> tuple[str, str]:
    """探测结果的缓存键。api_key 用摘要而非明文，避免在常驻进程里长期留存原始密钥。"""
    return base_url.rstrip("/"), hashlib.sha256(api_key.encode("utf-8")).hexdigest()


def cached_format(base_url: str, api_key: str) -> str | None:
    """返回已探测成功并缓存的接口格式；未探测过时为 None。"""
    return FORMAT_CACHE.get(detection_cache_key(base_url, api_key))


def request_completion(
    base_url: str,
    api_key: str,
    api_model: str,
    prompt: str,
    temperature: float | None,
    api_format: str = "auto",
    system_prompt: str = "",
    on_event=None,
) -> str:
    if api_format != "auto":
        return _request_completion(
            base_url, api_key, api_model, prompt, temperature, api_format, system_prompt, on_event
        )
    # 这里用 # 判断一次：若 base_url 末尾带 #，就是某个格式的完整端点，只按该格式请求一次
    endpoint = base_url.rstrip("/")
    if is_absolute_endpoint(endpoint):
        return _request_completion(
            base_url, api_key, api_model, prompt, temperature, "openai", system_prompt, on_event
        )
    # 端点类型只探测一次：命中缓存就直连，命中后失败才失效重探（上游可能换了协议）
    key = detection_cache_key(base_url, api_key)
    formats = auto_formats(endpoint)
    known = FORMAT_CACHE.get(key)
    if known:
        formats = (known, *(candidate for candidate in formats if candidate != known))
    errors = []
    for candidate in formats:
        _emit(on_event, phase="probe_start", api_format=candidate)
        try:
            text = _request_completion(
                base_url, api_key, api_model, prompt, temperature, candidate, system_prompt, on_event
            )
        except RuntimeError as error:
            errors.append(f"{candidate}: {error}")
            _emit(on_event, phase="probe_end", api_format=candidate, ok=False)
        except (KeyError, IndexError, TypeError, ValueError) as error:
            # 上游返回形状不符时也可能抛这些，绝不能中断后续格式的探测
            errors.append(f"{candidate}: 响应解析失败（{type(error).__name__}: {error}）")
            _emit(on_event, phase="probe_end", api_format=candidate, ok=False)
        else:
            FORMAT_CACHE[key] = candidate
            _emit(on_event, phase="probe_end", api_format=candidate, ok=True)
            return text
    FORMAT_CACHE.pop(key, None)
    raise RuntimeError("接口格式自动探测失败；" + "；".join(errors))


def test_automatic(
    base_url: str,
    api_key: str,
    api_model: str,
    temperature: float | None,
    bank: dict,
    api_format: str = "openai",
) -> dict:
    target_count = 3
    max_attempts = 6
    challenges = generate_challenges(max_attempts)
    outputs = []
    errors = []
    for challenge in challenges:
        try:
            text = request_completion(
                base_url,
                api_key,
                api_model,
                challenge["prompt"],
                temperature,
                api_format,
            )
            minimum = max(80, math.ceil(challenge["expected_count"] * 0.55))
            parsed_count = len(parse_numbers(text))
            if parsed_count >= minimum:
                outputs.append(
                    {
                        "text": text,
                        "expected_count": challenge["expected_count"],
                    }
                )
            else:
                errors.append(f"有效数字不足：{parsed_count}/{minimum}")
        except Exception as error:
            errors.append(str(error))
        if len(outputs) == target_count:
            break
    result = analyze_global_outputs(outputs, bank)
    result["api_test"] = {
        "requested": target_count,
        "attempted": len(outputs) + len(errors),
        "max_attempts": max_attempts,
        "received": len(outputs),
        "errors": errors,
    }
    return result


def enroll_automatic(
    base_url: str,
    api_key: str,
    api_model: str,
    model_label: str,
    sample_count: int,
    temperature: float | None,
    api_format: str = "openai",
    data_file: Path = DATA_FILE,
    bank_file: Path = BANK_FILE,
    bank_id: str = "reference-bank",
    provider: str = "api",
) -> dict:
    suite = fingerprint_suite()
    if sample_count < 3 or sample_count > len(suite):
        raise ValueError(f"采集回答数必须在 3 到 {len(suite)} 之间")
    selected = [suite[int(index * len(suite) / sample_count)] for index in range(sample_count)]
    rows = []
    errors = []

    def collect(task: dict) -> tuple[dict | None, list[str]]:
        task_errors = []
        base_prompt = task["prompt"]
        prompt = base_prompt
        if task["user_prefix"]:
            prompt = task["user_prefix"] + "\n\nFinal task:\n" + prompt
        system_prompt = task["system"]
        for _ in range(2):
            try:
                text = request_completion(
                    base_url,
                    api_key,
                    api_model,
                    prompt,
                    temperature,
                    api_format,
                    system_prompt,
                )
                row = make_row(
                    model_label=model_label,
                    text=text,
                    condition=task["condition"],
                    challenge_id=task["challenge_id"],
                    expected_count=task["expected_count"],
                    temperature=temperature if temperature is not None else "provider_default",
                    bank_id=bank_id,
                    wrapper_transport=task["transport"],
                    provider=provider,
                    prompt=prompt,
                    base_prompt=base_prompt,
                    system_prompt=system_prompt,
                    user_prefix=task["user_prefix"],
                )
                if row["strict_valid"]:
                    return row, task_errors
                task_errors.append(
                    f"{task['challenge_id']} 有效数字不足：{row['parsed_count']}/{row['strict_threshold']}"
                )
            except Exception as error:
                task_errors.append(f"{task['challenge_id']}: {error}")
        return None, task_errors

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(collect, task) for task in selected]
        for future in as_completed(futures):
            row, task_errors = future.result()
            errors.extend(task_errors)
            if row is not None:
                rows.append(row)
    accepted = [row for row in rows if row["strict_valid"]]
    if not accepted:
        raise ValueError("没有获得可用回答，指纹库未修改")
    append_rows(accepted, data_file)
    bank = rebuild_bank(data_file, bank_file)
    return {
        "requested": sample_count,
        "received": len(accepted),
        "accepted": len(accepted),
        "rejected": sample_count - len(accepted),
        "errors": errors,
        "bank": bank_summary(bank),
    }
