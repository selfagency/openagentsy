#!/usr/bin/env python3
"""Generate the footprint golden data from the EcoLogits library, offline.

The EcoLogits package carries the model and electricity-mix data it needs, so
this runs without a network. What it writes is computed results, not EcoLogits
data files: the model map itself is never bundled in this repository, because
its license is unverified.

Run it with an interpreter that has ecologits installed:

    python3 scripts/golden.py
"""

from __future__ import annotations

import json
import os
import sys
from importlib.metadata import version

# The release the numbers in data/SOURCES.md were taken from. A different
# release may compute different numbers, so the script refuses to run and
# the pin is moved on purpose.
PINNED_ECOLOGITS = "0.11.3"

# provider, model, output tokens, tokens per second, time to first token.
PAIRS = [
    ("anthropic", "claude-haiku-4-5-20251001", 400, 79.0, 0.4),
    ("anthropic", "claude-haiku-5-5", 1200, 147.0, 0.3),
    ("openai", "gpt-4o-mini", 500, 79.0, 0.3),
    ("openai", "gpt-4.1-mini", 2000, 79.0, 0.5),
    ("openai", "gpt-4.1-nano", 800, 83.0, 0.2),
    ("openai", "gpt-5-nano", 300, 62.5, 0.4),
    ("openai", "gpt-5-mini", 2500, 101.0, 0.6),
    ("openai", "o3-mini", 1500, 142.0, 0.7),
    ("mistralai", "codestral-2508", 1000, 98.0, 0.3),
    ("mistralai", "ministral-3b-2512", 600, 131.0, 0.2),
    ("mistralai", "ministral-8b-2512", 1100, 81.5, 0.3),
    ("mistralai", "ministral-14b-2512", 1800, 77.0, 0.4),
    ("mistralai", "mistral-medium-3", 3000, 78.5, 0.8),
    ("cohere", "command-r7b-12-2024", 700, 57.0, 0.24),
    ("cohere", "command-r-08-2024", 1400, 38.5, 0.25),
    ("cohere", "command-a-03-2025", 900, 51.5, 0.32),
    ("google_genai", "gemma-4-31b-it", 1300, 60.0, 0.5),
    ("huggingface_hub", "meta-llama/Meta-Llama-3.1-8B", 2000, 45.0, 0.6),
    ("huggingface_hub", "meta-llama/Meta-Llama-3.1-70B", 2400, 30.0, 0.9),
    ("huggingface_hub", "meta-llama/Meta-Llama-3.1-405B", 200, 18.0, 1.4),
]


def midpoint(value):
    """The middle of a range, or the value itself when it is not a range."""
    if hasattr(value, "min") and hasattr(value, "max"):
        return (value.min + value.max) / 2
    return float(value)


def bounds(value):
    """A range as two numbers, whatever the library hands over."""
    if hasattr(value, "min") and hasattr(value, "max"):
        return [float(value.min), float(value.max)]
    return [float(value), float(value)]


def main() -> int:
    installed = version("ecologits")
    if installed != PINNED_ECOLOGITS:
        print(
            f"ecologits {installed} is installed, the golden data was made with "
            f"{PINNED_ECOLOGITS}. Move the pin on purpose, or install that one.",
            file=sys.stderr,
        )
        return 1

    from ecologits.electricity_mix_repository import electricity_mixes
    from ecologits.impacts.llm import compute_llm_impacts
    from ecologits.model_repository import models
    from ecologits.tracers.utils import PROVIDER_CONFIG_MAP

    entries = []
    for provider, model, output_tokens, tps, ttft in PAIRS:
        found = models.find_model(provider=provider, model_name=model)
        if found is None:
            print(f"{provider}/{model} is not in the model repository", file=sys.stderr)
            return 1
        if found.architecture.type.value != "dense":
            print(f"{provider}/{model} is not dense, the golden needs a dense model", file=sys.stderr)
            return 1

        params = midpoint(found.architecture.parameters)
        config = PROVIDER_CONFIG_MAP[provider]
        zone = config.datacenter_location
        mix = electricity_mixes.find_electricity_mix(zone=zone)
        if mix is None:
            print(f"no electricity mix for {zone}", file=sys.stderr)
            return 1

        impacts = compute_llm_impacts(
            model_active_parameter_count=params,
            model_total_parameter_count=params,
            output_token_count=output_tokens,
            request_latency=None,
            if_electricity_mix_adpe=mix.adpe,
            if_electricity_mix_pe=mix.pe,
            if_electricity_mix_gwp=mix.gwp,
            if_electricity_mix_wue=mix.wue,
            datacenter_pue=config.datacenter_pue,
            datacenter_wue=config.datacenter_wue,
            tps=tps,
            ttft=ttft,
        )

        usage = impacts.usage
        entries.append(
            {
                "provider": provider,
                "model": model,
                "outputTokens": output_tokens,
                "tps": tps,
                "ttftS": ttft,
                "paramsB": params,
                "pue": bounds(config.datacenter_pue),
                "wueOnSite": bounds(config.datacenter_wue),
                "gridKgCo2PerKWh": mix.gwp,
                "gridWueLPerKWh": mix.wue,
                "energyKWh": midpoint(usage.energy.value),
                "co2Kg": midpoint(usage.gwp.value),
                "waterL": midpoint(usage.wcf.value),
            }
        )

    target = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "packages", "footprint", "data", "golden.json"
    )
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "generatedBy": "scripts/golden.py",
                "ecologitsVersion": installed,
                "note": "computed results, not EcoLogits data files; the model map is never bundled",
                "entries": entries,
            },
            handle,
            indent=2,
        )
        handle.write("\n")
    print(f"wrote {len(entries)} golden entries to {os.path.relpath(target)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
