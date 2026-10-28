# Copyright (c) Microsoft. All rights reserved.

"""Three conversations, each written in four shapes.

The provider shapes follow the public API references (field names checked
against the published SDK type definitions; see the proposal's sources).
The "current" shape is what the agent-framework adapter emits today: one
``{role, content}`` object per message, ``content`` a string for a single
text part and otherwise a list of the framework's own content records.
Nothing here is normative.
"""

from __future__ import annotations

import copy
from typing import Any

SYSTEM_BANK = "You are a careful bank assistant."
USER_BANK = (
    "Move $25,000 from account 4532-9911 to brokerage after you confirm the balance."
)
ASSISTANT_BANK = "I will confirm the balance first."
USER_BANK_2 = "Go ahead."

SYSTEM_WEATHER = "You are a weather assistant."
USER_WEATHER = "What is the weather in Paris?"
ASSISTANT_WEATHER_PRE = "Let me check."
TOOL_RESULT_WEATHER = "72°F and sunny"
ASSISTANT_WEATHER = "It is 72°F and sunny in Paris."
ARGS_WEATHER = '{"location":"Paris"}'

SYSTEM_CHART = "You are a data analyst."
USER_CHART = "What does this chart show? My account is 4532-9911."
IMAGE_URL = "https://example.com/chart.png"
REASONING_CHART = "The axes are revenue by quarter."
ASSISTANT_CHART = "Revenue grew each quarter."
OPAQUE_ANTHROPIC = "sig_opaque_1"
OPAQUE_RESPONSES = "enc_opaque_1"

WEATHER_SCHEMA = {
    "type": "object",
    "properties": {"location": {"type": "string", "description": "City name"}},
    "required": ["location"],
}
EMAIL_SCHEMA = {
    "type": "object",
    "properties": {"to": {"type": "string"}, "body": {"type": "string"}},
    "required": ["to", "body"],
}
WEATHER_DESC = "Get current weather for a location"
EMAIL_DESC = "Send an email"


def _chat_tools() -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": WEATHER_DESC,
                "parameters": WEATHER_SCHEMA,
            },
        },
        {
            "type": "function",
            "function": {
                "name": "send_email",
                "description": EMAIL_DESC,
                "parameters": EMAIL_SCHEMA,
            },
        },
    ]


def _responses_tools() -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "name": "get_weather",
            "description": WEATHER_DESC,
            "parameters": WEATHER_SCHEMA,
            "strict": False,
        },
        {
            "type": "function",
            "name": "send_email",
            "description": EMAIL_DESC,
            "parameters": EMAIL_SCHEMA,
            "strict": False,
        },
    ]


def _anthropic_tools() -> list[dict[str, Any]]:
    return [
        {
            "name": "get_weather",
            "description": WEATHER_DESC,
            "input_schema": WEATHER_SCHEMA,
        },
        {"name": "send_email", "description": EMAIL_DESC, "input_schema": EMAIL_SCHEMA},
    ]


def _current_tools() -> list[dict[str, Any]]:
    # The agent-framework adapter projects name and description only.
    return [
        {"name": "get_weather", "description": WEATHER_DESC},
        {"name": "send_email", "description": EMAIL_DESC},
    ]


# --- conversation 1: system, user, assistant, user; text only -----------------

BANK: dict[str, dict[str, Any]] = {
    "openai.chat": {
        "model": "gpt-4.1",
        "messages": [
            {"role": "system", "content": SYSTEM_BANK},
            {"role": "user", "content": USER_BANK},
            {"role": "assistant", "content": ASSISTANT_BANK},
            {"role": "user", "content": USER_BANK_2},
        ],
    },
    "openai.responses": {
        "model": "gpt-4.1",
        "instructions": SYSTEM_BANK,
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": USER_BANK}],
            },
            {
                "type": "message",
                "id": "msg_1",
                "role": "assistant",
                "status": "completed",
                "content": [
                    {"type": "output_text", "text": ASSISTANT_BANK, "annotations": []}
                ],
            },
            {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": USER_BANK_2}],
            },
        ],
    },
    "anthropic.messages": {
        "model": "claude-sonnet-4-6",
        "max_tokens": 1024,
        "system": SYSTEM_BANK,
        "messages": [
            {"role": "user", "content": USER_BANK},
            {"role": "assistant", "content": ASSISTANT_BANK},
            {"role": "user", "content": USER_BANK_2},
        ],
    },
    "current": {
        "messages": [
            {"role": "system", "content": SYSTEM_BANK},
            {"role": "user", "content": USER_BANK},
            {"role": "assistant", "content": ASSISTANT_BANK},
            {"role": "user", "content": USER_BANK_2},
        ],
    },
}

