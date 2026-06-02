"""Shared GPU detection so Maia3 prefers a GPU and falls back to CPU.

A single source of truth for "is a CUDA GPU actually usable here?". The Maia3
adapter (which picks a torch device) consults this, so the whole app makes the
same call.

Maia3 runs on torch in this interpreter, so torch — not ``nvidia-smi`` — is the
only authority that matters: a machine can have an NVIDIA GPU (``nvidia-smi``
present) while this interpreter's torch build cannot use it (CPU-only wheel, or
a driver/runtime/compute-capability mismatch). Trusting ``nvidia-smi`` in that
case hands Maia3 a ``cuda`` device it cannot load onto, which crashes Brilliant
detection. So we ask torch, and we verify with a real allocation.
"""
from __future__ import annotations

import functools


@functools.lru_cache(maxsize=1)
def has_cuda_gpu() -> bool:
    """True only when torch can *actually* allocate and compute on a CUDA GPU.

    ``torch.cuda.is_available()`` is necessary but not sufficient: it can report
    True on machines where the first real allocation still raises (broken driver/
    runtime pairing, or a GPU whose compute capability this torch build ships no
    kernels for). So we follow the capability check with a tiny real allocation;
    if anything raises, CUDA is not usable here and Maia3 must run on CPU.

    Because Maia3 requires torch, an interpreter without torch cannot run Maia3
    at all — there is no point reporting a GPU via ``nvidia-smi`` in that case.
    """
    try:
        import torch  # type: ignore
    except Exception:
        return False
    try:
        if not torch.cuda.is_available():
            return False
        probe = torch.zeros(1, device="cuda")
        # Force an actual kernel launch + device->host copy; a lazy tensor alone
        # would not surface a runtime/capability failure.
        _ = (probe + 1).sum().item()
        return True
    except Exception:
        return False


def preferred_maia_device() -> str:
    """Torch device string for Maia3: ``cuda`` when a GPU is usable, else ``cpu``."""
    return "cuda" if has_cuda_gpu() else "cpu"