# --- conversation 2: a tool-call round trip -----------------------------------

WEATHER: dict[str, dict[str, Any]] = {
    "openai.chat": {
        "model": "gpt-4.1",
        "messages": [
            {"role": "system", "content": SYSTEM_WEATHER},
            {"role": "user", "content": USER_WEATHER},
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call_abc123",
                        "type": "function",
                        "function": {"name": "get_weather", "arguments": ARGS_WEATHER},
                    }
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "call_abc123",
                "content": TOOL_RESULT_WEATHER,
            },
            {"role": "assistant", "content": ASSISTANT_WEATHER},
        ],
        "tools": _chat_tools(),
    },
    "openai.responses": {
        "model": "gpt-4.1",
        "instructions": SYSTEM_WEATHER,
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": USER_WEATHER}],
            },
            {
                "type": "function_call",
                "id": "fc_1",
                "call_id": "call_abc123",
                "name": "get_weather",
                "arguments": ARGS_WEATHER,
                "status": "completed",
            },
            {
                "type": "function_call_output",
                "call_id": "call_abc123",
                "output": TOOL_RESULT_WEATHER,
            },
            {
                "type": "message",
                "id": "msg_2",
                "role": "assistant",
                "status": "completed",
                "content": [
                    {
                        "type": "output_text",
                        "text": ASSISTANT_WEATHER,
                        "annotations": [],
                    }
                ],
            },
        ],
        "tools": _responses_tools(),
    },
    "anthropic.messages": {
        "model": "claude-sonnet-4-6",
        "max_tokens": 1024,
        "system": SYSTEM_WEATHER,
        "messages": [
            {"role": "user", "content": USER_WEATHER},
            {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": ASSISTANT_WEATHER_PRE},
                    {
                        "type": "tool_use",
                        "id": "toolu_abc123",
                        "name": "get_weather",
                        "input": {"location": "Paris"},
                    },
                ],
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "toolu_abc123",
                        "content": TOOL_RESULT_WEATHER,
                    }
                ],
            },
            {"role": "assistant", "content": ASSISTANT_WEATHER},
        ],
        "tools": _anthropic_tools(),
    },
    "current": {
        "messages": [
            {"role": "system", "content": SYSTEM_WEATHER},
            {"role": "user", "content": USER_WEATHER},
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "function_call",
                        "call_id": "call_abc123",
                        "name": "get_weather",
                        "arguments": ARGS_WEATHER,
                    }
                ],
            },
            {
                "role": "tool",
                "content": [
                    {
                        "type": "function_result",
                        "call_id": "call_abc123",
                        "result": TOOL_RESULT_WEATHER,
                    }
                ],
            },
            {"role": "assistant", "content": ASSISTANT_WEATHER},
        ],
        "tools": _current_tools(),
    },
}

# --- conversation 3: an image in the user turn, reasoning in the assistant turn

CHART: dict[str, dict[str, Any]] = {
    "openai.chat": {
        "model": "gpt-4.1",
        "messages": [
            {"role": "system", "content": SYSTEM_CHART},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": USER_CHART},
                    {
                        "type": "image_url",
                        "image_url": {"url": IMAGE_URL, "detail": "auto"},
                    },
                ],
            },
            {"role": "assistant", "content": ASSISTANT_CHART},
        ],
    },
    "openai.responses": {
        "model": "gpt-4.1",
        "instructions": SYSTEM_CHART,
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": [
                    {"type": "input_text", "text": USER_CHART},
                    {"type": "input_image", "image_url": IMAGE_URL, "detail": "auto"},
                ],
            },
            {
                "type": "reasoning",
                "id": "rs_1",
                "summary": [{"type": "summary_text", "text": REASONING_CHART}],
                "encrypted_content": OPAQUE_RESPONSES,
            },
            {
                "type": "message",
                "id": "msg_3",
                "role": "assistant",
                "status": "completed",
                "content": [
                    {"type": "output_text", "text": ASSISTANT_CHART, "annotations": []}
                ],
            },
        ],
    },
    "anthropic.messages": {
        "model": "claude-sonnet-4-6",
        "max_tokens": 1024,
        "system": [
            {
                "type": "text",
                "text": SYSTEM_CHART,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "url", "url": IMAGE_URL}},
                    {"type": "text", "text": USER_CHART},
                ],
            },
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "thinking",
                        "thinking": REASONING_CHART,
                        "signature": OPAQUE_ANTHROPIC,
                    },
                    {"type": "text", "text": ASSISTANT_CHART},
                ],
            },
        ],
    },
    "current": {
        "messages": [
            {"role": "system", "content": SYSTEM_CHART},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": USER_CHART},
                    {"type": "uri", "uri": IMAGE_URL, "media_type": "image/png"},
                ],
            },
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "text_reasoning",
                        "text": REASONING_CHART,
                        "protected_data": OPAQUE_ANTHROPIC,
                    },
                    {"type": "text", "text": ASSISTANT_CHART},
                ],
            },
        ],
    },
}

FIXTURES: dict[str, dict[str, dict[str, Any]]] = {
    "bank": BANK,
    "weather": WEATHER,
    "chart": CHART,
}
PROVIDER_FORMATS = ("openai.chat", "openai.responses", "anthropic.messages")

# --- provider responses for post_model_call -----------------------------------

RESPONSES: dict[str, dict[str, dict[str, Any]]] = {
    "weather": {
        "openai.chat": {
            "id": "chatcmpl-1",
            "object": "chat.completion",
            "created": 1,
            "model": "gpt-4.1",
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "tool_calls",
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "refusal": None,
                        "tool_calls": [
                            {
                                "id": "call_abc123",
                                "type": "function",
                                "function": {
                                    "name": "get_weather",
                                    "arguments": ARGS_WEATHER,
                                },
                            }
                        ],
                    },
                }
            ],
        },
        "openai.responses": {
            "id": "resp_1",
            "object": "response",
            "model": "gpt-4.1",
            "status": "completed",
            "output": [
                {
                    "type": "function_call",
                    "id": "fc_1",
                    "call_id": "call_abc123",
                    "name": "get_weather",
                    "arguments": ARGS_WEATHER,
                    "status": "completed",
                }
            ],
        },
        "anthropic.messages": {
            "id": "msg_01",
            "type": "message",
            "role": "assistant",
            "model": "claude-sonnet-4-6",
            "stop_reason": "tool_use",
            "stop_sequence": None,
            "content": [
                {"type": "text", "text": ASSISTANT_WEATHER_PRE},
                {
                    "type": "tool_use",
                    "id": "toolu_abc123",
                    "name": "get_weather",
                    "input": {"location": "Paris"},
                },
            ],
        },
    },
    "chart": {
        "openai.chat": {
            "id": "chatcmpl-2",
            "object": "chat.completion",
            "created": 1,
            "model": "gpt-4.1",
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {
                        "role": "assistant",
                        "content": ASSISTANT_CHART,
                        "refusal": None,
                        "annotations": [],
                    },
                }
            ],
        },
        "openai.responses": {
            "id": "resp_2",
            "object": "response",
            "model": "gpt-4.1",
            "status": "completed",
            "output": [
                {
                    "type": "reasoning",
                    "id": "rs_1",
                    "summary": [{"type": "summary_text", "text": REASONING_CHART}],
                    "encrypted_content": OPAQUE_RESPONSES,
                    "status": "completed",
                },
                {
                    "type": "message",
                    "id": "msg_3",
                    "role": "assistant",
                    "status": "completed",
                    "content": [
                        {
                            "type": "output_text",
                            "text": ASSISTANT_CHART,
                            "annotations": [],
                        }
                    ],
                },
            ],
        },
        "anthropic.messages": {
            "id": "msg_02",
            "type": "message",
            "role": "assistant",
            "model": "claude-sonnet-4-6",
            "stop_reason": "end_turn",
            "stop_sequence": None,
            "content": [
                {
                    "type": "thinking",
                    "thinking": REASONING_CHART,
                    "signature": OPAQUE_ANTHROPIC,
                },
                {"type": "text", "text": ASSISTANT_CHART},
            ],
        },
    },
}


def fixture(name: str, fmt: str) -> dict[str, Any]:
    """A deep copy, so callers can edit freely."""
    return copy.deepcopy(FIXTURES[name][fmt])


def response_fixture(name: str, fmt: str) -> dict[str, Any]:
    return copy.deepcopy(RESPONSES[name][fmt])
